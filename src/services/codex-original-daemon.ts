import { realpathSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import WebSocket from 'ws';
import type { FollowupCheckpoint } from './external-codex-bridge.js';

interface OriginalThread {
  id?: string;
  path?: string;
  status?: { type?: string };
}

class CodexRpcError extends Error {}

export function sameOriginalThread(value: OriginalThread | undefined, threadId: string, rolloutPath: string): boolean {
  return value?.id === threadId && typeof value.path === 'string' &&
    realpathSync(value.path) === realpathSync(rolloutPath);
}

class DurableCodexConnection {
  private nextId = 1;

  constructor(private socket: WebSocket) {}

  request(method: string, params: object, timeoutMs = 8000): Promise<any> {
    return new Promise((resolve, reject) => {
      const id = this.nextId++;
      const dispose = () => {
        clearTimeout(timer);
        this.socket.off('message', onMessage);
        this.socket.off('close', onClose);
      };
      const onClose = () => { dispose(); reject(new Error('Codex durable connection closed')); };
      const onMessage = (data: WebSocket.RawData) => {
        let response: any;
        try { response = JSON.parse(data.toString()); } catch { return; }
        if (response.id !== id) return;
        dispose();
        if (response.error) reject(new CodexRpcError(`Codex durable ${method}: ${response.error.message ?? 'request rejected'}`));
        else resolve(response.result);
      };
      const timer = setTimeout(() => { dispose(); reject(new Error(`Codex durable ${method} timed out`)); }, timeoutMs);
      this.socket.on('message', onMessage);
      this.socket.once('close', onClose);
      this.socket.send(JSON.stringify({ id, method, params }), error => {
        if (error) { dispose(); reject(error); }
      });
    });
  }

  notify(method: string): void {
    this.socket.send(JSON.stringify({ method }));
  }
}

/** Reuse the official per-library daemon for an explicitly authorized original. */
export async function submitToOriginalCodexDaemon(home: string, threadId: string, rolloutPath: string, text: string,
  checkpoint: FollowupCheckpoint, clientUserMessageId?: string, steer = false): Promise<boolean> {
  return submitNativeTurnToOriginalCodexDaemon(home, threadId, rolloutPath,
    { threadId, input: [{ type: 'text', text, text_elements: [] }], clientUserMessageId: clientUserMessageId ?? randomUUID() },
    (submitted, turnId) => submitted === undefined ? checkpoint() : checkpoint(submitted, turnId), steer);
}

export async function submitNativeTurnToOriginalCodexDaemon(home: string, threadId: string, rolloutPath: string,
  params: Record<string, unknown>, checkpoint: (submitted?: boolean, turnId?: string, result?: unknown) => void, steer = false): Promise<boolean> {
  if (params.threadId !== threadId || !Array.isArray(params.input) || typeof params.clientUserMessageId !== 'string') return false;
  let path: string;
  try {
    path = realpathSync(join(home, 'app-server-control', 'app-server-control.sock'));
    const stat = statSync(path);
    if (!stat.isSocket() || stat.uid !== process.getuid?.() || (stat.mode & 0o077)) return false;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
  const socket = new WebSocket(`ws+unix://${path}:/`, { handshakeTimeout: 4000 });
  socket.on('error', () => {});
  try {
    await new Promise<void>((resolve, reject) => {
      socket.once('open', resolve);
      socket.once('error', reject);
    });
    const client = new DurableCodexConnection(socket);
    await client.request('initialize', {
      clientInfo: { name: 'botmux-original-thread', version: '1.0' },
      capabilities: { experimentalApi: true },
    });
    client.notify('initialized');
    const read = await client.request('thread/read', { threadId, includeTurns: false });
    if (!sameOriginalThread(read?.thread, threadId, rolloutPath)) return false;
    let status = read.thread.status?.type;
    if (status === 'notLoaded') {
      const resumed = await client.request('thread/resume', { threadId, excludeTurns: true, persistExtendedHistory: true }, 45_000);
      if (!sameOriginalThread(resumed?.thread, threadId, rolloutPath)) return false;
      status = resumed.thread.status?.type;
    }
    if (steer && status === 'active') {
      const latest = await client.request('thread/turns/list', { threadId, limit: 1, itemsView: 'notLoaded' });
      const active = latest?.data?.[0];
      if (active?.status !== 'inProgress' || typeof active.id !== 'string') return false;
      checkpoint();
      try {
        const result = await client.request('turn/steer', {
          threadId, expectedTurnId: active.id, input: params.input, clientUserMessageId: params.clientUserMessageId,
        });
        if (result?.turnId !== active.id) throw new Error('Codex did not confirm the active turn');
        checkpoint(true, active.id, result);
        return true;
      } catch (error) {
        // A precondition rejection guarantees this input did not enter the turn.
        if (error instanceof CodexRpcError && /no active turn to steer|expected active turn id/i.test(error.message)) {
          checkpoint(false);
          return false;
        }
        throw error;
      }
    }
    if (status !== 'idle') throw new Error('Codex original thread is not idle; follow-up retained');
    checkpoint();
    const started = await client.request('turn/start', params, 90_000);
    if (typeof started?.turn?.id !== 'string') throw new Error('Codex did not confirm the original turn; follow-up retained');
    checkpoint(true, started.turn.id, started);
    return true;
  } finally { socket.close(); }
}
