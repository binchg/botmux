import { it, expect } from 'vitest';
import { createServer } from 'node:net';
import { mkdtempSync, mkdirSync, chmodSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { submitToCodexOwner } from '../src/services/codex-owner-ipc.js';

async function fixture(owner = true, submissionError = false) {
  const home = mkdtempSync(join(tmpdir(), 'codex-owner-'));
  mkdirSync(join(home, 'ipc'));
  const path = join(home, 'ipc', 'ipc.sock');
  const requests: any[] = [];
  const server = createServer(socket => {
    let buffer = Buffer.alloc(0);
    socket.on('data', data => {
      buffer = Buffer.concat([buffer, data]);
      while (buffer.length >= 4 && buffer.length >= buffer.readUInt32LE(0) + 4) {
        const length = buffer.readUInt32LE(0);
        const request = JSON.parse(buffer.subarray(4, length + 4).toString());
        buffer = buffer.subarray(length + 4);
        requests.push(request);
        const error = request.method === 'thread-owner-discovery' && !owner ? 'no-client-found'
          : request.method === 'thread-follower-start-turn' && submissionError ? 'request-timeout' : undefined;
        const body = Buffer.from(JSON.stringify({ type: 'response', requestId: request.requestId,
          resultType: error ? 'error' : 'success', error, handledByClientId: 'ide-owner', result: { text: '中文' } }));
        const header = Buffer.alloc(4); header.writeUInt32LE(body.length);
        // Deliberately split both the header and the UTF-8 response body.
        const frame = Buffer.concat([header, body]);
        socket.write(frame.subarray(0, 2));
        socket.write(frame.subarray(2, frame.length - 4));
        socket.write(frame.subarray(frame.length - 4));
      }
    });
  });
  await new Promise<void>(resolve => server.listen(path, resolve));
  chmodSync(path, 0o600);
  return { home, requests, cleanup: async () => {
    await new Promise<void>(resolve => server.close(() => resolve()));
    rmSync(home, { recursive: true, force: true });
  } };
}

it('submits once to the discovered IDE owner and inherits existing thread settings', async () => {
  const f = await fixture(); let checkpoints = 0;
  try {
    expect(await submitToCodexOwner(f.home, 'fork', '只读验收', () => { checkpoints++; })).toBe(true);
    const request = f.requests[2];
    expect(request.method).toBe('thread-follower-start-turn');
    expect(request.targetClientId).toBe('ide-owner');
    expect(request.version).toBe(2);
    expect(request.params.turnStart.request.input).toEqual([{ type: 'text', text: '只读验收', text_elements: [] }]);
    expect(request.params.turnStart.context.inheritThreadSettings).toBe(true);
    expect(checkpoints).toBe(1);
  } finally { await f.cleanup(); }
});

it('allows ordinary app-server fallback only when no owner is found', async () => {
  const f = await fixture(false); let checkpoints = 0;
  try {
    expect(await submitToCodexOwner(f.home, 'fork', 'test', () => { checkpoints++; })).toBe(false);
    expect(f.requests).toHaveLength(2); expect(checkpoints).toBe(0);
  } finally { await f.cleanup(); }
});

it('retains the started boundary when owner submission has an uncertain outcome', async () => {
  const f = await fixture(true, true); let checkpoints = 0;
  try {
    await expect(submitToCodexOwner(f.home, 'fork', 'test', () => { checkpoints++; })).rejects.toThrow('request-timeout');
    expect(checkpoints).toBe(1); expect(f.requests).toHaveLength(3);
  } finally { await f.cleanup(); }
});
