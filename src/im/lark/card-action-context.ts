/** 卡片操作上下文与明确的未命中哨兵；由 card-handler.ts 拆分，来源 c397c9af。 */
import { CardActionData, CardHandlerDeps } from './card-action-types.js';
import type { DaemonSession } from '../../core/types.js';

export const CARD_ACTION_UNHANDLED = Symbol('card-action-unhandled');
/** 只创建一次公共上下文，保留原回调的轮次和机器人身份。 */
export function createCardActionContext(data: CardActionData, deps: CardHandlerDeps, larkAppId?: string) {
  const { activeSessions, lastRepoScan } = deps;
  // turnId is forwarded only when the caller actually has a turn anchor
  // (e.g. the pendingRepo confirmation) — most card actions have none.
  const sessionReply = (rid: string, content: string, msgType?: string, turnId?: string) =>
    turnId !== undefined
      ? deps.sessionReply(rid, content, msgType, larkAppId, turnId)
      : deps.sessionReply(rid, content, msgType, larkAppId);
  const action = data?.action;
  const value = action?.value;
  const cardMessageId = data?.context?.open_message_id ?? data?.open_message_id;
  const operatorOpenId = data?.operator?.open_id;
  return { data, deps, larkAppId, activeSessions, lastRepoScan, sessionReply, action, value, cardMessageId, operatorOpenId };
}
export type CardActionContext = ReturnType<typeof createCardActionContext>;
export type SessionCardContext = CardActionContext & {
  actionType: string; rootId: string; sKey: string; ds: DaemonSession | undefined;
  value: NonNullable<CardActionContext['value']>;
};
