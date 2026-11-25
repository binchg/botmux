import { existsSync, readFileSync, mkdirSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { createHash } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { config } from '../config.js';
import * as store from '../services/session-store.js';
import { readSessionModelRuntime, modelRuntimeAlive } from '../services/session-model-store.js';
import { resolveSessionTranscriptPath } from '../services/transcript-resolver.js';
import { readCodexSyncEvents } from '../services/codex-sync-reader.js';
import { readCodexSessionStatistics } from '../services/codex-session-statistics.js';
import { externalCodexBridge } from '../services/external-codex-runtime.js';
import { atomicWriteFileSync } from '../utils/atomic-write.js';
import { getBot, effectiveBotDisplayName } from '../bot-registry.js';
import { replyMessage } from '../im/lark/client.js';
import { findActiveBySessionId, getActiveSessionsRegistry } from './worker-pool.js';
import { reconcileActiveSessionRegistry, buildFollowUpContent, rememberLastCliInput } from './session-manager.js';
import { sendSessionInput } from './session-working-dir-runtime.js';
import { markSessionActivity } from './session-activity.js';
import { logger } from '../utils/logger.js';

type Route = (method: string, path: string, handler: (req: IncomingMessage, res: ServerResponse, params: Record<string, string>) => void | Promise<void>) => void;
type Thread = { key: string; title: string; bot: string; threadId?: string; cwd?: string; createdAt?: string; kind: 'bot' | 'native'; path?: string; rootMessageId: string; chatId: string; ownerOpenId?: string };
export function codexSyncThreads(appId: string): Thread[] {
  const bot = effectiveBotDisplayName(getBot(appId));
  const threads: Thread[] = store.listSessions().filter(s => s.larkAppId === appId && s.status === 'active' && s.cliId === 'codex-app').map(s => {
    const runtime = readSessionModelRuntime(config.session.dataDir, s.sessionId);
    const threadId = runtime?.threadId ?? s.cliSessionId;
    const path = resolveSessionTranscriptPath({ cliId: runtime?.selection?.executor === 'traex' ? 'traex' : 'codex', sessionId: s.sessionId, cliSessionId: threadId, cwd: s.workingDir })?.path;
    return { key: s.sessionId, title: s.title, bot, threadId, cwd: s.workingDir, createdAt: s.createdAt, kind: 'bot', path, rootMessageId: s.rootMessageId, chatId: s.chatId, ownerOpenId: s.ownerOpenId };
  });
  const file = join(homedir(), '.local/state/botmux/codex-auto/registry.json');
  if (existsSync(file)) {
    const registry = JSON.parse(readFileSync(file, 'utf8'));
    const bindings = (Object.entries(registry.bindings ?? {}) as Array<[string, any]>)
      .filter(([, b]) => b.larkAppId === appId && !b.suppressed);
    const roots = new Map<string, number>();
    for (const [, b] of bindings) roots.set(b.rootMessageId, (roots.get(b.rootMessageId) ?? 0) + 1);
    for (const [key, b] of bindings) {
      if (roots.get(b.rootMessageId) !== 1 || !externalCodexBridge?.owns(b.rootMessageId, appId)) continue;
      threads.push({ key, title: b.firstUserMessage ?? b.threadId, bot, threadId: b.threadId, cwd: b.cwd, kind: 'native', path: b.rolloutPath, rootMessageId: b.rootMessageId, chatId: b.chatId, ownerOpenId: b.ownerOpenId });
    }
  }
  return threads;
}
/** Loopback IPC only, like the existing dashboard. No arbitrary paths or
 * external URLs accepted. Every operation resolves the owning bot anew. */
export function registerCodexSyncApi(appId: string, route: Route,
  json: (res: ServerResponse, status: number, value: unknown) => void,
  body: (req: IncomingMessage) => Promise<any>): void {
  const receiptDir = join(config.session.dataDir, 'codex-sync-receipts');
  const receiptPath = (key: string, id: string) => join(receiptDir,
    createHash('sha256').update(`${appId}:${key}:${id}`).digest('hex') + '.json');
  const mirrors = new Set<string>(), mirroring = new Set<string>();
  const flushMirror = async (file: string) => {
    if (mirroring.has(file)) return;
    mirroring.add(file);
    try {
      const saved = JSON.parse(readFileSync(file, 'utf8'));
      if (saved.appId !== appId || !saved.mirror || saved.mirrored || saved.status !== 'accepted') { mirrors.delete(file); return; }
      if (saved.binding) {
        const current = codexSyncThreads(appId).find(t => t.key === saved.binding.key);
        if (!current || current.threadId !== saved.binding.threadId
          || current.rootMessageId !== saved.mirror.rootMessageId) return;
      }
      await replyMessage(appId, saved.mirror.rootMessageId, `【VS Code 追问】\n${saved.mirror.text}`, 'text', true, saved.mirror.uuid);
      const latest = JSON.parse(readFileSync(file, 'utf8'));
      atomicWriteFileSync(file, JSON.stringify({ ...latest, mirrored: true }), { mode: 0o600 }); mirrors.delete(file);
    } catch (error) { logger.debug(`[codex-sync] question mirror will retry: ${String(error)}`); }
    finally { mirroring.delete(file); }
  };
  if (existsSync(receiptDir)) for (const name of readdirSync(receiptDir)) {
    if (!name.endsWith('.json')) continue;
    const file = join(receiptDir, name);
    try { const saved = JSON.parse(readFileSync(file, 'utf8')); if (saved.appId === appId && saved.mirror && !saved.mirrored && saved.status === 'accepted') mirrors.add(file); } catch { /* isolated receipt */ }
  }
  const mirrorTimer = setInterval(() => { for (const file of mirrors) void flushMirror(file); }, 5000); mirrorTimer.unref();
  route('GET', '/api/codex-sync/threads', (_req, res) => {
    json(res, 200, { threads: codexSyncThreads(appId).map(({ path, ownerOpenId, ...thread }) => thread) });
  });
  route('GET', '/api/codex-sync/:key/events', (req, res, params) => {
    try {
      const thread = codexSyncThreads(appId).find(t => t.key === params.key);
      if (!thread) return json(res, 404, { error: 'thread_not_found' });
      const runtime = thread.kind === 'bot' ? readSessionModelRuntime(config.session.dataDir, thread.key) : undefined;
      const running = thread.kind === 'bot' ? modelRuntimeAlive(runtime) && runtime?.phase === 'running' : externalCodexBridge?.isBusy(thread.rootMessageId, appId);
      const cursor = Number(new URL(req.url!, 'http://localhost').searchParams.get('cursor') ?? '0');
      if (!Number.isSafeInteger(cursor) || cursor < 0) return json(res, 400, { error: 'invalid_cursor' });
      const sync = thread.kind === 'native' ? externalCodexBridge?.followupStatus(thread.rootMessageId, appId) :
        { phase: running ? 'running' : 'idle', running: !!running, queued: 0 };
      if (!thread.path) return json(res, 200, { events: [], cursor: 0, source: thread.threadId, waiting: true, sync });
      json(res, 200, { ...readCodexSyncEvents(thread.path, cursor), source: thread.threadId, sync,
        statistics: readCodexSessionStatistics(thread.path, Date.now(), running), createdAt: thread.createdAt });
    } catch (e) { json(res, 503, { error: e instanceof Error ? e.message : String(e) }); }
  });
  route('GET', '/api/codex-sync/:key/receipt', (req, res, params) => {
    const requestId = new URL(req.url!, 'http://localhost').searchParams.get('requestId') ?? '';
    if (!/^[\w-]{8,100}$/.test(requestId)) return json(res, 400, { error: 'invalid_request_id' });
    const thread = codexSyncThreads(appId).find(t => t.key === params.key);
    if (!thread) return json(res, 404, { error: 'thread_not_found' });
    const file = receiptPath(params.key, requestId);
    if (!existsSync(file)) return json(res, 200, { status: 'missing' });
    const saved = JSON.parse(readFileSync(file, 'utf8'));
    const accepted = saved.status === 'accepted' || (thread.kind === 'native' &&
      externalCodexBridge?.hasReceived(thread.rootMessageId, appId, `ide-${requestId}`));
    json(res, 200, { status: accepted ? 'accepted' : 'uncertain', mirrored: saved.mirrored === true });
  });
  const queues = new Map<string, Promise<void>>();
  route('POST', '/api/codex-sync/:key/input', async (req, res, params) => {
    let input: any;
    try { input = await body(req); } catch { return json(res, 400, { error: 'invalid_json' }); }
    if (typeof input.text !== 'string' || !input.text.trim() || input.text.length > 100_000 || !/^[\w-]{8,100}$/.test(input.requestId ?? '')) return json(res, 400, { error: 'invalid_input' });
    const expected = input.expectedBinding;
    if (expected !== undefined && (typeof expected?.threadId !== 'string' || !expected.threadId
      || typeof expected?.rootMessageId !== 'string' || !expected.rootMessageId)) {
      return json(res, 400, { error: 'invalid_expected_binding' });
    }
    const previous = queues.get(params.key) ?? Promise.resolve();
    const operation = previous.catch(() => {}).then(async () => {
      const thread = codexSyncThreads(appId).find(t => t.key === params.key);
      if (!thread) return json(res, 404, { error: 'thread_not_found' });
      if (expected && (thread.threadId !== expected.threadId || thread.rootMessageId !== expected.rootMessageId)) {
        return json(res, 409, { error: 'binding_mismatch' });
      }
      const dir = receiptDir; mkdirSync(dir, { recursive: true, mode: 0o700 });
      const file = receiptPath(params.key, input.requestId);
      const fingerprint = createHash('sha256').update(input.text).digest('hex');
      if (existsSync(file)) {
        const saved = JSON.parse(readFileSync(file, 'utf8'));
        if (saved.fingerprint !== fingerprint) return json(res, 409, { ok: false, status: 'conflict', duplicate: true });
        if (saved.status !== 'accepted' && thread.kind === 'native' &&
            externalCodexBridge?.hasReceived(thread.rootMessageId, appId, `ide-${input.requestId}`)) {
          atomicWriteFileSync(file, JSON.stringify({ ...saved, status: 'accepted' }), { mode: 0o600 });
          mirrors.add(file); void flushMirror(file);
          return json(res, 200, { ok: true, status: 'accepted', duplicate: true });
        }
        return json(res, saved.status === 'accepted' ? 200 : 409, { ok: saved.status === 'accepted', status: saved.status, duplicate: true });
      }
      const uuid = createHash('sha256').update(`${appId}:${params.key}:${input.requestId}`).digest('hex').slice(0, 32);
      const save = (status: string) => atomicWriteFileSync(file, JSON.stringify({ status, fingerprint, appId,
        ...(thread.kind === 'native' ? { binding: { key: thread.key, threadId: thread.threadId } } : {}),
        mirror: { rootMessageId: thread.rootMessageId, text: input.text, uuid }, mirrored: false }), { mode: 0o600 });
      // An uncertain delivery stays 'started', never automatically replayed.
      save('started');
      if (thread.kind === 'native') {
        const bridge = externalCodexBridge, messageId = `ide-${input.requestId}`;
        if (!bridge || !await bridge.receive(thread.rootMessageId, appId, thread.ownerOpenId!, messageId, input.text, thread.chatId)) throw new Error('bridge_unavailable');
        if (!bridge.hasReceived(thread.rootMessageId, appId, messageId)) throw new Error('binding_unavailable');
      } else {
        let ds = findActiveBySessionId(thread.key);
        if (!ds) {
          const registry = getActiveSessionsRegistry();
          if (!registry) throw new Error('daemon_not_ready');
          const restored = await reconcileActiveSessionRegistry(thread.key, registry);
          if (!restored.ok) throw new Error('session_unavailable');
          ds = restored.ds;
        }
        if (ds.larkAppId !== appId) throw new Error('wrong_bot');
        const wrapped = buildFollowUpContent(input.text, thread.key, { cliId: 'codex-app', larkAppId: appId, chatId: thread.chatId });
        markSessionActivity(ds);
        rememberLastCliInput(ds, input.text, wrapped);
        await sendSessionInput(ds, { type: 'message', content: wrapped });
      }
      // Lark latency must never delay the model or the IDE acknowledgement.
      // Persist its mirror separately; retry with the same provider UUID.
      save('accepted'); mirrors.add(file); void flushMirror(file);
      json(res, 200, { ok: true, status: 'accepted' });
    });
    queues.set(params.key, operation);
    try { await operation; } catch (e) { json(res, 409, { error: e instanceof Error ? e.message : String(e), status: 'uncertain' }); }
    finally { if (queues.get(params.key) === operation) queues.delete(params.key); }
  });
}
