import { createInterface } from 'node:readline';
import { existsSync, realpathSync, statSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import WebSocket from 'ws';
import { codexThreadProxySocket, requestCodexThreadProxy } from './services/codex-thread-proxy-client.js';

type Rpc = { id?: string | number; method?: string; params?: Record<string, unknown> };

const home = homedir();
const control = realpathSync(join(home, '.codex/app-server-control/app-server-control.sock'));
const stat = statSync(control);
if (!stat.isSocket() || stat.uid !== process.getuid?.() || (stat.mode & 0o077)) {
  throw new Error('The 5090 Codex control socket is not private');
}
const configFile = join(home, '.config/botmux/codex-thread-proxy.json');
const routes = new Set<string>(existsSync(configFile)
  ? JSON.parse(readFileSync(configFile, 'utf8')).threads.map((thread: {threadId:string}) => thread.threadId)
  : []);
const socket = new WebSocket(`ws+unix://${control}:/`, { handshakeTimeout: 5000 });
socket.on('error', error => { process.stderr.write(`Codex 5090 connection: ${error.message}\n`); });
await new Promise<void>((resolve, reject) => {
  socket.once('open', resolve);
  socket.once('error', reject);
});
process.stderr.write('Codex IDE connected to the persistent Codex process on 5090.\n');

function write(value: unknown) {
  if (!process.stdout.destroyed) process.stdout.write(JSON.stringify(value) + '\n');
}

let going = true;
socket.on('message', bytes => {
  if (!process.stdout.destroyed) process.stdout.write(bytes.toString() + '\n');
});
socket.on('close', () => {
  going = false;
  process.stdin.destroy();
});
process.stdout.on('error', () => socket.terminate());

async function submit(rpc: Rpc, threadId: string): Promise<void> {
  const clientId = rpc.params?.clientUserMessageId;
  const requestId = typeof clientId === 'string' && /^[\w-]{8,100}$/.test(clientId) ? clientId : randomUUID();
  const prefix = `/api/codex-sync/${threadId}`;
  const socketPath = codexThreadProxySocket();
  try {
    let receipt = await requestCodexThreadProxy(socketPath, prefix + '/native-start',
      { requestId, params: rpc.params });
    const deadline = Date.now() + 15 * 60_000;
    while (going && Date.now() < deadline) {
      if (receipt.nativeResult !== undefined) {
        write({ id: rpc.id, result: receipt.nativeResult });
        return;
      }
      if (receipt.phase === 'aborted' || (receipt.phase === 'finished' && !receipt.nativeResult)) break;
      await delay(1000);
      receipt = await requestCodexThreadProxy(socketPath, prefix + '/receipt?requestId=' + encodeURIComponent(requestId));
    }
    if (going) write({ id: rpc.id, error: { code: -32000, message: '5090 retained your message. Open this chat again to check the original turn.' } });
  } catch {
    if (going) write({ id: rpc.id, error: { code: -32000, message: '5090 could not confirm this message. Check the original chat before retrying.' } });
  }
}

const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
try {
  for await (const line of lines) {
    if (!going || !line.trim()) continue;
    let rpc: Rpc;
    try { rpc = JSON.parse(line); } catch { continue; }
    const thread = rpc.params?.threadId;
    if (rpc.id !== undefined && rpc.method === 'turn/start' && typeof thread === 'string' && routes.has(thread)) {
      void submit(rpc, thread);
    } else {
      await new Promise<void>((resolve, reject) => socket.send(line, error => error ? reject(error) : resolve()));
    }
  }
} finally {
  going = false;
  lines.close();
  socket.close();
}
