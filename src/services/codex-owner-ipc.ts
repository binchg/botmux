import { connect, type Socket } from 'node:net';
import { randomUUID } from 'node:crypto';
import { existsSync, lstatSync } from 'node:fs';
import { join } from 'node:path';

/** Submit through the IDE that already owns the thread; never steal its writer. */
export async function submitToCodexOwner(home: string, threadId: string, text: string, checkpoint: (submitted?: boolean) => void, clientUserMessageId?: string): Promise<boolean> {
  const path = join(home, 'ipc', 'ipc.sock');
  if (!existsSync(path)) return false;
  const stat = lstatSync(path);
  if (!stat.isSocket() || stat.uid !== process.getuid?.() || (stat.mode & 0o077)) return false;
  const client = new OwnerIpc(path);
  try {
    try { await client.open(); }
    catch (error) {
      if (['ENOENT', 'ECONNREFUSED'].includes((error as NodeJS.ErrnoException).code ?? '')) return false;
      throw error;
    }
    await client.request('initialize', { clientType: 'botmux' });
    const owner = await client.request('thread-owner-discovery', { hostId: 'local', conversationId: threadId }, 1);
    if (owner.resultType === 'error' && owner.error === 'no-client-found') return false;
    if (owner.resultType !== 'success') throw new Error(`Codex owner discovery: ${owner.error}`);
    checkpoint(); // After this boundary an unknown result must never be replayed.
    const result = await client.request('thread-follower-start-turn', {
      conversationId: threadId,
      turnStart: {
        request: { threadId, input: [{ type: 'text', text, text_elements: [] }], clientUserMessageId: clientUserMessageId ?? randomUUID() },
        context: { inheritThreadSettings: true, useAppServerPermissionDefault: true, useAppServerServiceTierDefault: true },
      },
    }, 2, owner.handledByClientId);
    if (result.resultType === 'error' && result.error === 'no-client-found') {
      // The router explicitly rejected delivery after the IDE disconnected.
      // This is a known non-submission, unlike a timeout/unknown result.
      checkpoint(false);
      return false;
    }
    if (result.resultType !== 'success') throw new Error(`Codex owner submission: ${result.error}`);
    return true;
  } finally { client.close(); }
}

class OwnerIpc {
  private socket?: Socket;
  private buffer = Buffer.alloc(0);
  private pending = new Map<string, { resolve: (message: any) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }>();
  constructor(private path: string) {}
  async open(): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      const socket = this.socket = connect(this.path);
      const timer = setTimeout(() => { socket.destroy(); reject(new Error('Codex owner connection timed out')); }, 5000);
      socket.once('connect', () => { clearTimeout(timer); resolve(); });
      socket.on('error', error => { clearTimeout(timer); reject(error); this.fail(error); });
      socket.on('close', () => this.fail(new Error('Codex owner connection closed')));
      socket.on('data', data => {
        this.buffer = Buffer.concat([this.buffer, data]);
        while (this.buffer.length >= 4) {
          const length = this.buffer.readUInt32LE(0);
          if (!length || length > 16 * 1024 * 1024) { this.fail(new Error('Invalid Codex IPC frame')); socket.destroy(); return; }
          if (this.buffer.length < length + 4) return;
          let message: any;
          try { message = JSON.parse(this.buffer.subarray(4, length + 4).toString('utf8')); }
          catch { this.fail(new Error('Invalid Codex IPC JSON')); socket.destroy(); return; }
          this.buffer = this.buffer.subarray(length + 4);
          if (message.type !== 'response') continue;
          const request = this.pending.get(message.requestId);
          if (request) { clearTimeout(request.timer); this.pending.delete(message.requestId); request.resolve(message); }
        }
      });
    });
  }
  request(method: string, params: unknown, version?: number, targetClientId?: string): Promise<any> {
    return new Promise((resolve, reject) => {
      const requestId = randomUUID();
      const timer = setTimeout(() => { this.pending.delete(requestId); reject(new Error(`Codex IPC ${method} timed out; outcome may be unknown`)); }, 15000);
      this.pending.set(requestId, { resolve, reject, timer });
      const data = Buffer.from(JSON.stringify({ type: 'request', requestId, method, params, version, targetClientId, timeoutMs: 12000 }));
      const header = Buffer.alloc(4); header.writeUInt32LE(data.length);
      this.socket!.write(Buffer.concat([header, data]));
    });
  }
  private fail(error: Error): void {
    for (const request of this.pending.values()) { clearTimeout(request.timer); request.reject(error); }
    this.pending.clear();
  }
  close(): void { this.socket?.destroy(); }
}
