import { getBot, getOwnerOpenId } from '../../bot-registry.js';
import { serializeByAnchor } from '../../utils/anchor-serializer.js';
import type { EventHandlers, RoutingContext } from './event-dispatcher.js';
import { regularGroupOverrides } from '../../services/regular-group-settings.js';

/** 仅约束普通群的话题外入口；话题内继续使用原来的路由和免 @ 设置。 */
export function ownerContinuationEnabled(larkAppId: string, chatId?: string): boolean {
  return (chatId ? regularGroupOverrides(larkAppId, chatId).reuse === true : false)
    || getBot(larkAppId).config.regularGroupOwnerContinuation !== false;
}

/** 关闭复用只改变会话落点，不取消主人免 @ 或放宽其他成员的接收规则。 */
export function ownerContinuationAtTopLevel(appId: string, chatId: string, source: string): boolean {
  return (source === 'regular-group-chat' || (source === 'regular-group-thread'
    && regularGroupOverrides(appId, chatId).reuse === false)) && ownerContinuationEnabled(appId, chatId);
}

export function isContinuationOwner(larkAppId: string, senderOpenId?: string): boolean {
  return !!senderOpenId && senderOpenId === getOwnerOpenId(larkAppId);
}

/** 只识别句首明确指令，不把条件、否定、引用或讨论会话功能当作新开要求。 */
export function requestsSeparateSession(text: string): boolean {
  return /^(?:\/(?:t|topic)(?=\s|$)|(?:请(?:你)?|帮我|给我)?\s*(?:(?:另外|单独|再)\s*)?(?:新开|新建|创建|开启)\s*(?:一个|一条|新的|个)?\s*(?:独立的?\s*)?(?:(?:codex|ai)\s*)?(?:会话|session)(?:[，,。:：!！\s]|$))/i.test(text.trim());
}

/** 群会话创建完成前不超时并发，轮到当前消息时重新判断会话是否已存在。 */
export function dispatchSessionMessage(
  handlers: EventHandlers,
  data: unknown,
  ctx: RoutingContext,
  ownsSession: boolean,
): Promise<void> {
  const sharedChat = ctx.scope === 'chat' && ctx.chatType === 'group';
  return serializeByAnchor(ctx.anchor, () => {
    const currentOwner = sharedChat
      ? (handlers.isSessionOwner?.(ctx.anchor, ctx.larkAppId) ?? false)
      : ownsSession;
    return currentOwner ? handlers.handleThreadReply(data, ctx) : handlers.handleNewTopic(data, ctx);
  }, sharedChat ? 0 : undefined);
}
