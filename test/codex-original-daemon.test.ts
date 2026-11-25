import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createServer } from 'node:http';
import { WebSocketServer } from 'ws';
import { expect, it, vi } from 'vitest';
import { readOriginalCodexQuota, submitToOriginalCodexDaemon } from '../src/services/codex-original-daemon.js';

it('submits only the verified original and leaves it queued while the daemon reports active', async () => {
  const home = mkdtempSync(join(tmpdir(), 'codex-durable-'));
  const control = join(home, 'app-server-control');
  mkdirSync(control);
  const path = join(control, 'app-server-control.sock');
  const original = join(home, 'original.jsonl');
  const alternate = join(home, 'alternate.jsonl');
  writeFileSync(original, '');
  writeFileSync(alternate, '');
  const http = createServer();
  const transport = new WebSocketServer({ server: http });
  const requests: Array<{method:string;params:any}> = [];
  let actualPath = alternate;
  let status = 'notLoaded';
  let endBeforeSteering = false;
  transport.on('connection', socket => socket.on('message', bytes => {
    const req = JSON.parse(bytes.toString());
    if (req.id === undefined) return;
    requests.push(req);
    if (req.method === 'thread/resume') status = 'idle';
    if (req.method === 'turn/steer' && endBeforeSteering) {
      status = 'idle';
      socket.send(JSON.stringify({ id: req.id, error: { code: -32602, message: 'no active turn to steer' } }));
      return;
    }
    const result = req.method === 'turn/start' ? { turn: { id: 'new-turn' } } :
      req.method === 'thread/turns/list' ? { data: [{ id: 'active-turn', status: 'inProgress' }] } :
      req.method === 'turn/steer' ? { turnId: 'active-turn' } :
      req.method === 'account/rateLimits/read' ? { rateLimits: { primary: { usedPercent: 7, windowDurationMins: 300 } } } :
      { thread: { id: 'original', path: actualPath, status: { type: status } } };
    socket.send(JSON.stringify({ id: req.id, result }));
  }));
  await new Promise<void>(resolve => http.listen(path, resolve));
  chmodSync(path, 0o600);
  const checkpoint = vi.fn();
  try {
    expect(await submitToOriginalCodexDaemon(home, 'original', original, 'question', checkpoint, 'exact-receipt')).toBe(false);
    expect(checkpoint).not.toHaveBeenCalled();
    actualPath = original;
    status = 'active';
    await expect(submitToOriginalCodexDaemon(home, 'original', original, 'question', checkpoint)).rejects.toThrow('not idle');
    expect(checkpoint).not.toHaveBeenCalled();
    status = 'notLoaded';
    expect(await submitToOriginalCodexDaemon(home, 'original', original, 'question', checkpoint, 'exact-receipt')).toBe(true);
    expect(checkpoint.mock.calls).toEqual([[], [true, 'new-turn']]);
    expect(requests.filter(row => row.method === 'turn/start').map(row => row.params.clientUserMessageId)).toEqual(['exact-receipt']);
    status = 'active';
    checkpoint.mockClear();
    expect(await submitToOriginalCodexDaemon(home, 'original', original, 'follow up', checkpoint, 'steer-receipt', true)).toBe(true);
    expect(requests.at(-1)).toMatchObject({ method: 'turn/steer', params: {
      threadId: 'original', expectedTurnId: 'active-turn', clientUserMessageId: 'steer-receipt' } });
    expect(checkpoint.mock.calls).toEqual([[], [true, 'active-turn']]);
    endBeforeSteering = true;
    checkpoint.mockClear();
    expect(await submitToOriginalCodexDaemon(home, 'original', original, 'ended', checkpoint, 'raced-receipt', true)).toBe(false);
    expect(checkpoint.mock.calls).toEqual([[], [false, undefined]]);
    expect(await submitToOriginalCodexDaemon(home, 'original', original, 'ended', checkpoint, 'raced-receipt', true)).toBe(true);
    expect(requests.at(-1)).toMatchObject({ method: 'turn/start', params: { clientUserMessageId: 'raced-receipt' } });
    const beforeQuota = requests.length;
    expect(await readOriginalCodexQuota(home)).toEqual([{ window: 'primary', durationMinutes: 300, remainingPercent: 93 }]);
    expect(requests.slice(beforeQuota).map(r => r.method)).toEqual(['initialize', 'account/rateLimits/read']);
    expect(requests.some(row => row.method === 'thread/fork')).toBe(false);
  } finally {
    for (const socket of transport.clients) socket.terminate();
    transport.close();
    await new Promise<void>(resolve => http.close(() => resolve()));
    rmSync(home, { recursive: true, force: true });
  }
});
