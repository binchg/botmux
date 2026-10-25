/** 入站消息归一与发送者分派；由 event-dispatcher.ts 拆分，来源 c397c9af。 */
import { EventHandlers } from './event-types.js';
import { canonicalThreadMessage, syncedMessageKey } from './thread-sync.js';
import { getMessageDetail } from './client.js';
import { claimMessageOnce } from '../../services/seen-message-store.js';
import { ensureBotOpenId } from './event-bot-identity.js';
import { updateBotOpenIdCrossRef } from './event-peer-identity.js';
import { config } from '../../config.js';
import { recordBotUnionIdFromMentions } from '../../services/bot-union-ids-store.js';
import { getBot } from '../../bot-registry.js';
import { logger } from '../../utils/logger.js';
import { IncomingMessageContext } from './event-message-context.js';
import { handleBotMessage } from './event-bot-message.js';
import { handleHumanMessage } from './event-human-message.js';

/** 应答后归一平台消息，完成身份探测，再按发送者类型分派。 */
export async function handleIncomingMessage(data: any, larkAppId: string, handlers: EventHandlers): Promise<void> {
  try {
        let message = data.message;
        const sender = data.sender;
        if (!message) return;

        // 群副本和话题原消息分别推送；ACK 后归一，不能覆盖正确的话题锚点或重复注入。
        if (message.chat_type !== 'p2p') {
          message = await canonicalThreadMessage(message,
            id => getMessageDetail(larkAppId, id, { userCardContent: false }));
          const syncKey = syncedMessageKey(message);
          if (syncKey && !claimMessageOnce(larkAppId, syncKey)) return;
          data = { ...data, message };
        }

        // Close the open_id startup race: probeBotOpenId is fire-and-forget at
        // startup, so an @ arriving in that window would hit isBotMentioned with
        // an undefined botOpenId and be silently dropped (the WSClient still ACKs
        // it, so Lark never redelivers → the @ is lost). Await the deduped probe
        // so the @ is recognized. Best-effort: on probe failure we degrade to the
        // prior behavior (the periodic heartbeat retries the probe).
        await ensureBotOpenId(larkAppId).catch(() => { /* degrade; heartbeat retries */ });

        // Learn other bots' open_ids from @mentions in this event.
        // Lark open_id is per-app: these IDs are correct for our app context.
        if (message.mentions?.length > 0) {
          updateBotOpenIdCrossRef(config.session.dataDir, larkAppId, message.mentions);
          // Learn our OWN union_id from any @ of ourselves: Lark stamps every
          // mention with the target's union_id, and mention-driven delivery
          // works even where the self-message echo never arrives（无 receive-all
          // scope 的应用收不到自己发的消息；bot-only 大厅实测完全不推事件）。
          if (recordBotUnionIdFromMentions(config.session.dataDir, larkAppId, getBot(larkAppId).botOpenId, message.mentions)) {
            logger.info(`[${larkAppId}] learned own bot union_id from @mention`);
          }
        }

        const chatId = message.chat_id;
        const chatType = (message.chat_type === 'p2p' ? 'p2p' : 'group') as 'group' | 'p2p';
        const messageId = message.message_id;

        // Bot-originated messages — bots historically only post inside threads
        // (their own thread replies). With chat-scope sessions a bot can also
        // post top-level (its first reply in a chat-scope group), so we still
        // route them through `decideRouting` rather than gating on root_id.
        //
        // 飞书在跨 bot 卡片消息场景实测会把发送方标成 sender_type='bot'（不是
        // 文档里写的 'app'），所以这里两个值都接受，否则那条路径会落到下面的
        // user-message 通用分支，绕开 /close self-message 特判、foreign-bot
        // chat-scope gate（isKnownPeerBot）和"Bot-to-bot @mention detected"
        // 日志。
        const senderType = sender?.sender_type;
        const isBotSenderType = senderType === 'app' || senderType === 'bot';
    const context: IncomingMessageContext = { data, larkAppId, handlers, message, sender, chatId, chatType, messageId };
    if (isBotSenderType) await handleBotMessage(context);
    else await handleHumanMessage(context);
  } catch (error) { logger.error(`Error handling message event: ${error}`); }
}
