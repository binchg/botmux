/** 飞书长连接注册、健康恢复和公共事件入口；由 event-dispatcher.ts 拆分，来源 c397c9af。 */
import { EventHandlers, RoutingContext, DocCommentContext } from './event-types.js';
import { type Brand, sdkDomain } from './lark-hosts.js';
import * as Lark from '@larksuiteoapi/node-sdk';
import { eventIdForKey, scheduleAckSafeEvent, handleCardActionAckSafe, unkeyableEventKey, claimEventOnce, __resetEventClaimsForTest } from './event-ack.js';
import { logger } from '../../utils/logger.js';
import { handleCommentEventAckSafe, parseCommentEvent } from './event-comment.js';
import { claimMessageOnce } from '../../services/seen-message-store.js';
import { handleIncomingMessage } from './event-incoming-message.js';
import { setBotOpenId, writeBotInfoFile, ensureBotOpenId, probeBotOpenId } from './event-bot-identity.js';
import { checkRequiredScopes } from './event-scope-check.js';
import { CHAT_CACHE_TTL, getGroupStats } from './event-group-stats.js';
import { readBotOpenIdCrossRef, isKnownPeerBot, isTrustedTeamBotSender, updateBotOpenIdCrossRef, tryHandleIntroduceCommand } from './event-peer-identity.js';
import { isBotMentioned, mentionsAnotherMember } from './event-mentions.js';
import { TalkReason, TalkEvaluation, GrantCommandRestrictionReason, grantCommandRestriction, canTalk, evaluateTalk, canOperate, checkGroupMessageAccess } from './event-access.js';
import { extractMessageTextForRouting, maybeApplyForceTopicOverride, decideRouting } from './event-routing.js';

export function startLarkEventDispatcher(larkAppId: string, larkAppSecret: string, handlers: EventHandlers, brand: Brand = 'feishu'): Lark.WSClient {
  const eventDispatcher = new Lark.EventDispatcher({}).register({
    // 主动开工 — 场景①: the bot was added to a chat. Hand off to the daemon,
    // which gates on the autoStartOnGroupJoin toggle + allowedUser membership.
    // Requires this event to be subscribed for the app in the Feishu console.
    'im.chat.member.bot.added_v1': (data: any) => {
      const chatIdForKey: string | undefined = data?.chat_id;
      const operatorForKey: string | undefined = data?.operator_id?.open_id;
      const eventKey = `im.chat.member.bot.added_v1:${larkAppId}:${eventIdForKey(data) ?? `${chatIdForKey ?? 'unknown'}:${operatorForKey ?? 'unknown'}`}`;
      scheduleAckSafeEvent(eventKey, async () => {
      try {
        const chatId: string | undefined = data?.chat_id;
        const operatorOpenId: string | undefined = data?.operator_id?.open_id;
        if (!chatId) return;
        logger.info(`[auto-start:入群] bot added to chat=${chatId.substring(0, 12)} by ${String(operatorOpenId ?? '?').substring(0, 12)}`);
        await handlers.handleBotAdded?.(chatId, operatorOpenId, larkAppId);
      } catch (err) {
        logger.error(`Error handling bot-added event: ${err}`);
      }
      }, 'bot-added event');
    },
    // 文档评论入口（/subscribe-lark-doc）。飞书评论事件命名在 v1/v2 间有差异，
    // 两个候选名都注册（同一处理器）——真机一锤定音后可删冗余。需在开发者后台
    // 订阅对应事件。注意：评论事件是 per-文档 推送（订阅时按 file_token 注册）。
    'drive.file.comment_add_v1': (data: any) => handleCommentEventAckSafe(data, larkAppId, handlers),
    'drive.notice.comment_add_v1': (data: any) => handleCommentEventAckSafe(data, larkAppId, handlers),
    'card.action.trigger': (data: any) => handleCardActionAckSafe(data, larkAppId, handlers),
    // 表情回复事件——一旦在开发者后台订阅了 reaction，SDK 每收到一次都会因
    // 没有 handler 打 "no im.message.reaction.created_v1 handle" 警告刷屏。
    // botmux 不消费表情事件，注册显式 no-op 把这条噪声静默掉。
    'im.message.reaction.created_v1': () => {},
    'im.message.reaction.deleted_v1': () => {},
    'im.message.receive_v1': (data: any) => {
      // Dedupe by message_id (stable across re-pushes / event_id re-mints /
      // daemon restarts), persisted so the 6h re-push tier or a restart can't
      // replay an already-handled message. Fall back to the in-memory event-id
      // claim only when message_id is absent (shouldn't happen for real messages).
      const messageIdForKey = data?.message?.message_id;
      const eventKey = `im.message.receive_v1:${larkAppId}:${messageIdForKey ?? eventIdForKey(data) ?? unkeyableEventKey()}`;
      const claim = messageIdForKey
        ? () => claimMessageOnce(larkAppId, messageIdForKey)
        : () => claimEventOnce(eventKey);
      scheduleAckSafeEvent(eventKey, async () => {
        await handleIncomingMessage(data, larkAppId, handlers);
      }, 'message event', claim);
    },
  });

  // 诊断：包一层 invoke，记录长连接收到的**每一个**事件类型（含未注册的）。
  // 排查云文档评论事件是否真送达 / 实际事件名用——comment 类一律连 payload 关键字段
  // 一起打。日常其它事件只在 DEBUG 下打，避免刷屏。
  // 仅当 dispatcher 真有 invoke 方法时才包（单测里 Lark.EventDispatcher 是 mock，
  // register() 返回的对象没有 invoke → 不包，避免 undefined.bind 抛错）。
  const __origInvoke = typeof (eventDispatcher as any).invoke === 'function'
    ? (eventDispatcher as any).invoke.bind(eventDispatcher)
    : undefined;
  if (__origInvoke) {
    (eventDispatcher as any).invoke = (data: any) => {
      try {
        const et: string = data?.header?.event_type ?? data?.event_type ?? data?.type ?? 'unknown';
        const isCommentish = typeof et === 'string' && et.includes('comment');
        if (isCommentish) {
          const ev = data?.event ?? data;
          const p = parseCommentEvent(data);
          logger.info(`[ws-event] ${larkAppId} event_type=${et} → parsed fileToken=${p.fileToken ?? '?'} commentId=${p.commentId ?? '?'} replyId=${p.replyId ?? '?'} isMentioned=${p.isMentioned} | notice_meta=${JSON.stringify(ev?.notice_meta ?? ev?.noticeMeta ?? null)}`);
        } else if (process.env.DEBUG) {
          logger.info(`[ws-event] ${larkAppId} event_type=${et}`);
        }
      } catch { /* 诊断不阻断分发 */ }
      return __origInvoke(data);
    };
  }

  // Start WSClient
  const wsClient = new Lark.WSClient({
    appId: larkAppId,
    appSecret: larkAppSecret,
    // brand → 长连接域名。国际版租户必须连 larksuite.com，否则收不到任何事件。
    domain: sdkDomain(brand),
    // Default to warn — the SDK is chatty at info ("client ready", reconnect
    // heartbeats, etc.) and floods pm2 error.log when stderr is the only sink.
    // DEBUG=1 widens the level back to info for troubleshooting.
    loggerLevel: process.env.DEBUG ? Lark.LoggerLevel.info : Lark.LoggerLevel.warn,
    // 主机长断网（夜间合盖睡眠、Wi-Fi 切换、VPN 重连）后，SDK 重连要先用 HTTPS 去
    // 飞书换 ws 接入点，这步会 ENOTFOUND / 15s 超时；重连次数由服务端下发且有限，
    // 耗尽后 SDK 置 terminalError 永久放弃，但进程仍 online、PM2 不会兜底 —— 表现为
    // 「必须手动 botmux restart 才能恢复收消息」。下面两道防线让长连接死后自愈。
    //
    // ① pingTimeout：发 ping 后 30s 内无任何 inbound 帧即掐断 socket，触发 close →
    //    SDK 自身重连。专治 TCP 半开连接（没收到 FIN/RST、close 事件不触发）的静默卡死。
    wsConfig: { pingTimeout: 30 },
    // 重连握手卡死（DNS/代理/NAT）兜底，避免单次握手永久 pending。
    handshakeTimeoutMs: 15_000,
    // 重连过程打日志，便于事后从 `pnpm daemon:logs` 复盘（warn 默认看不到这些）。
    onReconnecting: () => logger.warn(`[ws] ${larkAppId} reconnecting…`),
    onReconnected: () => logger.info(`[ws] ${larkAppId} reconnected`),
    onError: (err) => logger.error(`[ws] ${larkAppId} terminal error: ${err.message}`),
  });

  wsClient.start({ eventDispatcher });
  logger.info('Daemon WSClient started');

  // ② SDK 重连耗尽后停在 terminalError（getConnectionStatus().state === 'failed'）并
  //    永久放弃。每分钟探测一次，发现已放弃就 start() 重新发起一轮全新握手 —— start()
  //    会清掉 terminalError 并重新 pullConnectConfig + connect，无需手动重启 daemon。
  //    只在 'failed' 时介入，不打断 SDK 正在进行的 'reconnecting' / 'connecting'。
  let reviving = false;
  const reviveTimer = setInterval(() => {
    if (reviving) return;
    if (wsClient.getConnectionStatus().state !== 'failed') return;
    reviving = true;
    logger.warn(`[ws] ${larkAppId} connection failed (reconnect exhausted), restarting WSClient`);
    wsClient.start({ eventDispatcher })
      .catch(err => logger.error(`[ws] ${larkAppId} WSClient restart failed: ${err?.message ?? err}`))
      .finally(() => { reviving = false; });
  }, 60_000);
  reviveTimer.unref();

  return wsClient;
}
export { setBotOpenId } from './event-bot-identity.js';
export { writeBotInfoFile } from './event-bot-identity.js';
export { ensureBotOpenId } from './event-bot-identity.js';
export { probeBotOpenId } from './event-bot-identity.js';
export { checkRequiredScopes } from './event-scope-check.js';
export { CHAT_CACHE_TTL } from './event-group-stats.js';
export { __resetEventClaimsForTest } from './event-ack.js';
export { getGroupStats } from './event-group-stats.js';
export { readBotOpenIdCrossRef } from './event-peer-identity.js';
export { isKnownPeerBot } from './event-peer-identity.js';
export { isTrustedTeamBotSender } from './event-peer-identity.js';
export { updateBotOpenIdCrossRef } from './event-peer-identity.js';
export { tryHandleIntroduceCommand } from './event-peer-identity.js';
export { isBotMentioned } from './event-mentions.js';
export { mentionsAnotherMember } from './event-mentions.js';
export { TalkReason } from './event-access.js';
export { TalkEvaluation } from './event-access.js';
export { GrantCommandRestrictionReason } from './event-access.js';
export { grantCommandRestriction } from './event-access.js';
export { canTalk } from './event-access.js';
export { evaluateTalk } from './event-access.js';
export { canOperate } from './event-access.js';
export { checkGroupMessageAccess } from './event-access.js';
export { RoutingContext } from './event-types.js';
export { EventHandlers } from './event-types.js';
export { DocCommentContext } from './event-types.js';
export { extractMessageTextForRouting } from './event-routing.js';
export { maybeApplyForceTopicOverride } from './event-routing.js';
export { decideRouting } from './event-routing.js';
