/** 在严格群门禁中，仅为指定话题群的机器人主人放行免 @ 消息。 */
import { getBot } from '../../bot-registry.js';
import { allowsOwnerTopicWithoutMention } from '../../services/group-direct-mention-policy.js';
import { getChatModeStrict } from './client.js';
import { mentionsAnotherMember } from './event-mentions.js';
import type { IncomingMessageContext } from './event-message-context.js';

/** 群类型每次实时核验，避免缓存把已改回普通群的消息当作新话题启动。 */
export async function isOwnerTopicEntry(context: IncomingMessageContext): Promise<boolean> {
  const { chatType, chatId, larkAppId, sender, message } = context;
  const senderId = sender?.sender_id?.open_id;
  if (chatType !== 'group' || sender?.sender_type !== 'user' || !senderId
      || !allowsOwnerTopicWithoutMention(larkAppId, chatId)
      || !getBot(larkAppId).resolvedAllowedUsers.includes(senderId)
      || !['text', 'post'].includes(message.message_type)
      || mentionsAnotherMember(larkAppId, message)) return false;
  return await getChatModeStrict(larkAppId, chatId) === 'topic';
}
