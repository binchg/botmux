/** 人类消息准入与会话投递；由 event-dispatcher.ts 拆分，来源 c397c9af。 */
import { IncomingMessageContext } from './event-message-context.js';
import { prepareHumanRouting } from './event-human-routing.js';
import { resolveSummaryCommandMatch } from './event-summary-command.js';
import { getGroupStats } from './event-group-stats.js';
import { resolveGroupMentionMode } from '../../services/chat-reply-mode-store.js';
import { isBotDirectlyMentioned, mentionsAnotherMember } from './event-mentions.js';
import { requiresDirectGroupMention } from '../../services/group-direct-mention-policy.js';
import { isExistingGroupConversation } from './group-conversation-followup.js';
import { isOwnerTopicEntry } from './group-owner-topic-entry.js';
import { getChatMode } from './client.js';
import { checkGroupMessageAccess, maybeSendGrantRequestCard } from './event-access.js';
import { logger } from '../../utils/logger.js';
import { shouldAutoStartOnNewTopic } from '../../core/auto-start.js';
import { getBot } from '../../bot-registry.js';
import { config } from '../../config.js';
import { maybeMirrorThreadUserMessage } from './thread-user-mirror-runtime.js';
import { buildSummaryCommandPrompt } from './summary-command.js';
import { RoutingContext } from './event-types.js';
import { dispatchSessionMessage } from './regular-group-continuation.js';

/** 已确定落点的消息继续完成准入、总结和串行会话投递。 */
export async function handleHumanMessage(context: IncomingMessageContext): Promise<void> {
  const { data, larkAppId, handlers, message, sender, chatId, chatType, messageId } = context;
  const strictGroupEntry = chatType === 'group' && requiresDirectGroupMention(larkAppId);
  const conversationFollowup = strictGroupEntry && isExistingGroupConversation(context)
    && !mentionsAnotherMember(larkAppId, message);
  const directlyMentioned = strictGroupEntry && isBotDirectlyMentioned(larkAppId, message);
  const ownerTopicEntry = strictGroupEntry && !conversationFollowup && !directlyMentioned
    && await isOwnerTopicEntry(context);
  // 指定话题群的主人可免 @ 开工；普通群顶层仍不能绕过直接 @ 门禁。
  if (strictGroupEntry && !conversationFollowup && !directlyMentioned && !ownerTopicEntry) {
    logger.debug(`Ignoring group message without direct mention: ${messageId}`);
    return;
  }
  const prepared = await prepareHumanRouting(context);
  if (!prepared) return;
  const { senderOpenId, isAllowed, routing, routingSource, replyRootId, explicitlyMentionedThisBot, autoTopicSeedScope, autoTopicSeedAnchor, ownerContinuation, continuationOwner, forceTopicApplied, ownsSession } = prepared;
  // 后续路由若发现群已转回普通群，不得把刚取得的免 @ 资格用于群顶层会话。
  if (ownerTopicEntry && routing.scope !== 'thread') return;
  const senderType = sender?.sender_type;
        const summaryCommandMatch = await resolveSummaryCommandMatch({
          larkAppId,
          chatId,
          chatType,
          routingSource,
          message,
          senderOpenId,
        });
        const summaryCommandTriggered = !!summaryCommandMatch && isAllowed;

        // Permission gating — same shape as before, just keyed on
        // `ownsSession` (anchor-aware) instead of "rootId presence":
        //
        //   ownsSession + 1v1 group → relax (no @mention required)
        //   ownsSession + multi     → require @mention
        //   !ownsSession (group)    → require @mention + allowlist
        //   p2p                     → allowlist only
        if (chatType === 'group') {
          let stats: { userCount: number; botCount: number } | null = null;
          if (ownsSession && !replyRootId) stats = await getGroupStats(larkAppId, chatId);
          // replyRootId means this turn has already been explicitly addressed
          // to the bot by shared-topic logic (possibly from inside an existing
          // Lark thread). Do not re-run the generic group @ gate, which would
          // reject multi-bot thread replies simply because `routing.scope` was
          // folded back to chat-scope.
          //
          // The bot-global mention policy drops the @ requirement:
          //   • 'never' — answer EVERY un-@ message from talk-allowed senders
          //     (incl. brand-new non-@ top-level → spawns/continues a session),
          //     unconditionally. Intended for dedicated / on-call groups.
          //   • 'ambient' — like 'never' (answer un-@ messages), EXCEPT when the
          //     message @mentions another specific member (person/bot) without
          //     @ing us — that is a redirect to someone else, so we back off and
          //     stay quiet (mentionsAnotherMember). @all does not count as a
          //     redirect. Best for multi-bot / multi-person groups that want a
          //     default responder which yields the moment you address someone else.
          //   • 'topic' — only inside a topic the bot already owns: a non-@ reply
          //     INSIDE such a thread (new-topic / 话题群 thread the bot owns, or a
          //     shared-topic alias via replyRootId) continues without @, while a
          //     brand-new top-level conversation still requires @.
          // Both gated on isAllowed so restricted groups still only react to
          // permitted senders. (The shared fold-back's replyRootId is already
          // handled by the first clause.)
          const mentionMode = resolveGroupMentionMode(larkAppId);
          // 只覆盖真实普通群话题外入口；转换为话题群后恢复原来的权限与路由。
          const ownerTopLevel = ownerContinuation;
          if (ownerTopLevel && !continuationOwner && !explicitlyMentionedThisBot) return;
          // 话题群 owned-topic 免@续话 — single-bot groups only. In a multi-bot
          // topic every co-resident bot owns a session on the same thread anchor,
          // so relaxing here would make ALL of them answer a message that
          // @mentioned only one (or none) of them; botCount > 1 keeps the
          // "@ required" contract. `stats` is the cached group stats (fetched
          // above when ownsSession; its 999/999 API-failure fallback also lands
          // on the safe "require @" side). A message that @mentions another
          // specific member is a redirect to someone else → back off, mirroring
          // the ambient carve-out.
          const ownedTopicGroupFollowup = !explicitlyMentionedThisBot
            && isAllowed
            && ownsSession
            && !!stats && stats.botCount <= 1
            && !mentionsAnotherMember(larkAppId, message)
            && routing.scope === 'thread'
            && !!message.thread_id
            && await getChatMode(larkAppId, chatId) === 'topic';
          const relax = (conversationFollowup && isAllowed)
            || (ownerTopicEntry && isAllowed)
            || (ownerTopLevel && continuationOwner && isAllowed)
            || (!!replyRootId && isAllowed)
            || (isAllowed && mentionMode === 'never')
            || (isAllowed && mentionMode === 'ambient' && !mentionsAnotherMember(larkAppId, message))
            || ownedTopicGroupFollowup
            || (isAllowed && mentionMode === 'topic' && ownsSession && !!message.thread_id)
            || (ownsSession && isAllowed && !!stats && stats.userCount <= 1 && stats.botCount <= 1);
          if (!relax) {
            const access = await checkGroupMessageAccess(larkAppId, message, chatId, senderOpenId);
            if (access === 'not_allowed') {
              // 入口 A：无权限者 @bot → 弹授权申请卡（@owner），代替「无操作权限」。
              // 覆盖 ownsSession 真假两种情况，但绝不把该消息喂进已有 session。
              await maybeSendGrantRequestCard(larkAppId, message, chatId, senderOpenId);
              logger.debug(`Ignoring group message from non-allowed user: ${senderOpenId} (grant request card path)`);
              return;
            }
            if (access === 'ignore') {
              // 主动开工 — 场景②: a non-@ message that seeds a brand-new topic in
              // a 话题群 auto-starts a session when the bot opted in. Everything
              // else (regular-group chatter, thread replies, disabled bots) keeps
              // the original ignore. Sender is intentionally not gated (D4).
              const autoTopic = shouldAutoStartOnNewTopic({
                enabled: getBot(larkAppId).config.autoStartOnNewTopic === true,
                scope: autoTopicSeedScope,
                anchor: autoTopicSeedAnchor,
                messageId,
                chatType,
                ownsSession,
              });
              if (!autoTopic) {
                logger.debug(`Ignoring group message not addressed to bot: ${messageId}`);
                return;
              }
              logger.info(`[auto-start:新话题] ${chatId.substring(0, 12)} 新话题免@自动开工 msg=${messageId.substring(0, 12)}`);
            }
          }
        } else if (!isAllowed) {
          logger.debug(`Ignoring p2p message from non-allowed user: ${senderOpenId}`);
          return;
        }

        // 只补发已经通过权限检查的真实用户追加消息，补发自身不会进入此路径。
        void maybeMirrorThreadUserMessage(larkAppId, message, senderType, senderOpenId ?? '', ownsSession);

        const promptOverride = summaryCommandTriggered && summaryCommandMatch
          ? await buildSummaryCommandPrompt({ larkAppId, chatId, message, match: summaryCommandMatch })
          : undefined;
        if (promptOverride && summaryCommandMatch) {
          logger.info(
            `[summary-command] matched msg=${messageId.substring(0, 12)} ` +
            `chat=${chatId.substring(0, 12)} kind=${summaryCommandMatch.chatKind}`,
          );
        }
        const ctx: RoutingContext = {
          chatId,
          messageId,
          chatType,
          larkAppId,
          ...routing,
          replyRootId,
          promptOverride,
          summaryCommand: summaryCommandTriggered && summaryCommandMatch
            ? { name: 'summary-command', chatKind: summaryCommandMatch.chatKind }
            : undefined,
        };
        // Serialize per anchor so two messages to the same thread/chat are
        // processed in arrival order — never concurrently. Without this a fast
        // second message interleaves with the first's async session-spawn and is
        // dropped (worker-not-ready → re-fork branch). See anchor-serializer.ts.
        await dispatchSessionMessage(handlers, data, ctx, ownsSession)
          .catch(err => logger.error(`Error handling message event: ${err}`));
}
