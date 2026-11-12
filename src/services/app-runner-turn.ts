import { config } from '../config.js';
import type { AppServerClient } from './app-runner-client.js';
import type { ActiveTurn, Args, TurnOutcome } from './app-runner-types.js';
import { asError, displayUserContent, makeTurn, userTextInput, writeLine } from './app-runner-protocol.js';
import { readSessionModel, readSessionModelRuntime, writeSessionModelRuntime, type ModelSelection, type SessionModelRequest, type SessionModelRuntime } from './session-model-store.js';
import { readSessionModelDisplay } from './session-model-display.js';
import { TraexAdaptiveRouter, TraexQueueReader } from './traex-adaptive-model.js';
import type { TraexAdmission } from './traex-admission.js';
import { agentTeamOutputSchema } from './agent-team-result-schema.js';

/** 单轮执行所需状态；可变字段通过入口的访问器读取，避免切换后使用旧进程。 */
export interface SingleTurnContext {
  args: Args;
  client: AppServerClient;
  activeExecutor: 'traex' | 'codex-app';
  activeHookTrust: 'always' | 'review';
  threadId?: string;
  defaultThreadModel?: string;
  defaultThreadEffort?: string;
  defaultServiceTier?: string;
  activeTurn: ActiveTurn | null;
  requestAbort?: AbortController;
  admissionAbort?: AbortController;
  pendingHandoff: string;
  adaptiveRouter?: TraexAdaptiveRouter;
  admission?: TraexAdmission;
  ensureExecutor: (requested?: SessionModelRequest) => Promise<void>;
  currentHookTrustIssue: () => Promise<string | undefined>;
  ensureThread: (model?: string) => Promise<string>;
  persistExecutor: () => void;
  emitMarker: (kind: string, payload: unknown) => void;
  sharedContextPrefix: () => string;
  flushSteers: (turn: ActiveTurn) => void;
  queuePendingSteersAsNextTurns: (turn: ActiveTurn) => void;
}

/** 执行一次请求并返回排队或限流结果；工具和取消的边界保持在本轮内部。 */
export async function runSingleTurn(context: SingleTurnContext, content: string, autoContinue: boolean, attempted = new Set<string>(), forcedModel?: string): Promise<TurnOutcome> {
  const { args, adaptiveRouter, admission, ensureExecutor, currentHookTrustIssue, ensureThread, persistExecutor,
    emitMarker, sharedContextPrefix, flushSteers, queuePendingSteersAsNextTurns } = context;
  // 当前轮冻结期望配置；切换只发生在两个 turn 之间。
  const requested = readSessionModel(config.session.dataDir, args.sessionId);
  try { await ensureExecutor(requested); } catch (error) {
    writeSessionModelRuntime(config.session.dataDir, { sessionId: args.sessionId, pid: process.pid,
      threadId: context.threadId, phase: 'failed', revision: requested?.revision,
      selection: readSessionModelRuntime(config.session.dataDir, args.sessionId)?.selection });
    throw error;
  }
  context.requestAbort?.signal.throwIfAborted();
  const hookTrustIssue = await currentHookTrustIssue();
  if (hookTrustIssue) throw new Error(hookTrustIssue);
  const { client, activeExecutor, activeHookTrust, defaultThreadModel, defaultThreadEffort, defaultServiceTier } = context;
  const adaptive = activeExecutor === 'traex' ? adaptiveRouter : undefined;
  let selectedModel = requested?.model ?? defaultThreadModel;
  if (adaptive && admission) {
    const pendingReceipt = (state: 'selecting' | 'waiting') => writeSessionModelRuntime(config.session.dataDir, {
      sessionId: args.sessionId, pid: process.pid, threadId: context.threadId, phase: 'ready', revision: requested?.revision,
      routing: { executor: 'traex', state, effort: requested?.effort ?? 'xhigh' },
    });
    pendingReceipt('selecting');
    context.admissionAbort = new AbortController();
    try {
      selectedModel = await admission.select(attempted, context.admissionAbort.signal, message => {
        pendingReceipt('waiting');
        writeLine(`[traex-adaptive] ${message}`);
        emitMarker('progress', { content: message, startedAtMs: Date.now(), updatedAtMs: Date.now() });
      }, requested?.effort ?? 'xhigh');
    } finally { context.admissionAbort = undefined; }
  }
  const tid = await ensureThread(selectedModel);
  context.requestAbort?.signal.throwIfAborted();
  persistExecutor();
  const selection = { model: selectedModel, effort: requested?.effort ?? (adaptive ? 'xhigh' : defaultThreadEffort),
    serviceTier: requested?.serviceTier ?? defaultServiceTier };
  const loadPercent = adaptive ? admission?.catalog.find(model => model.model === selectedModel)?.loadPercent : undefined;
  const selectedRuntime: SessionModelRuntime = {
    sessionId: args.sessionId, pid: process.pid, threadId: tid, phase: 'running', revision: requested?.revision,
    protocol: 4, updatedAt: new Date().toISOString(),
    selection: selection.model && selection.effort ? { ...selection, executor: activeExecutor, hookTrust: activeHookTrust } as ModelSelection : undefined,
    ...(activeExecutor === 'traex' ? { routing: { executor: 'traex' as const, state: 'requested' as const,
      effort: selection.effort ?? 'xhigh', loadPercent } } : {}),
  };
  const modelReceipt = (phase: 'running' | 'completed' | 'failed', turnId?: string,
    state?: 'requested' | 'queued', position?: number) => {
    turn.modelRuntime = { ...selectedRuntime, phase, turnId,
      ...(selectedRuntime.routing ? { routing: { ...selectedRuntime.routing, state, position } } : {}) };
    writeSessionModelRuntime(config.session.dataDir, turn.modelRuntime);
  };
  const outputSchema = agentTeamOutputSchema(content);
  const turn = makeTurn(!!outputSchema);
  turn.modelRuntime = selectedRuntime;
  context.activeTurn = turn;
  let queueReader: TraexQueueReader | undefined;
  let queueTimer: ReturnType<typeof setInterval> | undefined;
  if (adaptive && selection.model && client.pid) {
    attempted.add(selection.model);
    try { queueReader = new TraexQueueReader(tid, client.pid); }
    catch (error) { writeLine(`[traex-adaptive] queue observation unavailable: ${asError(error).message}`); }
    const check = async () => {
      if (!queueReader || context.activeTurn !== turn || !turn.turnId || turn.finished || turn.userInterrupted || turn.criticalHookFailure || turn.adaptiveChecking || turn.adaptiveNextModel || turn.toolItems?.size) return;
      const activityAt = turn.adaptiveActivityAt ?? turn.startedAtMs;
      let evidence;
      try { evidence = queueReader.poll(activityAt); } catch { return; }
      if (!evidence) return;
      turn.adaptiveChecking = true;
      modelReceipt('running', turn.turnId, 'queued', evidence.position);
      try {
        await adaptive.queued(selection.model!);
        try { await admission!.refresh(); } catch { admission!.catalog = []; }
        const next = admission!.choose(attempted, selection.effort);
        if (context.activeTurn !== turn || turn.finished || turn.userInterrupted || (turn.adaptiveActivityAt ?? turn.startedAtMs) > activityAt) return;
        const queueNotice = next
          ? `TraeX ${selection.model} 正在排队${evidence.position === undefined ? '' : `（第 ${evidence.position} 位）`}，切换到 ${next} 并沿原线程继续。`
          : `TraeX ${selection.model} 正在排队，暂时没有空闲候选，退出排队后自动刷新重选。`;
        const notice = queueNotice + (evidence.quotaLowPriority ? ' 上游将本请求标为额度低优先级；目录负载低不代表本账号能立即执行。' : '');
        writeLine(`[traex-adaptive] ${notice}`);
        emitMarker('progress', { content: notice, turnId: turn.turnId, startedAtMs: turn.startedAtMs, updatedAtMs: Date.now() });
        turn.adaptiveNextModel = next ?? 'reselect';
        try { await client.request('turn/interrupt', { threadId: tid, turnId: turn.turnId }); }
        catch (error) { turn.adaptiveNextModel = undefined; throw error; }
      } catch (error) { writeLine(`[traex-adaptive] ${asError(error).message}`); }
      finally { turn.adaptiveChecking = false; }
    };
    turn.adaptiveCheck = () => { void check(); };
    queueTimer = setInterval(turn.adaptiveCheck, 1000); queueTimer.unref();
  }
  try {
    writeLine();
    writeLine(autoContinue ? '[auto continue]' : '[user]');
    writeLine(content);
    if (!autoContinue) {
      emitMarker('user', {
        kind: 'user',
        content: displayUserContent(content),
        at: turn.startedAtMs,
        turnId: turn.turnId,
      });
    }
    writeLine();

    const result = await client.request('turn/start', {
      threadId: tid,
      input: userTextInput(sharedContextPrefix() + context.pendingHandoff + content),
      cwd: args.cwd,
      approvalPolicy: 'never',
      sandboxPolicy: { type: 'dangerFullAccess' },
      ...selection,
      ...(outputSchema ? { outputSchema } : {}),
    });
    turn.turnId = result.turn?.id ?? turn.turnId;
    context.pendingHandoff = ''; persistExecutor();
    modelReceipt('running', turn.turnId, turn.adaptiveActivityAt ? undefined : 'requested');
    if (activeExecutor === 'traex' && !turn.structuredOutput) {
      const notice = readSessionModelDisplay(config.session.dataDir, args.sessionId)?.label;
      if (notice) {
        writeLine(`[模型] ${notice}`);
        emitMarker('progress', { content: '已选定模型并发送请求，等待上游准入；如实际入队会自动重选。',
          turnId: turn.turnId, startedAtMs: turn.startedAtMs, updatedAtMs: Date.now(), complete: true });
      }
    }
    flushSteers(turn);
    await turn.done;
    await turn.steerChain;
    queuePendingSteersAsNextTurns(turn);

    if (turn.quotaExhaustedError && adaptive && selection.model && !turn.userInterrupted && !turn.criticalHookFailure) {
      await adaptive.quotaExhausted(selection.model);
      try { await admission!.refresh(); } catch { admission!.catalog = []; }
      const next = admission!.choose(attempted, selection.effort);
      const notice = next
        ? `TraeX ${selection.model} 的当日额度已耗尽，切换到 ${next} 并沿原线程继续。`
        : `TraeX ${selection.model} 的当日额度已耗尽，暂时没有可准入候选，自动刷新后重选。`;
      writeLine(`[traex-adaptive] ${notice}`);
      emitMarker('progress', { content: notice, turnId: turn.turnId, startedAtMs: turn.startedAtMs, updatedAtMs: Date.now() });
      turn.adaptiveNextModel = next ?? 'reselect';
    }

    modelReceipt(turn.turnFailed || turn.rateLimitError || turn.quotaExhaustedError || turn.criticalHookFailure ? 'failed' : 'completed', turn.turnId);

    const finalText = (turn.finalText || turn.allAgentText).trim();
    const completedAtMs = Date.now();
    if (!turn.rateLimitError && !turn.adaptiveNextModel && finalText) {
      emitMarker('final', {
        turnId: turn.turnId ?? `codex-app-${completedAtMs}`,
        content: finalText,
        startedAtMs: turn.startedAtMs,
        completedAtMs,
      });
    }
    writeLine();
    return {
      turnId: turn.turnId,
      startedAtMs: turn.startedAtMs,
      rateLimitError: turn.rateLimitError,
      adaptiveNextModel: turn.userInterrupted ? undefined : turn.adaptiveNextModel,
    };
  } catch (error) {
    modelReceipt('failed', turn.turnId);
    throw error;
  } finally {
    turn.adaptiveCheck = undefined;
    if (queueTimer) clearInterval(queueTimer);
    queueReader?.close();
    queuePendingSteersAsNextTurns(turn);
    if (context.activeTurn === turn) context.activeTurn = null;
  }
}
