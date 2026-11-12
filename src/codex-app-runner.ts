#!/usr/bin/env node
import type { Args, ActiveTurn, JsonObject } from './services/app-runner-types.js';
import { AppServerClient } from './services/app-runner-client.js';
import { asError, parseArgs, b64Json, writeLine, displayUserContent, prompt, appDeveloperInstructions, userTextInput } from './services/app-runner-protocol.js';
import { handleAppServerRequest, handleAppNotification } from './services/app-runner-events.js';
import { runSingleTurn, type SingleTurnContext } from './services/app-runner-turn.js';
import { runTurn as continueTurn } from './services/app-runner-continuation.js';
import { AppRunnerInput } from './services/app-runner-input.js';
import { SharedBotContext } from './services/shared-bot-context.js';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { readTraexAdaptivePolicy, TraexAdaptiveRouter } from './services/traex-adaptive-model.js';
import { TraexAdmission } from './services/traex-admission.js';
import { runWithTraexFallback } from './services/traex-executor-fallback.js';
import { fetchTraexCatalog } from './services/traex-model-catalog.js';
import { readSessionModelDisplay, sessionModelDisplay, withSessionModelDisplay } from './services/session-model-display.js';
import { beginSessionModelReplyEpoch } from './services/session-model-reply-budget.js';
import { Buffer } from 'node:buffer';
import { config } from './config.js';
import { invalidateGlobalConfigCache, readGlobalConfig } from './global-config.js';
import { readSessionModel, readSessionModelRuntime, readSessionExecutor, writeSessionExecutor, writeSessionModelRuntime, type SessionModelRequest } from './services/session-model-store.js';
import { executorHandoff } from './services/session-executor-handoff.js';
import { codexAppHookTrustIssue } from './services/codex-app-hook-health.js';
import { isAgentTeamMachineOutput } from './services/agent-team-output-filter.js';


const OSC_PREFIX = '\x1b]777;botmux:';
const OSC_END = '\x07';

function emitMarker(kind: string, payload: unknown): void {
  if (activeExecutor === 'traex' && ['progress', 'final'].includes(kind) && !activeTurn?.structuredOutput) {
    const message = payload as JsonObject;
    if (typeof message.content === 'string') payload = { ...message,
      content: withSessionModelDisplay(message.content, activeTurn?.modelRuntime
        ? sessionModelDisplay(activeTurn.modelRuntime) : readSessionModelDisplay(config.session.dataDir, args.sessionId)) };
  }
  process.stdout.write(`${OSC_PREFIX}${kind}:${b64Json(payload)}${OSC_END}`);
}

let args: Args;
try {
  args = parseArgs(process.argv.slice(2));
} catch (err: any) {
  console.error(err?.message ?? err);
  process.exit(2);
}

const sharedContext = process.env.BOT_SHARED_CONTEXT_GROUP ? new SharedBotContext(config.session.dataDir, args.sessionId,
  process.env.BOT_SHARED_CONTEXT_GROUP, process.env.BOT_SHARED_MEMORY_DIR) : undefined;
function sharedContextPrefix(): string {
  try { return sharedContext?.snapshot() ?? ''; }
  catch (error) { writeLine(`[shared-context] unavailable: ${asError(error).message}`); return ''; }
}
const adaptivePolicy = readTraexAdaptivePolicy(process.env, true);
const adaptiveRouter = adaptivePolicy ? new TraexAdaptiveRouter(adaptivePolicy, join(config.session.dataDir, 'traex-adaptive',
  createHash('sha256').update(args.botOpenId || args.botName || args.sessionId).digest('hex') + '.json')) : undefined;
const admission = adaptiveRouter ? new TraexAdmission(adaptiveRouter, () => fetchTraexCatalog(args.traexBin, args.cwd)) : undefined;
let admissionAbort: AbortController | undefined;
let requestAbort: AbortController | undefined;
const savedExecutor = readSessionExecutor(config.session.dataDir, args.sessionId);
let activeExecutor: 'codex-app' | 'traex' = savedExecutor?.executor
  ?? (process.env.TRAEX_APP_SERVER_DEFAULT === '1' || process.env.TRAEX_ADAPTIVE_MODELS ? 'traex' : 'codex-app');
let activeHookTrust = readGlobalConfig().hookTrust ?? savedExecutor?.hookTrust ?? readSessionModel(config.session.dataDir, args.sessionId)?.hookTrust ?? 'review';
let client = new AppServerClient(activeExecutor === 'traex' ? args.traexBin : args.codexBin, args.cwd);
let threadId = savedExecutor?.threadId ?? args.threadId;
let pendingHandoff = savedExecutor?.handoff ?? '';
let threadReady = false;
let defaultThreadModel: string | undefined;
let defaultThreadModelProvider: string | undefined;
let defaultThreadEffort: string | undefined;
let defaultServiceTier: string | undefined;
let activeTurn: ActiveTurn | null = null;
const queue: string[] = [];
let processing = false;

/** 每条完整 assistant 消息只投递一次，避免流式分句刷屏和最终答案提前泄露。 */
function emitCompletedAssistantMessage(turn: ActiveTurn, itemId: string, content: string): void {
  const text = content.trim();
  if (!text || turn.emittedProgressItemIds.has(itemId) || isAgentTeamMachineOutput(text)) return;
  turn.emittedProgressItemIds.add(itemId);
  emitMarker('progress', {
    content: text,
    turnId: turn.turnId,
    startedAtMs: turn.startedAtMs,
    updatedAtMs: Date.now(),
    complete: true,
  });
}

function enqueueNextTurn(content: string): void {
  queue.push(content);
  void drainQueue();
}

function queuePendingSteersAsNextTurns(turn: ActiveTurn): void {
  const pending = turn.pendingSteers.splice(0);
  for (const content of pending) enqueueNextTurn(content);
}

function flushSteers(turn: ActiveTurn): void {
  turn.steerChain = turn.steerChain.then(async () => {
    if (activeTurn !== turn) {
      queuePendingSteersAsNextTurns(turn);
      return;
    }
    if (!threadId || !turn.turnId) return;

    while (turn.pendingSteers.length > 0) {
      if (activeTurn !== turn) {
        queuePendingSteersAsNextTurns(turn);
        return;
      }
      const expectedTurnId = turn.turnId;
      if (!threadId || !expectedTurnId) return;

      const content = turn.pendingSteers.shift()!;
      try {
        const result = await client.request('turn/steer', {
          threadId,
          input: userTextInput(sharedContextPrefix() + content),
          expectedTurnId,
        });
        if (result?.turnId) turn.turnId = String(result.turnId);
        writeLine();
        writeLine('[user guidance]');
        writeLine(content);
        emitMarker('user', {
          kind: 'guidance',
          content: displayUserContent(content),
          at: Date.now(),
          turnId: turn.turnId ?? expectedTurnId,
        });
        if (activeExecutor === 'traex' && !turn.structuredOutput) emitMarker('progress', {
          content: '已接收追问，沿当前线程继续；如实际排队会自动重选模型。',
          turnId: turn.turnId, startedAtMs: turn.startedAtMs, updatedAtMs: Date.now(), complete: true,
        });
        writeLine();
      } catch (err: any) {
        writeLine(`[codex-app] steer failed, queued as next turn: ${err?.message ?? err}`);
        enqueueNextTurn(content);
        queuePendingSteersAsNextTurns(turn);
        return;
      }
    }
  }).catch((err: any) => {
    writeLine(`[codex-app] steer flush failed: ${err?.message ?? err}`);
    queuePendingSteersAsNextTurns(turn);
  });
}

function handleUserMessage(content: string): void {
  if (!activeTurn) {
    enqueueNextTurn(content);
    return;
  }
  // 用户可能在 final_answer 已生成、turn/completed 尚未到达时继续追问。
  // 清除上一答案的终态闩锁，确保新阶段消息继续进入飞书进度卡，最终回包也采用新答案。
  beginSessionModelReplyEpoch(config.session.dataDir, args.sessionId);
  activeTurn.adaptiveCheck?.();
  activeTurn.guidanceEpoch += 1;
  activeTurn.finalText = '';
  activeTurn.finalItemId = undefined;
  activeTurn.allAgentText = '';
  // A busy follow-up is a new visible progress epoch even though app-server
  // keeps it inside the same turn/steer lifecycle. Do not let the previous
  // assistant text cursor suppress commentary produced for this guidance.
  activeTurn.pendingSteers.push(content);
  flushSteers(activeTurn);
}

/** 通过 app-server 真正中断当前 turn；线程本身保留，可继续发新指令。 */
async function interruptActiveTurn(): Promise<void> {
  requestAbort?.abort();
  if (requestAbort && !activeTurn) {
    admissionAbort?.abort();
    emitMarker('interrupt_ack', { acknowledged: true, at: Date.now() });
    return;
  }
  const turn = activeTurn;
  if (!threadId || !turn?.turnId) {
    writeLine('[codex-app] no active turn to interrupt');
    emitMarker('interrupt_ack', { acknowledged: false, error: 'no_active_turn', at: Date.now() });
    return;
  }
  turn.userInterrupted = true;
  turn.adaptiveNextModel = undefined;
  try {
    await client.request('turn/interrupt', { threadId, turnId: turn.turnId });
    writeLine(`[codex-app] interrupted turn ${turn.turnId}`);
    emitMarker('interrupt_ack', { acknowledged: true, turnId: turn.turnId, at: Date.now() });
  } catch (err: any) {
    writeLine(`[codex-app] interrupt failed: ${err?.message ?? err}`);
    emitMarker('interrupt_ack', {
      acknowledged: false,
      turnId: turn.turnId,
      error: String(err?.message ?? err),
      at: Date.now(),
    });
  }
}

function handleServerRequest(msg: JsonObject): boolean { return handleAppServerRequest(msg, client); }
function handleNotification(msg: JsonObject): void {
  handleAppNotification(msg, { activeTurn, threadId, activeExecutor, client, flushSteers, emitMarker, emitCompletedAssistantMessage });
}

async function currentHookTrustIssue(): Promise<string | undefined> {
  // 仅用户显式授权的会话启用 always；Hooks 保持启用，底层线程接收同一信任策略。
  if (activeHookTrust === 'always') return undefined;
  try {
    const response = await client.request('hooks/list', { cwds: [args.cwd] });
    return codexAppHookTrustIssue(response, args.cwd);
  } catch (err: any) {
    if (process.env.BOTMUX_CODEX_APP_DEBUG === '1') {
      writeLine(`[codex-app] hook health check unavailable: ${err?.message ?? err}`);
    }
    return undefined;
  }
}

/** 读取当前 Codex 有效配置，确保恢复旧线程时同步迁移到现行模型提供方。 */
async function loadDefaultThreadModel(): Promise<void> {
  try {
    const response = await client.request('config/read', { cwd: args.cwd });
    const config = response?.config ?? {};
    defaultThreadModel = typeof config.model === 'string' && config.model.trim()
      ? config.model.trim()
      : activeExecutor === 'traex' ? adaptivePolicy?.models[0] : undefined;
    defaultThreadModelProvider = typeof config.model_provider === 'string' && config.model_provider.trim()
      ? config.model_provider.trim()
      : undefined;
    defaultThreadEffort = activeExecutor === 'traex' && adaptivePolicy ? 'xhigh' : config.model_reasoning_effort;
    defaultServiceTier = config.service_tier ?? (activeExecutor === 'traex' ? 'default' : undefined);
  } catch (err: any) {
    if (process.env.BOTMUX_CODEX_APP_DEBUG === '1') {
      writeLine(`[codex-app] default model config unavailable: ${err?.message ?? err}`);
    }
  }
}

async function ensureThread(model = defaultThreadModel): Promise<string> {
  if (threadReady && threadId) return threadId;

  if (threadId) {
    try {
      const resumed = await client.request('thread/resume', {
        threadId,
        cwd: args.cwd,
        model,
        modelProvider: defaultThreadModelProvider,
        approvalPolicy: 'never',
        sandbox: 'danger-full-access',
        config: { shell_environment_policy: { inherit: 'all' }, bypass_hook_trust: activeHookTrust === 'always' },
        developerInstructions: appDeveloperInstructions(args, sharedContext?.instructions()),
        excludeTurns: true,
        // Keep Codex App's rich history in sync with turns created by this
        // external runner so the desktop UI can render follow-up messages.
        persistExtendedHistory: true,
      });
      const resumedThreadId = String(resumed.thread.id);
      threadId = resumedThreadId;
      threadReady = true;
      emitMarker('thread', { threadId: resumedThreadId });
      // 恢复旧 Botmux 会话时同步迁移为本地生成的可读标题，不写入对话上下文。
      if (args.title?.trim()) {
        try {
          await client.request('thread/name/set', {
            threadId: resumedThreadId,
            name: args.title.trim(),
          });
        } catch { /* 命名失败不阻塞会话恢复 */ }
      }
      return resumedThreadId;
    } catch (err: any) {
      writeLine(`[codex-app] resume failed, starting a fresh thread: ${err?.message ?? err}`);
      threadId = undefined;
      threadReady = false;
    }
  }

  const started = await client.request('thread/start', {
    cwd: args.cwd,
    model,
    modelProvider: defaultThreadModelProvider,
    approvalPolicy: 'never',
    sandbox: 'danger-full-access',
    config: { shell_environment_policy: { inherit: 'all' }, bypass_hook_trust: activeHookTrust === 'always' },
    serviceName: 'botmux',
    developerInstructions: appDeveloperInstructions(args, sharedContext?.instructions()),
    ephemeral: false,
    experimentalRawEvents: false,
    // Keep Codex App's rich history in sync with turns created by this
    // external runner so the desktop UI can render follow-up messages.
    persistExtendedHistory: true,
  });
  const startedThreadId = String(started.thread.id);
  threadId = startedThreadId;
  threadReady = true;
  emitMarker('thread', { threadId: startedThreadId });
  try {
    await client.request('thread/name/set', {
      threadId: startedThreadId,
      name: args.title?.trim() || `botmux ${args.sessionId.slice(0, 8)}`,
    });
  } catch { /* naming is cosmetic */ }
  return startedThreadId;
}

function persistExecutor(): void {
  if (threadId) writeSessionExecutor(config.session.dataDir, { sessionId: args.sessionId,
    executor: activeExecutor, threadId, hookTrust: activeHookTrust, ...(pendingHandoff ? { handoff: pendingHandoff } : {}) });
}

/** 目标初始化成功后才替换旧进程；失败保留原线程，不把下一轮错误路由到旧执行器。 */
async function ensureExecutor(requested?: SessionModelRequest): Promise<void> {
  const target = requested?.executor ?? activeExecutor;
  invalidateGlobalConfigCache(); // A persisted global decision applies even to the immediately following turn.
  const hookTrust = readGlobalConfig().hookTrust ?? requested?.hookTrust ?? activeHookTrust;
  if (target === activeExecutor && hookTrust === activeHookTrust) return;
  const changingExecutor = target !== activeExecutor;
  const bounded = async <T,>(promise: Promise<T>): Promise<T> => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try { return await Promise.race([promise, new Promise<T>((_, reject) => {
      timer = setTimeout(() => reject(new Error('executor_switch_timeout')), 15000);
    })]); } finally { if (timer) clearTimeout(timer); }
  };
  const previous = changingExecutor ? await bounded(client.request('thread/read', { threadId, includeTurns: true })) : undefined;
  const handoff = changingExecutor ? executorHandoff(previous?.thread) : pendingHandoff;
  const candidate = new AppServerClient(target === 'traex' ? args.traexBin : args.codexBin, args.cwd);
  try {
    await bounded(candidate.initialize());
    const response = await bounded(candidate.request('config/read', { cwd: args.cwd }));
    const defaults = response?.config ?? {};
    const started = await bounded(candidate.request(changingExecutor ? 'thread/start' : 'thread/resume', {
      ...(!changingExecutor ? { threadId } : {}),
      cwd: args.cwd, model: requested!.model, modelProvider: defaults.model_provider,
      approvalPolicy: 'never', sandbox: 'danger-full-access',
      config: { shell_environment_policy: { inherit: 'all' }, bypass_hook_trust: hookTrust === 'always' },
      serviceTier: requested?.serviceTier ?? 'default',
      developerInstructions: appDeveloperInstructions(args, sharedContext?.instructions()), ephemeral: false,
    }));
    if (!started.thread?.id || (started.model && started.model !== requested!.model)) throw new Error('executor_model_mismatch');
    // 先持久保存，崩溃恢复时依然找到目标线程和待迁移的可见上下文。
    writeSessionExecutor(config.session.dataDir, { sessionId: args.sessionId, executor: target,
      threadId: String(started.thread.id), handoff, hookTrust });
    const previousClient = client;
    client = candidate; activeExecutor = target; activeHookTrust = hookTrust; threadId = String(started.thread.id);
    threadReady = true; pendingHandoff = handoff;
    defaultThreadModel = defaults.model; defaultThreadModelProvider = defaults.model_provider;
    defaultThreadEffort = defaults.model_reasoning_effort; defaultServiceTier = defaults.service_tier;
    client.onRequest(handleServerRequest); client.onNotification(handleNotification);
    previousClient.close();
    emitMarker('thread', { threadId });
    writeLine(changingExecutor ? `[botmux] executor=${target}; 最近可见对话已准备迁移，底层线程已切换。` : `[botmux] hooks=${hookTrust}; 原线程已恢复。`);
  } catch (error) { candidate.close(); throw error; }
}

const turnContext: SingleTurnContext = {
  args, adaptiveRouter, admission, ensureExecutor, currentHookTrustIssue, ensureThread, persistExecutor,
  emitMarker, sharedContextPrefix, flushSteers, queuePendingSteersAsNextTurns,
  get client() { return client; }, get activeExecutor() { return activeExecutor; },
  get activeHookTrust() { return activeHookTrust; }, get threadId() { return threadId; },
  get defaultThreadModel() { return defaultThreadModel; }, get defaultThreadEffort() { return defaultThreadEffort; },
  get defaultServiceTier() { return defaultServiceTier; }, get requestAbort() { return requestAbort; },
  get activeTurn() { return activeTurn; }, set activeTurn(value) { activeTurn = value; },
  get admissionAbort() { return admissionAbort; }, set admissionAbort(value) { admissionAbort = value; },
  get pendingHandoff() { return pendingHandoff; }, set pendingHandoff(value) { pendingHandoff = value; },
};
function runTurn(content: string): Promise<void> {
  return continueTurn(content, { args, emitMarker,
    runSingleTurn: (text, autoContinue, attempted, forced) => runSingleTurn(turnContext, text, autoContinue, attempted, forced) });
}

async function drainQueue(): Promise<void> {
  if (processing) return;
  processing = true;
  try {
    while (queue.length > 0) {
      const next = queue.shift()!;
      requestAbort = new AbortController();
      try {
        await runWithTraexFallback({ dataDir: config.session.dataDir, sessionId: args.sessionId,
          cwd: args.cwd, codexBin: args.codexBin, executor: () => activeExecutor, run: () => runTurn(next),
          signal: requestAbort.signal,
          notice: content => emitMarker('progress', { content, startedAtMs: Date.now(), updatedAtMs: Date.now() }) });
      } catch (err: any) {
        const requested = readSessionModel(config.session.dataDir, args.sessionId);
        const runtime = readSessionModelRuntime(config.session.dataDir, args.sessionId);
        if (runtime?.phase !== 'failed' || runtime.revision !== requested?.revision) {
          writeSessionModelRuntime(config.session.dataDir, { sessionId: args.sessionId, pid: process.pid,
            threadId, phase: 'failed', revision: requested?.revision,
            selection: runtime?.selection ? { ...runtime.selection, executor: activeExecutor } : undefined });
        }
        const message = err?.name === 'AbortError' ? 'TraeX 选模等待已取消。' : `Codex App runner error: ${err?.message ?? err}`;
        writeLine(message);
        emitMarker('final', {
          turnId: `codex-app-error-${Date.now()}`,
          content: message,
          startedAtMs: Date.now(),
          completedAtMs: Date.now(),
        });
      } finally { requestAbort = undefined; }
      prompt();
    }
  } finally {
    processing = false;
  }
}

async function main(): Promise<void> {
  client.onRequest(handleServerRequest);
  client.onNotification(handleNotification);
  await client.initialize();
  await loadDefaultThreadModel();
  if (admission && activeExecutor === 'traex') {
    try { await admission.refresh(); defaultThreadModel = admission.choose() ?? defaultThreadModel; }
    catch { writeLine('[traex-adaptive] 模型目录暂不可用，将在收到请求后自动刷新。'); }
  }
  const hookTrustIssue = await currentHookTrustIssue();
  if (hookTrustIssue) writeLine(`[codex-app] ${hookTrustIssue}`);
  await ensureThread(readSessionModelRuntime(config.session.dataDir, args.sessionId)?.selection?.model ?? defaultThreadModel);
  persistExecutor();
  writeSessionModelRuntime(config.session.dataDir, { sessionId: args.sessionId, pid: process.pid, threadId, phase: 'ready',
    selection: defaultThreadModel && defaultThreadEffort ? { executor: activeExecutor, hookTrust: activeHookTrust, model: defaultThreadModel,
      effort: defaultThreadEffort, serviceTier: defaultServiceTier } : undefined });
  if (args.threadId) {
    writeLine(args.locale === 'zh'
      ? 'Codex App 已恢复原会话；终端仅显示恢复后的新输出。'
      : 'Codex App resumed the existing conversation; this terminal shows new output after recovery.');
  } else {
    writeLine('Codex App connected.');
  }
  if (process.stdin.isTTY) process.stdin.setRawMode(true);
  process.stdin.resume();
  const input = new AppRunnerInput(handleUserMessage, interruptActiveTurn);
  process.stdin.on('data', data => input.handleInput(data));
  prompt();
}

process.on('SIGTERM', () => {
  client.close();
  process.exit(0);
});

process.on('SIGINT', () => {
  client.close();
  process.exit(130);
});

main().catch(err => {
  console.error(err?.stack ?? err?.message ?? err);
  process.exit(1);
});
