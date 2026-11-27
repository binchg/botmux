#!/usr/bin/env node
import type { Args, ActiveTurn, JsonObject } from './services/app-runner-types.js';
import { AppServerClient } from './services/app-runner-client.js';
import { resumeStoredAppThread } from './services/app-runner-thread-resume.js';
import { prefixCodexAppThreadTitle } from './services/codex-app-thread-title.js';
import { asError, parseArgs, b64Json, writeLine, prompt, appDeveloperInstructions } from './services/app-runner-protocol.js';
import { handleAppServerRequest, handleAppNotification } from './services/app-runner-events.js';
import { runSingleTurn, type SingleTurnContext } from './services/app-runner-turn.js';
import { runTurn as continueTurn } from './services/app-runner-continuation.js';
import { AppRunnerInput } from './services/app-runner-input.js';
import { SessionModelInput } from './services/session-model-input.js';
import { SessionModelTurnSwitch } from './services/session-model-turn-switch.js';
import { listCodexAppModels } from './services/codex-app-threads.js';
import { SharedBotContext } from './services/shared-bot-context.js';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { readTraexAdaptivePolicy, TraexAdaptiveRouter } from './services/traex-adaptive-model.js';
import { TraexAdmission } from './services/traex-admission.js';
import { runWithTraexFallback } from './services/traex-executor-fallback.js';
import { modelExecutorEnv, executorModels } from './services/model-executor.js';
import { readMixedPolicy, mixedModels } from './services/mixed-model-policy.js';
import { MixedModelRouter } from './services/mixed-model-router.js';
import { fetchTraexCatalog } from './services/traex-model-catalog.js';
import { readSessionModelDisplay, sessionModelDisplay, withSessionModelDisplay } from './services/session-model-display.js';
import { createAppRunnerSteering } from './services/app-runner-steering.js';
import { Buffer } from 'node:buffer';
import { config } from './config.js';
import { invalidateGlobalConfigCache, readGlobalConfig } from './global-config.js';
import { readSessionModel, readSessionModelRuntime, readSessionExecutor, writeSessionExecutor, writeSessionModelRuntime, rememberSuccessfulRoute, type SessionModelRequest } from './services/session-model-store.js';
import { switchAppExecutor } from './services/app-runner-executor-switch.js';
import { codexAppHookTrustIssue } from './services/codex-app-hook-health.js';
import { isAgentTeamMachineOutput } from './services/agent-team-output-filter.js';
import { readCodexAuthFileStamp, sameCodexAuthFileStamp } from './services/codex-auth-file.js';


const OSC_PREFIX = '\x1b]777;botmux:';
const OSC_END = '\x07';

function emitMarker(kind: string, payload: unknown): void {
  const message = payload as JsonObject;
  if (!message?.routingNotice && (activeExecutor === 'traex' || activeTurn?.modelRuntime?.mixed)
    && ['progress', 'final'].includes(kind) && !activeTurn?.structuredOutput) {
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
const mixedPolicy = readMixedPolicy();
const mixedRouter = mixedPolicy ? new MixedModelRouter(mixedPolicy, process.env.MIXED_MODEL_HEALTH_FILE ?? join(config.session.dataDir, 'mixed-models',
  createHash('sha256').update(args.botOpenId || args.botName || args.sessionId).digest('hex') + '.json')) : undefined;
let mixedEffects = false;
let mixedAttemptStarted = 0;
let mixedFirstTokenMs: number | undefined;
let admissionAbort: AbortController | undefined;
let requestAbort: AbortController | undefined;
const savedExecutor = readSessionExecutor(config.session.dataDir, args.sessionId);
let activeExecutor: 'codex-app' | 'traex' | 'ark' | 'gateway' = savedExecutor?.executor
  ?? (process.env.TRAEX_APP_SERVER_DEFAULT === '1' || !mixedPolicy && process.env.TRAEX_ADAPTIVE_MODELS ? 'traex' : 'codex-app');
let activeHookTrust = readGlobalConfig().hookTrust ?? savedExecutor?.hookTrust ?? readSessionModel(config.session.dataDir, args.sessionId)?.hookTrust ?? 'review';
let client = new AppServerClient(activeExecutor === 'traex' ? args.traexBin : args.codexBin, args.cwd, modelExecutorEnv(activeExecutor));
let clientAuthStamp = activeExecutor === 'codex-app' ? readCodexAuthFileStamp() : undefined;
let authReloadInFlight: Promise<void> | undefined;
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
let currentRequestContent = '';
let requestReconfigured = false;

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

const { queuePendingSteersAsNextTurns, flushSteers, handleUserMessage } = createAppRunnerSteering({
  dataDir: config.session.dataDir, sessionId: args.sessionId, enqueueNextTurn, sharedContextPrefix, emitMarker,
  get activeTurn() { return activeTurn; }, get activeExecutor() { return activeExecutor; },
  get threadId() { return threadId; }, get client() { return client; },
});

/** 通过 app-server 真正中断当前 turn；线程本身保留，可继续发新指令。 */
async function interruptActiveTurn(): Promise<void> {
  modelInput.cancel();
  modelSwitch.cancel();
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
  if (msg.params?.threadId === threadId && msg.method === 'item/started'
    && /commandExecution|fileChange|ToolCall/.test(msg.params?.item?.type ?? '')) mixedEffects = true;
  if (msg.params?.threadId === threadId && msg.method === 'item/completed'
    && msg.params?.item?.type === 'agentMessage' && msg.params?.item?.text) mixedEffects = true;
  if (msg.params?.threadId === threadId && /agentMessage\/delta/.test(msg.method)) {
    mixedEffects = true;
    mixedFirstTokenMs ??= Date.now() - mixedAttemptStarted;
  }
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
      const resumed = await resumeStoredAppThread((method, params) => client.request(method, params), threadId, {
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
            name: prefixCodexAppThreadTitle(args.title, args.botName),
          });
        } catch { /* 命名失败不阻塞会话恢复 */ }
      }
      return resumedThreadId;
    } catch (err: any) {
      // A database, ownership, provider, or transient error must never silently
      // discard the user's history. Keep the ID so a later input can retry.
      throw err;
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
      name: prefixCodexAppThreadTitle(args.title?.trim() || args.sessionId.slice(0, 8), args.botName),
    });
  } catch { /* naming is cosmetic */ }
  return startedThreadId;
}

function persistExecutor(): void {
  if (threadId) writeSessionExecutor(config.session.dataDir, { sessionId: args.sessionId,
    executor: activeExecutor, threadId, hookTrust: activeHookTrust, ...(pendingHandoff ? { handoff: pendingHandoff } : {}) });
}

/** 入口只提交已冻结的当前状态，切换事务由独立模块完成。 */
async function ensureExecutor(requested?: SessionModelRequest): Promise<void> {
  await switchAppExecutor({ args, dataDir: config.session.dataDir, requested,
    current: { client, executor: activeExecutor, hookTrust: activeHookTrust, threadId, handoff: pendingHandoff },
    instructions: () => appDeveloperInstructions(args, sharedContext?.instructions()),
    activate: state => {
      client = state.client; activeExecutor = state.executor; activeHookTrust = state.hookTrust;
      clientAuthStamp = activeExecutor === 'codex-app' ? readCodexAuthFileStamp() : undefined;
      threadId = state.threadId; threadReady = true; pendingHandoff = state.handoff;
      defaultThreadModel = state.defaults?.model; defaultThreadModelProvider = state.defaults?.model_provider;
      defaultThreadEffort = state.defaults?.model_reasoning_effort; defaultServiceTier = state.defaults?.service_tier;
      client.onRequest(handleServerRequest); client.onNotification(handleNotification);
      emitMarker('thread', { threadId });
      writeLine(`[botmux] executor=${activeExecutor}; 最近可见对话与 Hook 策略已保留。`);
    } });
}

const turnContext: SingleTurnContext = {
  args, adaptiveRouter, admission, ensureExecutor, currentHookTrustIssue, ensureThread, persistExecutor,
  mixedEnabled: !!mixedRouter, safeToDegrade: () => !mixedEffects,
  mixedModelName: (executor, model) => mixedPolicy?.routes.find(row => row.executor === executor && row.model === model)?.displayName,
  emitMarker, sharedContextPrefix, flushSteers, queuePendingSteersAsNextTurns,
  get client() { return client; }, get activeExecutor() { return activeExecutor; },
  get activeHookTrust() { return activeHookTrust; }, get threadId() { return threadId; },
  get defaultThreadModel() { return defaultThreadModel; }, get defaultThreadEffort() { return defaultThreadEffort; },
  get defaultServiceTier() { return defaultServiceTier; }, get requestAbort() { return requestAbort; },
  get activeTurn() { return activeTurn; }, set activeTurn(value) { activeTurn = value; },
  get admissionAbort() { return admissionAbort; }, set admissionAbort(value) { admissionAbort = value; },
  get pendingHandoff() { return pendingHandoff; }, set pendingHandoff(value) { pendingHandoff = value; },
};
async function runTurn(content: string): Promise<void> {
  await reloadCodexAuthIfChanged(true);
  return continueTurn(content, { args, emitMarker,
    recoverAuthClient,
    recoverUpdatedClient: async () => {
      const next = await client.openUpdated(modelExecutorEnv(activeExecutor));
      if (!next) return false;
      if (!await client.closeAndWait()) { next.close(); return false; }
      await replaceCodexAuthClient(next);
      return true;
    },
    runSingleTurn: (text, autoContinue, attempted, forced) => runSingleTurn(turnContext, text, autoContinue, attempted, forced) });
}

/**
 * refresh token 被其它长期进程轮换后，旧 app-server 只会继续使用内存中的
 * 失效凭据。关闭并恢复同一 thread，让新进程重新读取磁盘认证；不创建新线程。
 */
async function recoverAuthClient(): Promise<void> {
  if (authReloadInFlight) return authReloadInFlight;
  return replaceCodexAuthClient();
}

async function replaceCodexAuthClient(initialized?: AppServerClient): Promise<void> {
  if (activeExecutor !== 'codex-app') throw new Error('当前执行器不是 Codex');
  const stale = client;
  if (!initialized && !await stale.closeAndWait()) throw new Error('Previous Codex auth process did not exit');
  client = initialized ?? new AppServerClient(args.codexBin, args.cwd, modelExecutorEnv(activeExecutor));
  client.onRequest(handleServerRequest);
  client.onNotification(handleNotification);
  threadReady = false;
  if (!initialized) await client.initialize();
  await loadDefaultThreadModel();
  clientAuthStamp = readCodexAuthFileStamp();
}

/**
 * Load shared auth at the next turn boundary. Rotating one token must not
 * restart every idle session's app-server at once. Resume the existing thread.
 */
async function reloadCodexAuthIfChanged(turnBoundary = false): Promise<void> {
  if (activeExecutor !== 'codex-app' || activeTurn || !turnBoundary && processing) return;
  if (authReloadInFlight) return authReloadInFlight;
  const latest = readCodexAuthFileStamp();
  if (sameCodexAuthFileStamp(clientAuthStamp, latest)) return;
  authReloadInFlight = (async () => {
    await replaceCodexAuthClient();
    await ensureThread(defaultThreadModel);
    persistExecutor();
  })();
  try {
    await authReloadInFlight;
  } finally {
    authReloadInFlight = undefined;
  }
}

async function drainQueue(): Promise<void> {
  if (processing) return;
  processing = true;
  try {
    while (queue.length > 0) {
      const next = queue.shift()!;
      modelSwitch.started(next);
      currentRequestContent = next;
      requestReconfigured = false;
      requestAbort = new AbortController();
      mixedEffects = false;
      try {
        if (mixedRouter) await mixedRouter.run({ dataDir: config.session.dataDir, sessionId: args.sessionId,
          signal: requestAbort.signal, catalog: () => fetchTraexCatalog(args.traexBin, args.cwd),
          safe: () => !mixedEffects, metrics: () => ({ firstTokenMs: mixedFirstTokenMs }),
          completed: () => readSessionModelRuntime(config.session.dataDir, args.sessionId)?.phase === 'completed',
          run: async () => {
            mixedAttemptStarted = Date.now(); mixedFirstTokenMs = undefined;
            await runTurn(next);
          },
          notice: content => emitMarker('progress', { content, routingNotice: true, startedAtMs: Date.now(), updatedAtMs: Date.now() }) });
        else await runWithTraexFallback({ dataDir: config.session.dataDir, sessionId: args.sessionId,
          cwd: args.cwd, codexBin: args.codexBin, executor: () => activeExecutor, run: () => runTurn(next),
          signal: requestAbort.signal,
          notice: content => emitMarker('progress', { content, startedAtMs: Date.now(), updatedAtMs: Date.now() }) });
      } catch (err: any) {
        if (requestReconfigured) continue;
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
      } finally { requestAbort = undefined; requestReconfigured = false; }
      prompt();
    }
  } finally {
    processing = false;
  }
}

const modelNotice = (content: string, failed = false) => emitMarker(failed ? 'final' : 'progress', {
  content, startedAtMs: Date.now(), updatedAtMs: Date.now(), completedAtMs: failed ? Date.now() : undefined });
const modelSwitch = new SessionModelTurnSwitch({ active: () => activeTurn, processing: () => processing,
  currentContent: () => currentRequestContent, reconfiguring: value => { requestReconfigured = value; },
  abortAdmission: () => { requestAbort?.abort(); admissionAbort?.abort(); }, enqueue: enqueueNextTurn,
  removeQueued: content => { const index = queue.indexOf(content); if (index >= 0) queue.splice(index, 1); },
  interrupt: turn => client.request('turn/interrupt', { threadId, turnId: turn.turnId }), notice: modelNotice });
const modelInput = new SessionModelInput({ dataDir: config.session.dataDir, sessionId: args.sessionId,
  defaults: () => ({ executor: activeExecutor, model: defaultThreadModel ?? '', effort: defaultThreadEffort ?? 'xhigh', serviceTier: defaultServiceTier }),
  models: executor => mixedPolicy ? Promise.resolve(mixedModels(mixedPolicy)) : executorModels(executor, args.cwd, args.codexBin, process.env, args.traexBin),
  deliver: (content, changed) => changed ? modelSwitch.schedule(content) : handleUserMessage(content), notice: modelNotice });

async function main(): Promise<void> {
  if (mixedPolicy?.keepSessionRoute) rememberSuccessfulRoute(config.session.dataDir, args.sessionId);
  client.onRequest(handleServerRequest);
  client.onNotification(handleNotification);
  await client.initialize();
  await loadDefaultThreadModel();
  clientAuthStamp = activeExecutor === 'codex-app' ? readCodexAuthFileStamp() : undefined;
  if (admission && !mixedPolicy && activeExecutor === 'traex') {
    try { await admission.refresh(); defaultThreadModel = admission.choose() ?? defaultThreadModel; }
    catch { writeLine('[traex-adaptive] 模型目录暂不可用，将在收到请求后自动刷新。'); }
  }
  const hookTrustIssue = await currentHookTrustIssue();
  if (hookTrustIssue) writeLine(`[codex-app] ${hookTrustIssue}`);
  let startupError: unknown;
  try {
    await ensureThread(readSessionModelRuntime(config.session.dataDir, args.sessionId)?.selection?.model ?? defaultThreadModel);
    persistExecutor();
  } catch (error) {
    // Stay alive: exiting here lets worker crash recovery eventually start a
    // fresh CLI. Subsequent user input reports the failure and retries resume.
    startupError = error;
    writeLine(`[codex-app] ${asError(error).message}`);
  }
  writeSessionModelRuntime(config.session.dataDir, { sessionId: args.sessionId, pid: process.pid, threadId, phase: startupError ? 'failed' : 'ready',
    selection: defaultThreadModel && defaultThreadEffort ? { executor: activeExecutor, hookTrust: activeHookTrust, model: defaultThreadModel,
      effort: defaultThreadEffort, serviceTier: defaultServiceTier } : undefined });
  if (startupError) {
    writeLine(args.locale === 'zh'
      ? '原会话暂时无法恢复，已保留原绑定；修复后可重试，未创建替代会话。'
      : 'Stored conversation unavailable; original binding preserved. Retry after repair.');
  } else if (args.threadId) {
    writeLine(args.locale === 'zh'
      ? 'Codex App 已恢复原会话；终端仅显示恢复后的新输出。'
      : 'Codex App resumed the existing conversation; this terminal shows new output after recovery.');
  } else {
    writeLine('Codex App connected.');
  }
  if (process.stdin.isTTY) process.stdin.setRawMode(true);
  process.stdin.resume();
  const input = new AppRunnerInput(content => modelInput.receive(content), interruptActiveTurn);
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
