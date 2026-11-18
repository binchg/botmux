/** 准入期限只覆盖无活动阶段，且必须确认旧轮次中断后才能允许降级。 */
import { afterEach, expect, it, vi } from 'vitest';
import { waitForMixedTurn } from '../src/services/mixed-model-admission.js';
import { makeTurn } from '../src/services/app-runner-protocol.js';
import type { AppServerClient } from '../src/services/app-runner-client.js';

afterEach(() => vi.useRealTimers());
it('明确无进展并已中断才允许降级，状态仍标为未知排队', async () => {
  vi.useFakeTimers();
  const turn = makeTurn(); turn.turnId = 'turn';
  const request = vi.fn(async () => { turn.resolveDone(); return {}; });
  const promise = waitForMixedTurn(turn, { request } as unknown as AppServerClient, 'thread', () => true, 1000);
  const checked = expect(promise).rejects.toMatchObject({ reason: 'no_progress_timeout' });
  await vi.advanceTimersByTimeAsync(1000); await checked;
  expect(request).toHaveBeenCalledWith('turn/interrupt', { threadId: 'thread', turnId: 'turn' });
});

it.each(['activity', 'tool'])('%s 已发生后不为测速中断当前任务', async kind => {
  vi.useFakeTimers();
  const turn = makeTurn(), request = vi.fn();
  if (kind === 'activity') turn.adaptiveActivityAt = 1;
  const promise = waitForMixedTurn(turn, { request } as unknown as AppServerClient, 'thread', () => kind !== 'tool', 1000);
  await vi.advanceTimersByTimeAsync(2000);
  expect(request).not.toHaveBeenCalled();
  turn.resolveDone(); await promise;
});

it('中断未确认时终止，不将仍活跃的旧请求重放到其它通道', async () => {
  vi.useFakeTimers();
  const turn = makeTurn(), request = vi.fn(() => new Promise(() => {}));
  const promise = waitForMixedTurn(turn, { request } as unknown as AppServerClient, 'thread', () => true, 1000);
  const checked = expect(promise).rejects.toThrow('尚未确认中断');
  await vi.advanceTimersByTimeAsync(6000); await checked;
});
