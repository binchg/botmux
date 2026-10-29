/** 群内免 @ 只属于已绑定本机器人的真实话题，不扩展到群顶层或引用气泡。 */
import type { IncomingMessageContext } from './event-message-context.js';

/** 兼容独立话题会话与共享群会话的话题别名，并核对当前群和机器人归属。 */
export function isExistingGroupConversation(context: IncomingMessageContext): boolean {
  const { chatType, chatId, message, larkAppId, handlers } = context;
  if (chatType !== 'group' || !message.root_id || !message.thread_id) return false;
  if (handlers.isSessionOwner?.(message.root_id, larkAppId)) return true;
  const alias = handlers.resolveReplyThreadAlias?.(message.root_id, chatId, larkAppId);
  return alias?.chatId === chatId && handlers.isSessionOwner?.(chatId, larkAppId) === true;
}
