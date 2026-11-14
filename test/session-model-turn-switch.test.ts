import { expect, it, vi } from 'vitest';
import { makeTurn } from '../src/services/app-runner-protocol.js';
import { SessionModelTurnSwitch } from '../src/services/session-model-turn-switch.js';

/** 取消优先于已排队的接续，重复完成事件只能中断一次。 */
it.each(['cancel', 'complete'])('工具执行期间的模型切换：%s', async mode => {
  const turn = makeTurn(); turn.turnId = 'turn'; turn.toolItems = new Set(['write']);
  const enqueue = vi.fn(), interrupt = vi.fn(async () => {}), removeQueued = vi.fn();
  const transition = new SessionModelTurnSwitch({ active: () => turn, processing: () => true,
    currentContent: () => 'original', reconfiguring: vi.fn(), abortAdmission: vi.fn(),
    enqueue, removeQueued, interrupt, notice: vi.fn() });
  transition.schedule('set model and continue');
  expect(enqueue).toHaveBeenCalledWith('set model and continue');
  expect(interrupt).not.toHaveBeenCalled();
  const check = turn.modelSwitchCheck!;
  if (mode === 'cancel') transition.cancel();
  turn.toolItems.clear(); check(); check();
  if (mode === 'cancel') {
    await Promise.resolve();
    expect(interrupt).not.toHaveBeenCalled();
    expect(removeQueued).toHaveBeenCalledWith('set model and continue');
  } else {
    await vi.waitFor(() => expect(interrupt).toHaveBeenCalledTimes(1));
    check(); await Promise.resolve(); expect(interrupt).toHaveBeenCalledTimes(1);
  }
});
