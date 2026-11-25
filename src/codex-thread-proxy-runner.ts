import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, unlinkSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { CodexThreadProxy, validProxyRequestId, type ProxyThread } from './services/codex-thread-proxy.js';
import { codexThreadProxySocket } from './services/codex-thread-proxy-client.js';
import { readCodexSyncEvents } from './services/codex-sync-reader.js';
import { readCodexSessionStatistics } from './services/codex-session-statistics.js';

const configPath = process.argv[2] ?? join(homedir(), '.config/botmux/codex-thread-proxy.json');
const socket = process.argv[3] ?? codexThreadProxySocket();
const statePath = process.argv[4] ?? join(homedir(), '.local/state/botmux/codex-thread-proxy-receipts.json');
const spec: ProxyThread[] = JSON.parse(readFileSync(configPath, 'utf8')).threads;
if (!Array.isArray(spec) || spec.some(thread => !thread.threadId || !thread.rolloutPath || !thread.codexHome || !thread.title) ||
    new Set(spec.map(thread => thread.threadId)).size !== spec.length) throw new Error('Invalid process proxy thread configuration');
mkdirSync(dirname(socket), { recursive: true, mode: 0o700 });
mkdirSync(dirname(statePath), { recursive: true, mode: 0o700 });
const proxy = new CodexThreadProxy(spec, statePath);
function json(res: ServerResponse, code: number, value: unknown) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(value));
}
async function body(req: IncomingMessage, maxBytes = 750_000): Promise<any> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > maxBytes) throw new Error('Proxy input exceeds size limit');
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url ?? '/', 'http://localhost');
    if (req.method === 'GET' && url.pathname === '/api/codex-sync/threads') {
      return json(res, 200, { threads: proxy.threads.map(thread => ({
        key: thread.threadId, title: thread.title, bot: thread.bot, threadId: thread.threadId, cwd: thread.cwd, kind: 'native',
      })) });
    }
    const match = /^\/api\/codex-sync\/([\w-]+)\/(events|receipt|input|native-start)$/.exec(url.pathname);
    const thread = match && proxy.thread(match[1]);
    if (!thread) return json(res, 404, { error: 'thread_not_found' });
    const id = thread.threadId;
    if (req.method === 'GET' && match![2] === 'events') {
      const cursor = Number(url.searchParams.get('cursor') ?? '0');
      if (!Number.isSafeInteger(cursor) || cursor < 0) return json(res, 400, { error: 'invalid_cursor' });
      const sync = proxy.status(id);
      return json(res, 200, { ...readCodexSyncEvents(thread.rolloutPath, cursor), source: id,
        sync, statistics: readCodexSessionStatistics(thread.rolloutPath, Date.now(), sync.running) });
    }
    if (req.method === 'GET' && match![2] === 'receipt') {
      const reqId = url.searchParams.get('requestId');
      if (!validProxyRequestId(reqId)) return json(res, 400, { error: 'invalid_request_id' });
      return json(res, 200, proxy.receipt(id, reqId));
    }
    if (req.method === 'POST' && match![2] === 'native-start') {
      const input = await body(req, 32 * 1024 * 1024);
      if (!validProxyRequestId(input?.requestId) || input.params?.threadId !== id || !Array.isArray(input.params?.input)) {
        return json(res, 400, { error: 'invalid_native_turn' });
      }
      const result = proxy.enqueueNative(id, input.requestId, input.params);
      if (result.conflict) return json(res, 409, { error: 'request_fingerprint_conflict' });
      json(res, 200, result);
      void proxy.tick();
      return;
    }
    if (req.method === 'POST' && match![2] === 'input') {
      const input = await body(req);
      if (!validProxyRequestId(input?.requestId) || typeof input.text !== 'string' || !input.text.trim() || input.text.length > 100_000) {
        return json(res, 400, { error: 'invalid_input' });
      }
      const result = proxy.enqueue(id, input.requestId, input.text);
      if (result.conflict) return json(res, 409, { error: 'request_fingerprint_conflict' });
      json(res, 200, result);
      void proxy.tick();
      return;
    }
    json(res, 405, { error: 'method_not_allowed' });
  } catch {
    if (!res.headersSent) json(res, 503, { error: 'process_proxy_unavailable' });
    else res.end();
  }
});
const activated = String(process.pid) === process.env.LISTEN_PID && process.env.LISTEN_FDS === '1';
if (!activated && existsSync(socket)) {
  const st = lstatSync(socket);
  if (!st.isSocket() || st.uid !== process.getuid?.()) throw new Error('Refusing to replace process proxy socket');
}
server.listen(activated ? { fd: 3 } : socket, () => {
  if (!activated) chmodSync(socket, 0o600);
  console.log(`Codex process proxy ready with ${spec.length} thread(s)`);
});
const timer = setInterval(() => void proxy.tick(), 1000);
function close() {
  clearInterval(timer);
  server.close(() => {
    if (!activated && existsSync(socket)) unlinkSync(socket);
    process.exit(0);
  });
}
process.once('SIGTERM', close);
process.once('SIGINT', close);
