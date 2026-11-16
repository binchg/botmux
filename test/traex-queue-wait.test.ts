/** 队列截止时间不随心跳延长，离队及进展必须撤销旧状态。 */
import { expect, it } from 'vitest';
import { TraexQueueWait } from '../src/services/traex-queue-wait.js';

it('短队列允许十秒准入，连续改善和心跳不会无限延长', () => {
  const wait = new TraexQueueWait();
  expect(wait.shouldDegrade({ id: 1, atMs: 1, position: 8 }, 0)).toBe(false);
  expect(wait.shouldDegrade({ id: 2, atMs: 2, position: 3 }, 9999)).toBe(false);
  expect(wait.shouldDegrade({ id: 3, atMs: 3, position: 1 }, 10000)).toBe(true);
  expect(wait.shouldDegrade(undefined, 10001)).toBe(false);
  expect(wait.shouldDegrade({ id: 4, atMs: 4, position: 1 }, 10002)).toBe(false);
});
it.each([{ position: 11 }, {}, { position: 1, quotaLowPriority: true }])('长队列和低优先级直接降级：%j', data => {
  expect(new TraexQueueWait().shouldDegrade({ id: 1, atMs: 1, ...data })).toBe(true);
});
