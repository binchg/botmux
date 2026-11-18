/** 混合通道的无进展期限；超时只表示准入未确认，不能宣称服务端正在排队。 */
import type { ActiveTurn } from './app-runner-types.js';
import type { AppServerClient } from './app-runner-client.js';
import { MixedProviderUnavailable } from './mixed-model-router.js';

/** 等待首个实际活动；一旦已有工具、正文或推理进展，继续复用原轮次。 */
export async function waitForMixedTurn(turn: ActiveTurn, client: AppServerClient, threadId: string,
  safe: () => boolean, timeoutMs = 60000): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const result = await Promise.race([turn.done.then(() => 'done'), new Promise<string>(resolve => {
      timer = setTimeout(() => resolve('deadline'), timeoutMs);
    })]);
    if (result === 'done') return;
    if (turn.adaptiveActivityAt || !safe() || turn.userInterrupted || turn.modelSwitchPending) return await turn.done;
    let interruptTimer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([client.request('turn/interrupt', { threadId, turnId: turn.turnId }),
        new Promise((_, reject) => { interruptTimer = setTimeout(() => reject(new Error('混合通道准入超时，尚未确认中断；本轮停止，不重放请求。')), 5000); })]);
      await Promise.race([turn.done, new Promise((_, reject) => {
        if (interruptTimer) clearTimeout(interruptTimer);
        interruptTimer = setTimeout(() => reject(new Error('混合通道中断未到终态；本轮停止，不重放请求。')), 5000);
      })]);
    } finally { if (interruptTimer) clearTimeout(interruptTimer); }
    if (!safe() || turn.userInterrupted || turn.modelSwitchPending || turn.criticalHookFailure) {
      throw new Error('准入期限内出现了执行或用户干预；保留当前轮次，不自动重放。');
    }
    throw new MixedProviderUnavailable('首个活动超时，已确认中断；服务端排队状态未知。', 'no_progress_timeout');
  } finally { if (timer) clearTimeout(timer); }
}
