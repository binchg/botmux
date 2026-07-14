#!/usr/bin/env node
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { Buffer } from 'node:buffer';
import { CodexAppProgressThrottler } from './services/codex-app-progress.js';
import { normalizeCodexAppTimestampMs } from './services/codex-app-activity.js';
import { codexAppHookFailure, codexAppHookTrustIssue } from './services/codex-app-hook-health.js';

type JsonObject = Record<string, any>;

interface Args {
  sessionId: string;
  codexBin: string;
  cwd: string;
  threadId?: string;
  botName?: string;
  botOpenId?: string;
  locale?: string;
}

interface PendingRequest {
  resolve: (value: any) => void;
  reject: (error: Error) => void;
  method: string;
}

interface ActiveTurn {
  turnId?: string;
  startedAtMs: number;
  finalText: string;
  allAgentText: string;
  itemText: Map<string, string>;
  progress: CodexAppProgressThrottler;
  progressTimer?: ReturnType<typeof setInterval>;
  pendingSteers: string[];
  steerChain: Promise<void>;
  done: Promise<void>;
  resolveDone: () => void;
  criticalHookFailure?: string;
}

const OSC_PREFIX = '\x1b]777;botmux:';
const OSC_END = '\x07';
const PROGRESS_TICK_MS = 250;

function asError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}

function parseArgs(argv: string[]): Args {
  const out: Args = {
    sessionId: '',
    codexBin: 'codex',
    cwd: process.cwd(),
  };
  for (let i = 0; i < argv.length; i++) {
    const key = argv[i];
    const val = argv[i + 1];
    if (key === '--session-id' && val !== undefined) { out.sessionId = val; i++; }
    else if (key === '--codex-bin' && val !== undefined) { out.codexBin = val; i++; }
    else if (key === '--cwd' && val !== undefined) { out.cwd = val; i++; }
    else if (key === '--thread-id' && val !== undefined) { out.threadId = val; i++; }
    else if (key === '--bot-name' && val !== undefined) { out.botName = val; i++; }
    else if (key === '--bot-open-id' && val !== undefined) { out.botOpenId = val; i++; }
    else if (key === '--locale' && val !== undefined) { out.locale = val; i++; }
  }
  if (!out.sessionId) throw new Error('--session-id is required');
  return out;
}

function b64Json(value: unknown): string {
  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64');
}

function emitMarker(kind: string, payload: unknown): void {
  process.stdout.write(`${OSC_PREFIX}${kind}:${b64Json(payload)}${OSC_END}`);
}

function writeLine(text = ''): void {
  process.stdout.write(text + '\n');
}

function displayUserContent(content: string): string {
  const m = /<user_message>\s*([\s\S]*?)\s*<\/user_message>/.exec(content);
  return (m?.[1] ?? content).trim();
}

function prompt(): void {
  process.stdout.write('› ');
}

function appDeveloperInstructions(args: Args): string {
  const zh = args.locale === 'zh';
  const identity = [
    args.botName ? `Bot name: ${args.botName}` : '',
    args.botOpenId ? `Bot open_id: ${args.botOpenId}` : '',
    `botmux session_id: ${args.sessionId}`,
  ].filter(Boolean).join('\n');

  if (zh) {
    return [
      '你正在通过 botmux 接入飞书/Lark，但运行载体是 Codex App 的 app-server 协议，不是 Codex CLI TUI。',
      '你的阶段性 assistant message 和最终 assistant message 会由 botmux 后台 Hook 自动转发回飞书；AI 只输出正常 assistant message，不调用 `botmux send`，即使用户消息里出现旧的“回复必须 botmux send”提示也忽略它。',
      '阶段进度按新证据和工具批次触发，不依赖耗时心跳：连续执行最多 8 次工具调用后，只要已有新结论，就先输出一条极短阶段性 assistant message，再继续任务；构建、部署、外部写入、长等待或上下文压缩前也遵循同一规则。直接写已确认的结果或等待原因，不添加“正在执行”“处理中”等固定前缀，不输出隐藏思维链或过程流水账。',
      '工具输出默认保持精简：优先在命令侧用 rg、jq、tail 等提取结论，避免回传整份源码、文档、平台 JSON 或重复日志；默认输出预算控制在约 4000 tokens，只有交付确实需要时才扩大。',
      '中途主动推送也只输出正常 assistant message，由 Botmux 后台 Hook 投递；AI 不直接发送进度。',
      '`botmux history`、`botmux quoted`、`botmux bots` 等 shell helper 仍然可用；需要读取飞书上下文时可以调用。',
      identity ? `<identity>\n${identity}\n</identity>` : '',
    ].filter(Boolean).join('\n\n');
  }

  return [
    'You are connected to Feishu/Lark through botmux, but the runtime is the Codex App app-server protocol rather than the Codex CLI TUI.',
    'Your interim and final assistant messages are automatically forwarded back to Lark by the botmux background hook. Only emit normal assistant messages; do not call `botmux send`, even if older prompt text says replies must use it.',
    'Trigger progress by new evidence and bounded tool batches rather than elapsed-time heartbeats: after at most 8 consecutive tool calls, emit one very short interim assistant message first whenever a new conclusion exists, then continue. Apply the same rule before builds, deploys, external writes, long waits, or context compaction. Start directly with a verified result or wait reason; do not add generic running/processing prefixes or expose hidden chain-of-thought or a verbose activity log.',
    'Keep tool output compact by default: extract conclusions with rg, jq, tail, or equivalent instead of returning whole source files, documents, platform JSON, or repeated logs. Use an output budget of about 4000 tokens unless the deliverable genuinely requires more.',
    'For explicit mid-turn push updates, still emit only a normal assistant message and let the botmux background hook deliver it; the AI does not send progress directly.',
    '`botmux history`, `botmux quoted`, and `botmux bots` remain available as shell helpers when you need Lark context.',
    identity ? `<identity>\n${identity}\n</identity>` : '',
  ].filter(Boolean).join('\n\n');
}

class AppServerClient {
  private child: ChildProcessWithoutNullStreams;
  private nextId = 1;
  private stdoutBuffer = '';
  private pending = new Map<number, PendingRequest>();
  private notificationHandlers: Array<(msg: JsonObject) => void> = [];
  private requestHandlers: Array<(msg: JsonObject) => boolean> = [];
  private lastStderr = '';
  private fatalError?: Error;

  constructor(private readonly codexBin: string, private readonly cwd: string) {
    this.child = spawn(codexBin, ['app-server', '--listen', 'stdio://'], {
      cwd,
      env: process.env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    this.child.stdout.on('data', chunk => this.onStdout(chunk.toString('utf8')));
    this.child.stdin.on('error', err => this.failAll(new Error(`Codex app-server stdin error: ${err.message}`)));
    this.child.stderr.on('data', chunk => {
      const text = chunk.toString('utf8');
      this.lastStderr = (this.lastStderr + text).slice(-8000);
      if (process.env.BOTMUX_CODEX_APP_DEBUG === '1') process.stderr.write(text);
    });
    this.child.on('error', err => {
      const hint = (err as NodeJS.ErrnoException).code === 'ENOENT'
        ? '\nHint: install the Codex CLI, or set cliPathOverride to the Codex App bundled binary, for example /Applications/Codex.app/Contents/Resources/codex.'
        : '';
      this.failAll(new Error(`Failed to start Codex app-server with "${codexBin}": ${err.message}${hint}`));
    });
    this.child.on('exit', (code, signal) => {
      const err = this.fatalError ?? new Error(`Codex app-server exited (code=${code}, signal=${signal})${this.lastStderr ? `\n${this.lastStderr}` : ''}`);
      this.failAll(err);
    });
  }

  onNotification(handler: (msg: JsonObject) => void): void {
    this.notificationHandlers.push(handler);
  }

  onRequest(handler: (msg: JsonObject) => boolean): void {
    this.requestHandlers.push(handler);
  }

  async initialize(): Promise<void> {
    await this.request('initialize', {
      clientInfo: { name: 'botmux-codex-app', version: '0.0.0' },
      capabilities: { experimentalApi: true },
    });
    this.notify('initialized');
  }

  request(method: string, params: unknown): Promise<any> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject, method });
      try {
        this.write({ jsonrpc: '2.0', id, method, params });
      } catch (err) {
        this.pending.delete(id);
        reject(asError(err));
      }
    });
  }

  respond(id: number, result: unknown): void {
    this.write({ jsonrpc: '2.0', id, result });
  }

  notify(method: string, params?: unknown): void {
    const msg: JsonObject = { jsonrpc: '2.0', method };
    if (params !== undefined) msg.params = params;
    this.write(msg);
  }

  close(): void {
    try { this.child.kill(); } catch { /* already gone */ }
  }

  private write(msg: JsonObject): void {
    if (this.fatalError) throw this.fatalError;
    this.child.stdin.write(JSON.stringify(msg) + '\n');
  }

  private failAll(err: Error): void {
    this.fatalError = this.fatalError ?? err;
    const fatal = this.fatalError;
    for (const pending of this.pending.values()) pending.reject(fatal);
    this.pending.clear();
  }

  private onStdout(data: string): void {
    this.stdoutBuffer += data;
    for (;;) {
      const nl = this.stdoutBuffer.indexOf('\n');
      if (nl < 0) return;
      const line = this.stdoutBuffer.slice(0, nl).trim();
      this.stdoutBuffer = this.stdoutBuffer.slice(nl + 1);
      if (!line) continue;
      let msg: JsonObject;
      try {
        msg = JSON.parse(line);
      } catch {
        continue;
      }
      this.dispatch(msg);
    }
  }

  private dispatch(msg: JsonObject): void {
    if (typeof msg.id === 'number' && (msg.result !== undefined || msg.error !== undefined)) {
      const pending = this.pending.get(msg.id);
      if (!pending) return;
      this.pending.delete(msg.id);
      if (msg.error) pending.reject(new Error(`${pending.method}: ${JSON.stringify(msg.error)}`));
      else pending.resolve(msg.result);
      return;
    }

    if (typeof msg.id === 'number' && typeof msg.method === 'string') {
      for (const handler of this.requestHandlers) {
        if (handler(msg)) return;
      }
      this.respond(msg.id, { decision: 'decline' });
      return;
    }

    if (typeof msg.method === 'string') {
      for (const handler of this.notificationHandlers) handler(msg);
    }
  }
}

let args: Args;
try {
  args = parseArgs(process.argv.slice(2));
} catch (err: any) {
  console.error(err?.message ?? err);
  process.exit(2);
}

const client = new AppServerClient(args.codexBin, args.cwd);
let threadId = args.threadId;
let threadReady = false;
let activeTurn: ActiveTurn | null = null;
const queue: string[] = [];
let inputBuffer = '';
let processing = false;

function makeTurn(): ActiveTurn {
  let resolveDone!: () => void;
  const done = new Promise<void>(resolve => { resolveDone = resolve; });
  return {
    startedAtMs: Date.now(),
    finalText: '',
    allAgentText: '',
    itemText: new Map(),
    progress: new CodexAppProgressThrottler(),
    pendingSteers: [],
    steerChain: Promise.resolve(),
    done,
    resolveDone,
  };
}

function userTextInput(content: string): JsonObject[] {
  return [{ type: 'text', text: content, text_elements: [] }];
}

function maybeEmitProgress(turn: ActiveTurn, force = false): void {
  if (turn.finalText) return;
  const snapshots = turn.progress.drainSnapshots({
    turnId: turn.turnId,
    text: turn.allAgentText,
    startedAtMs: turn.startedAtMs,
    nowMs: Date.now(),
    force,
  });
  for (const snapshot of snapshots) emitMarker('progress', snapshot);
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
          input: userTextInput(content),
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
  // A busy follow-up is a new visible progress epoch even though app-server
  // keeps it inside the same turn/steer lifecycle. Do not let the previous
  // assistant text cursor suppress commentary produced for this guidance.
  activeTurn.progress.resetTo(activeTurn.allAgentText);
  activeTurn.pendingSteers.push(content);
  flushSteers(activeTurn);
}

function handleServerRequest(msg: JsonObject): boolean {
  const method = msg.method;
  if (method === 'item/commandExecution/requestApproval') {
    client.respond(msg.id, { decision: 'acceptForSession' });
    return true;
  }
  if (method === 'item/fileChange/requestApproval') {
    client.respond(msg.id, { decision: 'acceptForSession' });
    return true;
  }
  if (method === 'item/permissions/requestApproval') {
    client.respond(msg.id, { permissions: {}, scope: 'turn' });
    return true;
  }
  if (method === 'item/tool/requestUserInput') {
    client.respond(msg.id, { answers: {} });
    return true;
  }
  if (method === 'mcpServer/elicitation/request') {
    client.respond(msg.id, { action: 'cancel', content: null, _meta: null });
    return true;
  }
  if (method === 'item/tool/call') {
    client.respond(msg.id, { contentItems: [], success: false });
    return true;
  }
  if (method === 'execCommandApproval' || method === 'applyPatchApproval') {
    client.respond(msg.id, { decision: 'approved_for_session' });
    return true;
  }
  return false;
}

function handleNotification(msg: JsonObject): void {
  const params = msg.params ?? {};
  if (!activeTurn || params.threadId !== threadId) return;
  if (activeTurn.turnId && params.turnId && params.turnId !== activeTurn.turnId) return;

  if (msg.method === 'turn/started') {
    activeTurn.turnId = params.turn?.id ?? params.turnId ?? activeTurn.turnId;
    flushSteers(activeTurn);
    return;
  }

  if (msg.method === 'hook/started' || msg.method === 'hook/completed') {
    const phase = msg.method === 'hook/started' ? 'started' : 'completed';
    const run = params.run;
    if (phase === 'completed') {
      const atMs = normalizeCodexAppTimestampMs(run?.completedAt);
      const failure = codexAppHookFailure(run);
      if (failure) {
        writeLine(`\n[codex-app] ${failure.message}`);
        emitMarker('progress', {
          content: failure.message,
          turnId: activeTurn.turnId,
          startedAtMs: activeTurn.startedAtMs,
          updatedAtMs: atMs,
        });
        if (failure.critical) {
          activeTurn.criticalHookFailure = failure.message;
          const failedTurnId = activeTurn.turnId ?? params.turnId;
          if (threadId && failedTurnId) {
            void client.request('turn/interrupt', { threadId, turnId: failedTurnId }).catch(() => {});
          }
        }
      }
    }
    return;
  }

  if (msg.method === 'item/started') {
    const item = params.item;
    if (item?.type === 'commandExecution') {
      writeLine(`\n$ ${item.command}`);
    } else if (item?.type === 'fileChange') {
      writeLine('\n[files changed]');
    }
    return;
  }

  if (msg.method === 'item/agentMessage/delta') {
    const delta = String(params.delta ?? '');
    const itemId = String(params.itemId ?? '');
    activeTurn.itemText.set(itemId, (activeTurn.itemText.get(itemId) ?? '') + delta);
    activeTurn.allAgentText += delta;
    process.stdout.write(delta);
    maybeEmitProgress(activeTurn);
    return;
  }

  if (msg.method === 'item/commandExecution/outputDelta' || msg.method === 'item/fileChange/outputDelta') {
    process.stdout.write(String(params.delta ?? ''));
    return;
  }

  if (msg.method === 'item/completed') {
    const item = params.item;
    if (item?.type === 'agentMessage') {
      if (item.phase === 'final_answer') activeTurn.finalText = String(item.text ?? '');
      else if (!activeTurn.itemText.has(item.id) && item.text) {
        activeTurn.allAgentText += String(item.text);
        maybeEmitProgress(activeTurn, true);
      }
    }
    return;
  }

  if (msg.method === 'turn/completed') {
    const turn = params.turn;
    if (turn?.id && activeTurn.turnId && turn.id !== activeTurn.turnId) return;
    if (activeTurn.criticalHookFailure) {
      activeTurn.finalText = activeTurn.criticalHookFailure;
    } else if (turn?.error?.message && !activeTurn.finalText) {
      activeTurn.finalText = `Codex App turn failed: ${turn.error.message}`;
    }
    activeTurn.resolveDone();
  }
}

async function currentHookTrustIssue(): Promise<string | undefined> {
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

async function ensureThread(): Promise<string> {
  if (threadReady && threadId) return threadId;

  if (threadId) {
    try {
      const resumed = await client.request('thread/resume', {
        threadId,
        cwd: args.cwd,
        approvalPolicy: 'never',
        sandbox: 'danger-full-access',
        config: { shell_environment_policy: { inherit: 'all' } },
        developerInstructions: appDeveloperInstructions(args),
        excludeTurns: true,
        // Keep Codex App's rich history in sync with turns created by this
        // external runner so the desktop UI can render follow-up messages.
        persistExtendedHistory: true,
      });
      const resumedThreadId = String(resumed.thread.id);
      threadId = resumedThreadId;
      threadReady = true;
      emitMarker('thread', { threadId: resumedThreadId });
      return resumedThreadId;
    } catch (err: any) {
      writeLine(`[codex-app] resume failed, starting a fresh thread: ${err?.message ?? err}`);
      threadId = undefined;
      threadReady = false;
    }
  }

  const started = await client.request('thread/start', {
    cwd: args.cwd,
    approvalPolicy: 'never',
    sandbox: 'danger-full-access',
    config: { shell_environment_policy: { inherit: 'all' } },
    serviceName: 'botmux',
    developerInstructions: appDeveloperInstructions(args),
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
      name: `botmux ${args.sessionId.slice(0, 8)}`,
    });
  } catch { /* naming is cosmetic */ }
  return startedThreadId;
}

async function runTurn(content: string): Promise<void> {
  const hookTrustIssue = await currentHookTrustIssue();
  if (hookTrustIssue) throw new Error(hookTrustIssue);
  const tid = await ensureThread();
  const turn = makeTurn();
  activeTurn = turn;
  // Agent-message deltas are event driven, but a short unpunctuated delta may
  // be followed by a long tool call. Tick independently so the first progress
  // snapshot is not held until another model delta happens to arrive.
  turn.progressTimer = setInterval(() => {
    if (activeTurn === turn) maybeEmitProgress(turn);
  }, PROGRESS_TICK_MS);
  turn.progressTimer.unref();
  try {
    writeLine();
    writeLine('[user]');
    writeLine(content);
    emitMarker('user', {
      kind: 'user',
      content: displayUserContent(content),
      at: turn.startedAtMs,
      turnId: turn.turnId,
    });
    writeLine();

    const result = await client.request('turn/start', {
      threadId: tid,
      input: userTextInput(content),
      cwd: args.cwd,
      approvalPolicy: 'never',
      sandboxPolicy: { type: 'dangerFullAccess' },
    });
    turn.turnId = result.turn?.id ?? turn.turnId;
    flushSteers(turn);
    await turn.done;
    await turn.steerChain;
    queuePendingSteersAsNextTurns(turn);

    const finalText = (turn.finalText || turn.allAgentText).trim();
    const completedAtMs = Date.now();
    if (finalText) {
      emitMarker('final', {
        turnId: turn.turnId ?? `codex-app-${completedAtMs}`,
        content: finalText,
        startedAtMs: turn.startedAtMs,
        completedAtMs,
      });
    }
    writeLine();
  } finally {
    if (turn.progressTimer) clearInterval(turn.progressTimer);
    queuePendingSteersAsNextTurns(turn);
    if (activeTurn === turn) activeTurn = null;
  }
}

async function drainQueue(): Promise<void> {
  if (processing) return;
  processing = true;
  try {
    while (queue.length > 0) {
      const next = queue.shift()!;
      try {
        await runTurn(next);
      } catch (err: any) {
        const message = `Codex App runner error: ${err?.message ?? err}`;
        writeLine(message);
        emitMarker('final', {
          turnId: `codex-app-error-${Date.now()}`,
          content: message,
          startedAtMs: Date.now(),
          completedAtMs: Date.now(),
        });
      }
      prompt();
    }
  } finally {
    processing = false;
  }
}

function enqueueLine(line: string): void {
  const trimmed = line.trim();
  if (!trimmed) return;
  if (trimmed.startsWith('::botmux-codex-app:')) {
    const encoded = trimmed.slice('::botmux-codex-app:'.length);
    try {
      const decoded = JSON.parse(Buffer.from(encoded, 'base64').toString('utf8'));
      if (decoded?.type === 'message' && typeof decoded.content === 'string') {
        handleUserMessage(decoded.content);
      }
    } catch (err: any) {
      writeLine(`[codex-app] bad botmux input: ${err?.message ?? err}`);
    }
    return;
  }
  handleUserMessage(line);
}

function handleInput(data: Buffer): void {
  const text = data.toString('utf8');
  for (const ch of text) {
    if (ch === '\u0003') {
      process.exit(130);
    } else if (ch === '\r' || ch === '\n') {
      const line = inputBuffer;
      inputBuffer = '';
      enqueueLine(line);
    } else if (ch === '\u007f' || ch === '\b') {
      inputBuffer = inputBuffer.slice(0, -1);
    } else {
      inputBuffer += ch;
    }
  }
}

async function main(): Promise<void> {
  client.onRequest(handleServerRequest);
  client.onNotification(handleNotification);
  await client.initialize();
  const hookTrustIssue = await currentHookTrustIssue();
  if (hookTrustIssue) writeLine(`[codex-app] ${hookTrustIssue}`);
  await ensureThread();
  writeLine('Codex App connected.');
  if (process.stdin.isTTY) process.stdin.setRawMode(true);
  process.stdin.resume();
  process.stdin.on('data', handleInput);
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
