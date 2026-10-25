/** 保留既有审批回调分派；由 card-handler.ts 拆分，来源 c397c9af。 */
import { CardActionContext, CARD_ACTION_UNHANDLED } from './card-action-context.js';
import { isV3GateAction, handleV3GateAction } from './v3-gate-card-handler.js';
import type { V3GateActionValue } from './v3-gate-card.js';
import { isV3BlockedAction, handleV3BlockedAction } from './v3-blocked-card-handler.js';
import type { V3BlockedActionValue, V3AskAnswerActionValue } from './v3-blocked-card.js';
import { isV3RevisitGrantAction, handleV3RevisitGrantAction } from './v3-revisit-grant-card-handler.js';
import type { V3RevisitGrantActionValue } from './v3-revisit-grant-card.js';
import { isV3LoopGrantAction, handleV3LoopGrantAction } from './v3-loop-grant-card-handler.js';
import type { V3LoopGrantActionValue } from './v3-loop-grant-card.js';

/** 保留既有审批回调分派；未命中时交给下一处理器。 */
export async function handleApprovalActions(context: CardActionContext): Promise<any> {
  const { deps, action, value, operatorOpenId } = context;
  if (isV3GateAction(value?.action)) {
    if (!deps.v3GateDeps) return;
    return await handleV3GateAction(value as unknown as V3GateActionValue, operatorOpenId, deps.v3GateDeps);
  }
  if (isV3BlockedAction(value?.action)) {
    if (!deps.v3BlockedDeps) return;
    return await handleV3BlockedAction(
      value as unknown as V3BlockedActionValue | V3AskAnswerActionValue,
      operatorOpenId,
      deps.v3BlockedDeps,
      action?.form_value,
    );
  }
  if (isV3RevisitGrantAction(value?.action)) {
    if (!deps.v3RevisitGrantDeps) return;
    return await handleV3RevisitGrantAction(value as unknown as V3RevisitGrantActionValue, operatorOpenId, deps.v3RevisitGrantDeps);
  }
  if (isV3LoopGrantAction(value?.action)) {
    if (!deps.v3LoopGrantDeps) return;
    return await handleV3LoopGrantAction(value as unknown as V3LoopGrantActionValue, operatorOpenId, deps.v3LoopGrantDeps);
  }
  return CARD_ACTION_UNHANDLED;
}
