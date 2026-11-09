import { afterEach, expect, it, vi } from 'vitest';
import { forkWorker } from '../src/core/worker-pool.js';
import { sendSessionInput } from '../src/core/session-working-dir-runtime.js';
import type { DaemonSession } from '../src/core/types.js';

vi.mock('../src/core/session-working-dir-runtime.js', () => ({ sendSessionInput: vi.fn(async () => undefined) }));
afterEach(() => vi.clearAllMocks());

/** 直接验证生产 fork 入口的切换锁，覆盖调用方误走冷分支的兜底边界。 */
function switching(): DaemonSession {
  return { session: { sessionId: 'owned', pendingWorkingDir: '/synthetic/target' },
    worker: null, workingDirSwitchInFlight: true } as unknown as DaemonSession;
}

it('等待旧 worker 退出期间，冷分支输入交给统一队列，不直接 fork', () => {
  const ds = switching();
  forkWorker(ds, 'next input', true, 'turn-2');
  expect(sendSessionInput).toHaveBeenCalledExactlyOnceWith(ds, { type: 'message', content: 'next input', turnId: 'turn-2' });
  expect(ds.worker).toBeNull(); expect(ds.session.pendingWorkingDir).toBe('/synthetic/target');
});

it('旧调用形态的 turnId 也被保留，不丢输入归属', () => {
  const ds = switching(); forkWorker(ds, 'trigger input', 'trigger-turn');
  expect(sendSessionInput).toHaveBeenCalledExactlyOnceWith(ds, { type: 'message', content: 'trigger input', turnId: 'trigger-turn' });
});

it('失败的目录请求阻止带输入的冷分支静默回退旧目录', () => {
  const ds = switching(); ds.workingDirSwitchInFlight = undefined;
  ds.session.pendingWorkingDirError = 'invalid_target';
  expect(() => forkWorker(ds, 'next input', true)).toThrow('invalid_target');
  expect(sendSessionInput).not.toHaveBeenCalled(); expect(ds.worker).toBeNull();
});

it('恢复或终端重连的空 prompt 不抢先 fork、不额外产生新轮', () => {
  const ds = switching(); forkWorker(ds, '', true);
  expect(sendSessionInput).not.toHaveBeenCalled(); expect(ds.worker).toBeNull();
  expect(ds.session.pendingWorkingDir).toBe('/synthetic/target');
});
