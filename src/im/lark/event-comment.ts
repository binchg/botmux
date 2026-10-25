/** 文档评论事件解析与异步处理；由 event-dispatcher.ts 拆分，来源 c397c9af。 */
import { EventHandlers } from './event-types.js';
import { eventIdForKey, scheduleAckSafeEvent } from './event-ack.js';
import { logger } from '../../utils/logger.js';
import { getDocSubscription } from '../../services/doc-subs-store.js';
import { config } from '../../config.js';
import { ensureBotOpenId } from './event-bot-identity.js';
import { getDocComment, isBotAuthoredReply, hasBotSentinel, commentTriggerAllowed } from './doc-comment.js';
import { getBot } from '../../bot-registry.js';

export function parseCommentEvent(data: any): {
  fileToken?: string; fileType?: string; commentId?: string; replyId?: string;
  noticeType?: string; isMentioned?: boolean; operatorOpenId?: string; meta?: any;
} {
  const d = data?.event ?? data ?? {};
  let meta = d.notice_meta ?? d.noticeMeta;
  if (typeof meta === 'string') { try { meta = JSON.parse(meta); } catch { /* 保留原字符串 */ } }
  const m = (meta && typeof meta === 'object') ? meta : {};
  const pick = (k: string) => d[k] ?? m[k] ?? m[k.replace(/_([a-z])/g, (_: string, c: string) => c.toUpperCase())];
  return {
    fileToken: pick('file_token') ?? pick('token') ?? pick('obj_token'),
    fileType: pick('file_type') ?? pick('obj_type'),
    commentId: pick('comment_id'),
    replyId: pick('reply_id'),
    noticeType: pick('notice_type'),
    isMentioned: d.is_mentioned === true || m.is_mentioned === true,
    operatorOpenId: d.operator_id?.open_id ?? d.user_id?.open_id ?? m.operator_id?.open_id,
    meta,
  };
}

/** 评论事件入口：去重 ACK-safe 包装 + 订阅匹配 + 自触发/触发范围过滤后转 daemon。 */
export function handleCommentEventAckSafe(data: any, larkAppId: string, handlers: EventHandlers): void {
  const parsed = parseCommentEvent(data);
  const eventKey = `drive.comment_add:${larkAppId}:${eventIdForKey(data) ?? `${parsed.fileToken ?? '?'}:${parsed.replyId ?? parsed.commentId ?? '?'}`}`;
  scheduleAckSafeEvent(eventKey, async () => {
    try {
      await processCommentEvent(parsed, larkAppId, handlers);
    } catch (err) {
      logger.error(`Error handling doc-comment event: ${err}`);
    }
  }, 'doc-comment event');
}

export async function processCommentEvent(
  parsed: ReturnType<typeof parseCommentEvent>,
  larkAppId: string,
  handlers: EventHandlers,
): Promise<void> {
  if (!handlers.handleDocComment) return;
  const { fileToken, commentId } = parsed;
  if (!fileToken || !commentId) {
    logger.info(`[doc-comment] event dropped: missing fileToken/commentId (fileToken=${fileToken ?? '?'} commentId=${commentId ?? '?'}) — payload 字段路径可能与解析不符`);
    return;
  }

  // 1) 必须是已订阅的文档（per-文档订阅 → 主键命中才处理）
  const sub = getDocSubscription(config.session.dataDir, larkAppId, fileToken);
  if (!sub) {
    logger.info(`[doc-comment] event dropped: file_token=${fileToken.slice(0, 12)} 不在订阅表（已订阅的可 /subscribe-lark-doc list 查；注意 wiki 链接会解析成底层 obj_token）`);
    return;
  }

  // 关掉 open_id 启动竞态：probeBotOpenId 在启动时 fire-and-forget，若评论事件
  // 在该窗口内到达，下面 mention-only 闸 / 自触发过滤会拿到 undefined 的 botOpenId
  // → 合法的 @bot 评论被误丢（事件已被 ACK，飞书不会重投，@ 永久丢失）。await
  // 去重后的探针把 open_id 补齐；探针失败则降级（心跳会重试）。
  await ensureBotOpenId(larkAppId).catch(() => { /* degrade; heartbeat retries */ });

  // 2) 拉评论 thread 取权威正文 / 作者 / @ 列表（事件 payload 不保证带全），
  //    同时用最新一条回复作为"触发回复"。
  const comment = await getDocComment(larkAppId, { fileToken, fileType: sub.fileType }, commentId);
  if (!comment || comment.replies.length === 0) {
    logger.info(`[doc-comment] event dropped: 取不到评论内容 comment=${commentId.slice(0, 12)}（replies=${comment ? comment.replies.length : 'null'}）`);
    return;
  }
  const trigger = parsed.replyId
    ? comment.replies.find(r => r.replyId === parsed.replyId) ?? comment.replies[comment.replies.length - 1]
    : comment.replies[comment.replies.length - 1];

  // 3) 自触发过滤（防死循环）：bot 的回复可能以应用身份（作者=bot open_id）或回退
  //    用户身份（作者=授权用户，无法靠作者区分）发出。三重保险：①作者==本 bot
  //    ②reply_id 在 bot 创建集合 ③文本含隐形哨兵。任一命中即跳过。
  const selfBotOpenId = getBot(larkAppId).botOpenId;
  if ((selfBotOpenId && trigger.userId === selfBotOpenId) || isBotAuthoredReply(trigger.replyId) || hasBotSentinel(trigger.text)) return;

  // 4) 触发范围闸（mention-only 仅当评论真的 @ 了本 bot 才触发）。
  //    ⚠️ 必须以拉到的评论正文 @person(open_id) 列表为准，不能信事件自带的
  //    `is_mentioned`——它表示「评论里存在任意 @」，@ 别人时也是 true，曾导致
  //    「@ 同事的评论也被误触发」。详见 commentTriggerAllowed 注释。
  if (!commentTriggerAllowed(sub.commentTriggerMode, trigger.mentions, selfBotOpenId)) {
    logger.info(`[doc-comment] event dropped: mention-only 但未 @ 本 bot (comment=${commentId.slice(0, 12)} isMentioned=${parsed.isMentioned} mentions=${trigger.mentions.length} self=${selfBotOpenId ? selfBotOpenId.slice(0, 10) : '?'})`);
    return;
  }

  const text = trigger.text.trim();
  if (!text) return;

  logger.info(`[doc-comment] dispatch file=${fileToken.slice(0, 12)} comment=${commentId.slice(0, 12)} mode=${sub.commentTriggerMode} → session anchor=${sub.sessionAnchor.slice(0, 12)}`);
  await handlers.handleDocComment({
    larkAppId,
    sub,
    commentId,
    replyId: trigger.replyId || commentId,
    text,
    authorOpenId: trigger.userId,
  });
}
