/** 普通群最终结果先落原话题，再同步到群；进度消息仍只留在话题。 */
import { createHash } from 'node:crypto';
import { regularGroupSettings } from './regular-group-settings.js';
import { getChatMode, replyMessage, sendMessage } from '../im/lark/client.js';
import { fallbackTurnId, resolveSessionReplyTarget } from '../core/reply-target.js';
import type { DaemonSession } from '../core/types.js';
import { beginOutboundReply } from './terminal-send-barrier.js';

/** 两条发送各自使用稳定 UUID，第二条失败重试时不能重复第一条。 */
export async function deliverRegularGroupFinal(ds: DaemonSession, turnId: string, card: string): Promise<boolean> {
  if (!regularGroupSettings(ds.larkAppId, ds.chatId).sync) return false;
  const target = resolveSessionReplyTarget(ds, fallbackTurnId(ds, turnId));
  if (target.mode !== 'thread' || await getChatMode(ds.larkAppId, ds.chatId) !== 'group') return false;
  const uuid = (lane: string) => createHash('sha256')
    .update(JSON.stringify([ds.session.sessionId, turnId, target.rootMessageId, lane, card])).digest('hex').slice(0, 32);
  const context = { sessionId: ds.session.sessionId, turnId, kind: 'final', originalThread: target.rootMessageId };
  const lease = beginOutboundReply(ds);
  try {
    await replyMessage(ds.larkAppId, target.rootMessageId, card, 'interactive', true, uuid('thread'), context);
    await sendMessage(ds.larkAppId, ds.chatId, card, 'interactive', uuid('chat'), context);
    return true;
  } finally { lease.release(); }
}
