import { existsSync, readFileSync, mkdirSync, openSync, readSync, closeSync, fstatSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname, basename } from 'node:path';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { buildMarkdownCard, buildTitledMarkdownCard } from '../im/lark/md-card.js';
import { nativeConversationHistoryButtons } from '../im/lark/conversation-history-button.js';
import { formatMathForLark } from './outbound-math.js';
import { replyMessage, sendMessage, updateMessage } from '../im/lark/client.js';
import { logger } from '../utils/logger.js';
import { ExternalCodexBridge, NativeOwnerUnavailable, type ExternalCodexBinding, type ExternalCodexOutputKind, type FollowupCard, type FollowupCheckpoint } from './external-codex-bridge.js';
import { CodexAutoBridge, type AutoCodexBinding } from './codex-auto-bridge.js';
import { CodexAppServerProbe } from './codex-app-threads.js';
import { collectBotmuxSessionIdentities } from './session-store.js';
import { submitToCodexOwner } from './codex-owner-ipc.js';
import { submitToOriginalCodexDaemon } from './codex-original-daemon.js';
import { submitToVscodeSsh, type CodexVscodeSshTarget } from './codex-vscode-ssh.js';
import { readCodexSessionStatistics, codexStatisticsText } from './codex-session-statistics.js';
import { recoverCodexTopic } from './codex-topic-recovery.js';
import { getMessageDetail } from '../im/lark/client.js';
import { config } from '../config.js';

export let externalCodexBridge: ExternalCodexBridge | CodexAutoBridge | undefined;

export function startExternalCodexBridge(selfAppId: string): void {
  const configPath = join(homedir(), '.config/botmux/external-codex.json');
  if (!existsSync(configPath)) return;
  const cfg = JSON.parse(readFileSync(configPath, 'utf8'));
  if (cfg.enabled !== true) return;
  // Exactly one bot daemon owns global discovery and its persisted registry.
  // Other bots retain their native session hooks without observing this bridge.
  const ownerApps = cfg.mode === 'auto' ? [cfg.larkAppId] : cfg.bindings?.map((b: ExternalCodexBinding) => b.larkAppId);
  if (!ownerApps?.includes(selfAppId)) return;
  if (ownerApps.some((app: string) => app !== selfAppId)) throw new Error('External Codex bindings must belong to one bot');
  if (cfg.mode === 'auto') {
    if (!Array.isArray(cfg.codexHomes) || !cfg.codexHomes.length || !cfg.larkAppId || !cfg.chatId || !cfg.ownerOpenId || !cfg.codexBin) throw new Error('Invalid automatic Codex bridge config');
    const durableThreadIds = new Set<string>(cfg.durableThreadIds ?? []);
    const vscodeTargets: Record<string, CodexVscodeSshTarget> = cfg.vscodeSshThreads ?? {};
    const auto = new CodexAutoBridge(cfg, join(homedir(), '.local/state/botmux/codex-auto/registry.json'), {
      topic: (b, uuid) => {
        if (!b.firstUserMessage) throw new Error('Automatic topic requires the original user message');
        return sendMessage(b.larkAppId, b.chatId, b.firstUserMessage, 'text', uuid);
      },
      findTopic: b => recoverCodexTopic(join(config.session.dataDir, 'conversation-history'),
        b.threadId, b.larkAppId, b.chatId, root => getMessageDetail(b.larkAppId, root)),
      reply: async (b, text, uuid, kind) => replyMessage(b.larkAppId, b.outputRootMessageId ?? b.rootMessageId,
        buildExternalCodexForwardCard(b, text, kind, nativeConversationHistoryButtons({ ...b, rootMessageId: b.outputRootMessageId ?? b.rootMessageId }, kind === 'user' ? uuid : false)), 'interactive', true, uuid),
      status: async (b, status) => {
        const card = buildFollowupStatusCard(b, status);
        if (status.cardId) {
          await updateMessage(b.larkAppId, status.cardId, card);
          return status.cardId;
        }
        const uuid = createHash('sha256').update(`native-followup-v2:${status.messageId}`).digest('hex').slice(0, 32);
        return replyMessage(b.larkAppId, b.outputRootMessageId ?? b.rootMessageId, card, 'interactive', true, uuid);
      },
      turn: async (b, text, checkpoint, clientUserMessageId) => {
        const target = Object.hasOwn(vscodeTargets, b.threadId) ? vscodeTargets[b.threadId] : undefined;
        if (target && await submitToVscodeSsh(target, b.threadId, b.rolloutPath, text, checkpoint, clientUserMessageId)) return;
        if (durableThreadIds.has(b.threadId)) {
          if (await submitToOriginalCodexDaemon(b.codexHome, b.threadId, b.rolloutPath, text, checkpoint, clientUserMessageId)) return;
        } else if (!target && await submitToCodexOwner(b.codexHome, b.threadId, text, checkpoint, clientUserMessageId)) return;
        throw new NativeOwnerUnavailable(`Codex IDE owner unavailable for ${b.threadId}; follow-up retained`);
      },
      excluded: () => collectBotmuxSessionIdentities() ?? new Set(),
      error: e => logger.error(`[codex-auto] ${String(e)}`),
    });
    externalCodexBridge = auto;
    void auto.start().then(() => logger.info(`[codex-auto] watching all sessions in ${cfg.codexHomes.length} libraries`)).catch(e => logger.error(`[codex-auto] startup failed: ${String(e)}`));
    return;
  }
  if (!Array.isArray(cfg.bindings) || !cfg.codexHome || !cfg.codexBin) throw new Error('Invalid external Codex bridge config');
  for (const b of cfg.bindings) {
    for (const field of ['threadId', 'rolloutPath', 'cwd', 'chatId', 'larkAppId', 'ownerOpenId', 'rootMessageId']) {
      if (typeof b[field] !== 'string' || !b[field]) throw new Error(`Missing external Codex binding ${field}`);
    }
  }
  const statePath = join(homedir(), '.local/state/botmux/external-codex.json');
  mkdirSync(dirname(statePath), { recursive: true, mode: 0o700 });
  externalCodexBridge = new ExternalCodexBridge(cfg.bindings, statePath, {
    reply: async (b, text, uuid, kind) => replyMessage(b.larkAppId, b.outputRootMessageId ?? b.rootMessageId,
        buildExternalCodexForwardCard(b, text, kind, nativeConversationHistoryButtons({ ...b, rootMessageId: b.outputRootMessageId ?? b.rootMessageId }, kind === 'user' ? uuid : false)), 'interactive', true, uuid),
    received: (b, messageId, text) => replyMessage(b.larkAppId, b.outputRootMessageId ?? b.rootMessageId,
      buildExternalCodexStatusCard(b, text), 'interactive', true, `codex-status:${messageId}`),
    turn: (b, text, checkpoint, clientUserMessageId) => runExternalCodexTurn(cfg.codexBin, cfg.codexHome, b, text, checkpoint, clientUserMessageId),
    error: e => logger.error(`[external-codex] ${String(e)}`),
  });
  externalCodexBridge.start();
  logger.info(`[external-codex] observing ${cfg.bindings.length} explicitly bound thread(s)`);
}

/** Mirror public content without repeating bridge metadata or statistics. */
export function buildExternalCodexForwardCard(binding: ExternalCodexBinding, text: string, kind?: ExternalCodexOutputKind, historyButtons: any[] = []): string {
  const md = formatMathForLark(text);
  const question = binding.currentUserMessage?.trim() || binding.firstUserMessage?.trim();
  // The question itself already occupies the whole user card; never quote it twice.
  const card = JSON.parse(kind === 'user' || !question ? buildMarkdownCard(md, undefined, '')
    : buildTitledMarkdownCard({ title: question, md, brand: '', template: kind === 'progress' ? 'turquoise' : 'green' }));
  if (historyButtons.length) card.body.elements.push(...historyButtons);
  return JSON.stringify(card);
}

export function buildFollowupStatusCard(binding: ExternalCodexBinding, status: Readonly<FollowupCard>): string {
  const labels = {
    queued: '排队中 · 追问已保存，等待投递。',
    waiting_turn: '排队中 · 原生会话上轮尚未报告结束，这条追问未投递。',
    protected: '原档受保护 · 追问已保存，等待绑定可续聊的分支。',
    waiting_owner: '原生会话不可达 · 追问尚未投递，恢复连接后将自动重试。',
    retrying: '排队中 · 投递暂未成功，将自动重试。',
    sending: '投递中 · 等待原生会话确认。',
    uncertain: '待确认 · 尚未确认原生会话是否收到，将核对回执以避免重复提交。',
    accepted: '已投递 · 等待原生会话记录本轮开始。',
    running: '执行中 · 原生会话已记录本轮开始。',
    finished: '本轮已结束。',
    aborted: '本轮已中断。',
  } satisfies Record<FollowupCard['phase'], string>;
  const checked = new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
  }).format(status.checkedAt);
  const buttons = nativeConversationHistoryButtons({ ...binding, rootMessageId: binding.outputRootMessageId ?? binding.rootMessageId });
  return JSON.stringify({
    config: { wide_screen_mode: true, update_multi: true },
    header: {
      template: status.phase === 'running' || status.phase === 'finished' ? 'green' : 'orange',
      title: { tag: 'plain_text', content: Array.from(status.text.replace(/\s+/g, ' ').trim()).slice(0, 40).join('') || 'Codex 追问' },
    },
    elements: [
      { tag: 'div', text: { tag: 'plain_text', content: labels[status.phase] } },
      { tag: 'note', elements: [{ tag: 'plain_text', content: `最近确认 ${checked}（北京时间）` }] },
      ...(buttons.length ? [{ tag: 'action', actions: buttons }] : []),
    ],
  });
}

/** Immediate, small acknowledgement for a follow-up to a native Codex thread. */
export function buildExternalCodexStatusCard(binding: ExternalCodexBinding, title = 'Codex'): string {
  const stats = readCodexSessionStatistics(binding.rolloutPath, Date.now(), false);
  const lines = codexStatisticsText(stats, undefined, Date.now(), false).split('\n');
  const model = readNativeModelStatus(binding.rolloutPath);
  const cwd = binding.cwd.length > 36 ? `…/${basename(binding.cwd)}` : binding.cwd;
  const compactLines = [
    `📁 ${cwd} · ${model}`,
    lines[0] ?? '',
    lines[1] ?? '',
  ];
  const historyButtons = nativeConversationHistoryButtons({ ...binding, rootMessageId: binding.outputRootMessageId ?? binding.rootMessageId });
  const terminalButtons = historyButtons.map(button => {
    const url = new URL(button.multi_url.url);
    url.searchParams.set('view', 'terminal');
    const href = url.toString();
    return { ...button, type: 'primary', text: { tag: 'plain_text', content: '🖥️ 打开 Web 终端' },
      multi_url: { url: href, pc_url: href, android_url: href, ios_url: href } };
  });
  return JSON.stringify({
    config: { wide_screen_mode: true },
    header: { template: 'green', title: { tag: 'plain_text', content: Array.from(title.replace(/\s+/g, ' ').trim()).slice(0, 18).join('') || 'Codex' } },
    elements: [
      ...compactLines.map(content => ({ tag: 'div', text: { tag: 'plain_text', content } })),
      { tag: 'action', actions: [...terminalButtons, ...historyButtons] },
    ],
  });
}

/** Read only a bounded JSONL tail to show the native thread's actual model. */
function readNativeModelStatus(path: string): string {
  let fd: number | undefined;
  try {
    fd = openSync(path, 'r');
    const size = fstatSync(fd).size;
    const length = Math.min(size, 4 * 1024 * 1024);
    const buffer = Buffer.alloc(length);
    readSync(fd, buffer, 0, length, size - length);
    let model: string | undefined, effort: string | undefined, tier: string | undefined;
    for (const line of buffer.toString('utf8').split('\n').reverse()) {
      if (!line.includes('turn_context') && !line.includes('thread_settings_applied')) continue;
      let row: any;
      try { row = JSON.parse(line); } catch { continue; }
      if (row.type === 'turn_context') {
        model ??= row.payload?.model;
        effort ??= row.payload?.effort;
      } else if (row.payload?.type === 'thread_settings_applied') {
        const settings = row.payload?.thread_settings;
        model ??= settings?.model;
        effort ??= settings?.reasoning_effort;
        tier ??= settings?.service_tier;
      }
      if (model && effort && tier) break;
    }
    if (!model) return 'Codex';
    const shortModel = String(model).replace(/^gpt-/, '');
    const shortEffort = effort ? ` ${String(effort).replace('medium', 'M').replace('ultra', 'U').replace('xhigh', 'XH').replace('high', 'H').replace('low', 'L')}` : '';
    return `${shortModel}${shortEffort}${tier ? ` F${tier === 'priority' ? '√' : '×'}` : ''}`;
  } catch { return 'Codex'; }
  finally { if (fd !== undefined) closeSync(fd); }
}

export async function forkExternalCodexThread(binary: string, b: AutoCodexBinding): Promise<{ threadId: string; rolloutPath: string }> {
  const client = new CodexAppServerProbe(binary, b.cwd, { ...process.env, HOME: homedir(), CODEX_HOME: b.codexHome });
  try {
    await client.initialize(15000);
    const result = await client.withTimeout(client.request('thread/fork', {
      threadId: b.threadId, cwd: b.cwd, persistExtendedHistory: true,
    }), 30000, 'fork external archive');
    const threadId = result.thread?.id, rolloutPath = result.thread?.path;
    if (typeof threadId !== 'string' || typeof rolloutPath !== 'string' || threadId === b.threadId) throw new Error('Codex fork did not return a distinct persisted thread');
    return { threadId, rolloutPath };
  } finally { client.close(); }
}

export async function runExternalCodexTurn(binary: string, codexHome: string, b: ExternalCodexBinding, text: string, checkpoint: (submitted?: boolean) => void, clientUserMessageId?: string): Promise<void> {
  if (await submitToCodexOwner(codexHome, b.threadId, text, checkpoint, clientUserMessageId)) return;
  const child = spawn(binary, ['app-server', '--listen', 'stdio://'], {
    cwd: b.cwd, env: { ...process.env, HOME: homedir(), CODEX_HOME: codexHome }, stdio: ['pipe', 'pipe', 'pipe'],
  });
  let seq = 0, buffer = '', turnId: string | undefined;
  const pending = new Map<number, { resolve: (x: any) => void; reject: (e: Error) => void }>();
  let finish!: () => void, fail!: (e: Error) => void;
  const completed = new Promise<void>((resolve, reject) => { finish = resolve; fail = reject; });
  // Attach a rejection handler before initialize/resume can fail.
  void completed.catch(() => {});
  const die = (e: Error) => { for (const p of pending.values()) p.reject(e); pending.clear(); fail(e); };
  const timer = setTimeout(() => { die(new Error('External Codex turn timed out; input retained for inspection')); child.kill(); }, 300_000);
  child.on('error', die);
  child.stdin.on('error', die);
  child.on('exit', () => die(new Error('External Codex app-server exited')));
  child.stderr.resume();
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', data => {
    buffer += data;
    let end: number;
    while ((end = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
      let msg: any;
      try { msg = JSON.parse(line); } catch { continue; }
      if (typeof msg.id === 'number' && pending.has(msg.id)) {
        const p = pending.get(msg.id)!; pending.delete(msg.id);
        if (msg.error) p.reject(new Error(JSON.stringify(msg.error))); else p.resolve(msg.result);
      } else if (msg.method === 'turn/completed' && msg.params?.threadId === b.threadId) {
        if (turnId && msg.params.turn?.id !== turnId) continue;
        if (msg.params.turn?.status === 'failed') fail(new Error('External Codex turn failed'));
        else finish();
      }
    }
  });
  const request = (method: string, params: unknown) => new Promise<any>((resolve, reject) => {
    const id = ++seq;
    pending.set(id, { resolve, reject });
    child.stdin.write(JSON.stringify({ id, method, params }) + '\n');
  });
  try {
    await request('initialize', { clientInfo: { name: 'botmux-external-codex', version: '1' } });
    child.stdin.write(JSON.stringify({ method: 'initialized' }) + '\n');
    await request('thread/resume', {
      threadId: b.threadId, cwd: b.cwd, approvalPolicy: 'never', sandbox: 'danger-full-access',
      persistExtendedHistory: true,
    });
    checkpoint();
    const started = await request('turn/start', { threadId: b.threadId, input: [{ type: 'text', text }], ...(clientUserMessageId ? { clientUserMessageId } : {}) });
    turnId = started.turn?.id;
    await completed;
  } finally { clearTimeout(timer); child.kill(); }
}
