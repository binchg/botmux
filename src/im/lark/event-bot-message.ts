/** 机器人消息回声隔离与路由；由 event-dispatcher.ts 拆分，来源 c397c9af。 */
import { IncomingMessageContext } from './event-message-context.js';
import { getBot, findOncallChat } from '../../bot-registry.js';
import { recordBotUnionId } from '../../services/bot-union-ids-store.js';
import { config } from '../../config.js';
import { logger } from '../../utils/logger.js';
import { decideRouting, decideRoutingWithSource, extractMessageTextForRouting, maybeApplyForceTopicOverride, maybeFoldMentionedRegularGroupThreadToChat, maybeApplySharedTopicSeed } from './event-routing.js';
import { serializeByAnchor } from '../../utils/anchor-serializer.js';
import { isTeamGroupChat } from '../../services/team-groups-store.js';
import { recordTeamBot } from '../../services/team-bots-store.js';
import { isPlatformHallChat } from '../../services/platform-team-store.js';
import { isBotMentioned } from './event-mentions.js';
import { sendMessage } from './client.js';
import { ownerContinuationAtTopLevel, requestsSeparateSession } from './regular-group-continuation.js';
import { stripLeadingMentions } from './message-parser.js';
import { isKnownPeerBot, isTrustedTeamBotSender } from './event-peer-identity.js';
import { hasChatGrant, hasGlobalGrant, maybeSendGrantRequestCard } from './event-access.js';

export const hallEchoReplied = new Set<string>();
/** 保持机器人自身回声、外部机器人和群入口的原有处理顺序。 */
export async function handleBotMessage(context: IncomingMessageContext): Promise<void> {
  const { data, larkAppId, handlers, message, sender, chatId, chatType, messageId } = context;
          const senderOpenId = sender.sender_id?.open_id;
          const isSelfMessage = senderOpenId === getBot(larkAppId).botOpenId;
          // Self messages: learn our OWN union_id from the echo first (the only
          // reliable source — see bot-union-ids-store; reported to the platform
          // on heartbeat for the team roster), then only echoed `/close` matters.
          if (isSelfMessage) {
            const selfUnionId = sender.sender_id?.union_id as string | undefined;
            if (selfUnionId && recordBotUnionId(config.session.dataDir, larkAppId, selfUnionId)) {
              logger.info(`[${larkAppId}] learned own bot union_id from self-message echo`);
            }
            try {
              const body = JSON.parse(message.content ?? '{}');
              if (body.text?.trim() !== '/close') return;
            } catch {
              return;
            }
            const ctx = await decideRouting(larkAppId, message);
            // Serialize per anchor so back-to-back messages to the same thread
            // (e.g. dispatch's /repo prime + brief kickoff) don't interleave with
            // the first's async session-spawn. See anchor-serializer.ts.
            await serializeByAnchor(ctx.anchor, () =>
              handlers.handleThreadReply(data, { ...ctx, chatId, messageId, chatType, larkAppId }))
              .catch(err => logger.error(`Error handling message event: ${err}`));
            return;
          }
          // Learn teammate identity from team-assembled groups (the trust root):
          // any bot talking in a 拉群 group is a vouched teammate, so capture its
          // tenant-stable union_id — we then honour it as a teammate in ANY chat
          // (see team-bots-store). Done BEFORE the @mention gate so even a non-@
          // message in a team group teaches us the teammate. Cheap + idempotent.
          const senderUnionId = sender.sender_id?.union_id as string | undefined;
          if (senderUnionId && isTeamGroupChat(config.session.dataDir, chatId)) {
            recordTeamBot(config.session.dataDir, { unionId: senderUnionId });
          }
          // 机器人大厅：bot 消息只用于身份登记（上面已学 sender union / mentions
          // 自学 / cross-ref），绝不当任务路由——大厅打卡会点名 @ 同伴，不吞掉的话
          // 接收 bot 会把打卡当任务拉起会话在大厅里回话（实测）。只吞 bot 发送方：
          // 人类经隐藏入口进大厅后 @ bot 仍正常应答。
          if (isPlatformHallChat(config.session.dataDir, chatId)) {
            // 回执互教：打卡者点名了我们且带 #hall-echo（= 它还没学到自己的
            // union_id）→ @ 回它一次。open_id 直接取事件 sender_id（本 app 视角，
            // 无需 cross-ref），打卡者从回执的 mentions[] 学到自己。每进程每发送者
            // 只回一次；回执不带标记，链路必然终止。
            try {
              const text: unknown = JSON.parse(message.content ?? '{}')?.text;
              if (
                typeof text === 'string' && text.includes('#hall-echo') && senderOpenId &&
                isBotMentioned(larkAppId, message, undefined) &&
                !hallEchoReplied.has(`${larkAppId}::${senderOpenId}`)
              ) {
                hallEchoReplied.add(`${larkAppId}::${senderOpenId}`);
                void sendMessage(larkAppId, chatId, `<at user_id="${senderOpenId}"></at> 已登记`, 'text')
                  .then(() => logger.info(`[${larkAppId}] hall echo reply sent to ${senderOpenId.substring(0, 12)}`))
                  .catch((e) => logger.warn(`[${larkAppId}] hall echo reply failed: ${(e as Error).message}`));
              }
            } catch { /* content 非 JSON → 忽略 */ }
            logger.debug(`[${larkAppId}] hall bot message swallowed after learning (chat=${chatId.substring(0, 12)})`);
            return;
          }
          // Foreign bot: only route on @mention of us.
          if (!isBotMentioned(larkAppId, message, undefined)) return;
          const decision = await decideRoutingWithSource(larkAppId, message);
          const ctx = { scope: decision.scope, anchor: decision.anchor };
          const ownerContinuation = ownerContinuationAtTopLevel(larkAppId, chatId, decision.source);
          if (ownerContinuation && requestsSeparateSession(stripLeadingMentions(
            extractMessageTextForRouting(message) ?? '', message.mentions ?? [],
          ))) return;
          // Honor `/t` / `/topic` from bot senders too, aligning with the human
          // path so an explicit `@bot /t …` handoff seeds a fresh topic instead of
          // sticking to chat-scope. Applied BEFORE the gate (and the shared-topic
          // fold) so vetting keys on the FINAL routing: `/t` rewrites ctx to a
          // brand-new {thread, messageId} anchor. forceTopicApplied also suppresses
          // the shared-topic fold below — a `/t` seed wins over shared, same
          // precedence as the human path.
          const forcedTopic = maybeApplyForceTopicOverride(ctx, message, messageId);
          if (forcedTopic) {
            logger.info(`[/t] Force-topic override (bot sender): msg=${messageId.substring(0, 12)} → thread-scope, anchor=msg`);
          }
          const ownsThreadSession = ctx.scope === 'thread'
            ? (handlers.isSessionOwner?.(ctx.anchor, larkAppId) ?? false)
            : false;
          const canFoldForeignBotThread = findOncallChat(larkAppId, chatId)
            || isKnownPeerBot(config.session.dataDir, larkAppId, senderOpenId)
            || isTrustedTeamBotSender(config.session.dataDir, chatId, senderUnionId)
            || hasChatGrant(larkAppId, chatId, senderOpenId)
            || hasGlobalGrant(larkAppId, senderOpenId);
          let replyRootId = await maybeFoldMentionedRegularGroupThreadToChat({
            larkAppId, chatId, chatType, message, routing: ctx, forceTopicApplied: forcedTopic, mentionedThisBot: !!canFoldForeignBotThread, ownsThreadSession,
          });
          if (!replyRootId) {
            replyRootId = await maybeApplySharedTopicSeed({
              larkAppId, chatId, chatType, message, senderOpenId, messageId, routing: ctx, forceTopicApplied: forcedTopic,
            });
          }
          // Regular-group foreign-bot @mention: gate to vetted botmux peers
          // (registered in our bot-openids cross-ref). Fires for legacy chat-scope
          // routing, the new-topic send-shape
          // (decision.source === 'regular-group-thread'), AND a `/t` force-topic
          // seed (forcedTopic) — so random Lark bots cannot silently spawn sessions
          // in 普通群, whether this bot replies in threads or a stranger bot @s us
          // with `/t`. Known Bot A → Bot B handoffs in 普通群 still work.
          //
          // ownsSession is read on ctx.anchor AFTER the `/t` override above. That
          // exemption means "a foreign bot following up into a session we already
          // own" (e.g. a chat-scope session at chatId). A `/t` rewrites the anchor
          // to a fresh messageId where we own nothing, so an unvetted bot can NOT
          // ride the existing chat-scope session's ownership to skip vetting — it
          // must independently hit isKnownPeerBot / chatGrants / globalGrants (or
          // this bot's own oncall chat).
          //
          // 注意 isKnownPeerBot 查的是 cross-ref（bot-openids-<appId>.json），它只
          // 收录 bots-info.json 里有名字的 bot，即本机 daemon 自己配置的 bot
          // （getAllBots）。"别人的 bot" 永远进不了这个 cross-ref，所以 isKnownPeerBot
          // 对外部 bot 恒为 false——这跟 /introduce 是两套独立存储：/introduce 写的是
          // observed-bots-store，只负责让发送方"发现并能 @ 到"对方，过不了这道接收闸。
          //
          // Oncall 群是当前接收 bot 显式部署的协作工作区，canTalk 已对任何成员
          // （含真人）放行；这里对 bot 同等放行，跳过 cross-ref vetting。否则本
          // bot 已绑定的 oncall 群里外部 bot 互相 @ 会被静默丢弃、只有真人能拉起会话。
          // 注意 oncall talk access 是 bot-scoped：一个 bot 的 /oncall bind 不会放开
          // sibling bot 的 talk 权限；如果 sibling bot 也要开放，需要自己绑定同一个 chat。
          //
          // owner 还可用 `/grant @bot` 把外部 bot 加进本群 chatGrants（与真人 /grant
          // 同一存储、同一 per-chat 语义）。命中 chatGrants 的 bot 即便不在 cross-ref，
          // 也与已注册 peer 同等放行——这是「授权外部 bot 在本群协作」的入口。
          // 全局授权（globalGrants）同理：命中即在任意群放行，是上面的全局版。
          //
          // 团队 bot 免 /grant：isTrustedTeamBotSender 命中（sender 的租户稳定
          // union_id 已学进 team-bots，或本群就是团队拉群组建的协作群）即放行——
          // 与「同部署兄弟 bot」(isKnownPeerBot) 对等，但覆盖跨部署的团队 peer。
          // 这正是「加入团队即免 introduce/grant」的接收闸：身份只认 union_id /
          // 团队群成员，绝不认自报名字（防同名 bot 冒名蹭权）。
          if ((ctx.scope === 'chat' || decision.source === 'regular-group-thread' || forcedTopic) && !findOncallChat(larkAppId, chatId)) {
            const ownsSession = handlers.isSessionOwner?.(ctx.anchor, larkAppId) ?? false;
            if (!ownsSession
                && !isKnownPeerBot(config.session.dataDir, larkAppId, senderOpenId)
                && !isTrustedTeamBotSender(config.session.dataDir, chatId, senderUnionId)
                && !hasChatGrant(larkAppId, chatId, senderOpenId)
                && !hasGlobalGrant(larkAppId, senderOpenId)) {
              await maybeSendGrantRequestCard(larkAppId, message, chatId, senderOpenId);
              return;
            }
          }
          logger.info(`Bot-to-bot @mention detected (scope=${ctx.scope}): routing to handleThreadReply`);
          // Serialize per anchor — a sub-bot dispatched a /repo prime + kickoff
          // back-to-back into this thread must be handled in order, not raced.
          await serializeByAnchor(ctx.anchor, () =>
            handlers.handleThreadReply(data, { ...ctx, chatId, messageId, chatType, larkAppId, replyRootId }),
          ctx.scope === 'chat' && chatType === 'group' ? 0 : undefined)
            .catch(err => logger.error(`Error handling bot @mention: ${err}`));
          return;
}
