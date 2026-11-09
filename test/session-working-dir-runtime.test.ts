import { EventEmitter } from 'node:events';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import * as sessions from '../src/services/session-store.js';
import { forkWorker, killWorker } from '../src/core/worker-pool.js';
import { sendSessionInput } from '../src/core/session-working-dir-runtime.js';
import { requestSessionWorkingDir } from '../src/core/session-working-dir.js';
import type { DaemonSession } from '../src/core/types.js';

vi.mock('../src/core/worker-pool.js', () => ({ forkWorker: vi.fn(), killWorker: vi.fn() }));

/** 用真实 EventEmitter 验证 exit 和 ready 边界，不启动真实 AI。 */
let dir: string, target: string;
beforeEach(() => {
  vi.mocked(forkWorker).mockReset();
  vi.mocked(killWorker).mockReset();
  dir = mkdtempSync(join(tmpdir(), 'botmux-cwd-runtime-'));
  target = join(dir, 'target'); mkdirSync(target);
  vi.spyOn(sessions, 'updateSession').mockImplementation(() => undefined);
});
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); rmSync(dir, { recursive: true, force: true }); });

/** 保留真实 ChildProcess 的进程属性，独立触发退出和就绪事件。 */
function worker() {
  return Object.assign(new EventEmitter(), { killed: false, exitCode: null, signalCode: null, send: vi.fn() });
}
/** 已就绪与尚在启动的运行器使用显式不同端口状态。 */
function session(ready = true) {
  return { session: { sessionId: 'owned', larkAppId: 'bot', status: 'active', workingDir: dir },
    workingDir: dir, worker: worker(), workerPort: ready ? 7789 : null,
    lastScreenStatus: ready ? 'idle' : 'starting', hasHistory: true } as unknown as DaemonSession;
}
const message = { type: 'message' as const, content: 'next', turnId: 'turn-2' };

/** 等待监听器注册，不用固定 sleep 假定异步投递已经开始。 */
async function waitingReady(w: ReturnType<typeof worker>) {
  await vi.waitFor(() => expect(w.listenerCount('message')).toBe(1));
}
/** 模拟 worker 的 ready 消息，同时更新入口维护的真实端口。 */
function ready(ds: DaemonSession, w: ReturnType<typeof worker>) {
  ds.workerPort = 7790;
  w.emit('message', { type: 'ready', port: 7790, token: 'test' });
}

it('已就绪且无目录请求时保持原 IPC 投递，不触发进程操作', async () => {
  const ds = session(), old = ds.worker!;
  await sendSessionInput(ds, message);
  expect(old.send).toHaveBeenCalledExactlyOnceWith(message);
  expect(killWorker).not.toHaveBeenCalled(); expect(forkWorker).not.toHaveBeenCalled();
});

it('旧 worker 真正 exit 后才 fork，并用 init 携带首条内容和原始 turnId', async () => {
  const ds = session(), old = ds.worker!, next = worker();
  requestSessionWorkingDir(ds.session, ds, { workingDir: target });
  let started!: () => void;
  const stopped = new Promise<void>(resolve => { started = resolve; });
  vi.mocked(killWorker).mockImplementation(() => { ds.worker = null; ds.workerPort = null; started(); });
  vi.mocked(forkWorker).mockImplementation(() => { ds.worker = next as any; });
  const flight = sendSessionInput(ds, message);
  await stopped;
  expect(forkWorker).not.toHaveBeenCalled(); expect(next.send).not.toHaveBeenCalled();
  old.emit('exit', 0, null); await flight;
  expect(forkWorker).toHaveBeenCalledExactlyOnceWith(ds, message.content, true, message.turnId);
  expect(next.send).not.toHaveBeenCalled();
  expect(ds.workingDir).toBe(target); expect(ds.session.sessionId).toBe('owned');
  expect(old.listenerCount('exit')).toBe(0);
});

it('没有运行器时也通过 init 投递触发输入，不额外发送 message', async () => {
  const ds = session(false), next = worker(); ds.worker = null;
  vi.mocked(forkWorker).mockImplementation(() => { ds.worker = next as any; });
  await sendSessionInput(ds, message);
  expect(forkWorker).toHaveBeenCalledExactlyOnceWith(ds, message.content, true, message.turnId);
  expect(next.send).not.toHaveBeenCalled(); expect(killWorker).not.toHaveBeenCalled();
});

it('尚在启动的运行器等真实 ready 后才投递一次，不把输入丢在初始化窗口', async () => {
  const ds = session(false), current = ds.worker as unknown as ReturnType<typeof worker>;
  const flight = sendSessionInput(ds, message);
  await waitingReady(current);
  expect(current.send).not.toHaveBeenCalled();
  current.emit('message', { type: 'screen_update', status: 'starting' });
  expect(current.send).not.toHaveBeenCalled();
  ready(ds, current); await flight;
  current.emit('message', { type: 'ready', port: 7790 });
  expect(current.send).toHaveBeenCalledExactlyOnceWith(message);
  expect(current.listenerCount('message')).toBe(0); expect(current.listenerCount('exit')).toBe(0);
  expect(forkWorker).not.toHaveBeenCalled();
});

it('切目录触发输入走 init，并发追问等新 worker 就绪后才发送', async () => {
  const ds = session(), old = ds.worker!, next = worker();
  requestSessionWorkingDir(ds.session, ds, { workingDir: target });
  let started!: () => void;
  const stopped = new Promise<void>(resolve => { started = resolve; });
  vi.mocked(killWorker).mockImplementation(() => { ds.worker = null; ds.workerPort = null; started(); });
  vi.mocked(forkWorker).mockImplementation(() => { ds.worker = next as any; });
  const first = sendSessionInput(ds, message);
  await stopped;
  const followUp = { ...message, content: 'follow-up', turnId: 'turn-3' };
  const second = sendSessionInput(ds, followUp);
  old.emit('exit', 0, null); await first;
  await waitingReady(next);
  expect(forkWorker).toHaveBeenCalledExactlyOnceWith(ds, message.content, true, message.turnId);
  expect(next.send).not.toHaveBeenCalled();
  ready(ds, next); await second;
  expect(next.send).toHaveBeenCalledExactlyOnceWith(followUp);
  expect(next.listenerCount('message')).toBe(0); expect(next.listenerCount('exit')).toBe(0);
});

it('等待 ready 时 worker 退出立即失败，不发送输入并清理监听器', async () => {
  const ds = session(false), current = ds.worker as unknown as ReturnType<typeof worker>;
  const flight = sendSessionInput(ds, message);
  const rejected = expect(flight).rejects.toThrow('session_worker_exited_before_ready');
  await waitingReady(current);
  current.emit('exit', 1, null); await rejected;
  ready(ds, current);
  expect(current.send).not.toHaveBeenCalled();
  expect(current.listenerCount('message')).toBe(0); expect(current.listenerCount('exit')).toBe(0);
});

it('等待期间 worker 身份改变时拒绝旧 worker 的迟到 ready', async () => {
  const ds = session(false), current = ds.worker as unknown as ReturnType<typeof worker>, next = worker();
  const flight = sendSessionInput(ds, message);
  const rejected = expect(flight).rejects.toThrow('session_worker_changed');
  await waitingReady(current);
  ds.worker = next as any;
  current.emit('message', { type: 'ready', port: 7790 }); await rejected;
  expect(current.send).not.toHaveBeenCalled(); expect(next.send).not.toHaveBeenCalled();
  expect(current.listenerCount('message')).toBe(0); expect(current.listenerCount('exit')).toBe(0);
});

it('等待 ready 最长 30 秒，超时失败且不保留监听器', async () => {
  vi.useFakeTimers();
  const ds = session(false), current = ds.worker as unknown as ReturnType<typeof worker>;
  const flight = sendSessionInput(ds, message);
  const rejected = expect(flight).rejects.toThrow('session_worker_ready_timeout');
  await vi.advanceTimersByTimeAsync(30_000); await rejected;
  expect(current.send).not.toHaveBeenCalled();
  expect(current.listenerCount('message')).toBe(0); expect(current.listenerCount('exit')).toBe(0);
});

it('旧 worker 退出超时不启动新运行器，保留目录请求并清理监听器', async () => {
  vi.useFakeTimers();
  const ds = session(), old = ds.worker!;
  requestSessionWorkingDir(ds.session, ds, { workingDir: target });
  vi.mocked(killWorker).mockImplementation(() => { ds.worker = null; ds.workerPort = null; });
  const flight = sendSessionInput(ds, message);
  const rejected = expect(flight).rejects.toThrow('working_dir_worker_exit_timeout');
  await vi.advanceTimersByTimeAsync(10_000); await rejected;
  expect(forkWorker).not.toHaveBeenCalled(); expect(old.listenerCount('exit')).toBe(0);
  expect(ds.session.pendingWorkingDir).toBe(target); expect(ds.workingDir).toBe(dir);
});
