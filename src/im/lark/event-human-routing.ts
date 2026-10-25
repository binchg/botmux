/** 人类消息命令拦截与会话落点准备；由 event-dispatcher.ts 拆分，来源 c397c9af。 */
import { IncomingMessageContext } from './event-message-context.js';
import { ensureDefaultOncallBound } from '../../services/oncall-store.js';
import { logger } from '../../utils/logger.js';
import { canTalk } from './event-access.js';
import { tryHandleIntroduceCommand } from './event-peer-identity.js';
import { tryHandleReplyModeCommand } from './reply-mode-command.js';
import { tryHandleGrantCommand } from './grant-command.js';
import { decideRoutingWithSource, regularGroupRouting, extractMessageTextForRouting, maybeApplyForceTopicOverride, maybeFoldMentionedRegularGroupThreadToChat, maybeApplySharedTopicSeed } from './event-routing.js';
import { isBotMentioned, mentionsAnotherMember } from './event-mentions.js';
import { resolveGroupMentionMode } from '../../services/chat-reply-mode-store.js';
import { getChatMode } from './client.js';
import { ownerContinuationAtTopLevel, isContinuationOwner, requestsSeparateSession } from './regular-group-continuation.js';
import { stripLeadingMentions } from './message-parser.js';

/** 归一群话题落点并保留原有主人续聊、显式新开和权限边界。 */
export async function prepareHumanRouting(context: IncomingMessageContext) {
  const { data, larkAppId, handlers, message, sender, chatId, chatType, messageId } = context;
        const senderOpenId = sender?.sender_id?.open_id as string | undefined;
        // defaultOncall 自动绑定必须在 canTalk 权限判断前完成，否则已开 defaultOncall
        // 的群首次 @bot 时 oncallChats 中还没有该 chat → evaluateTalk 判无权限 → 误弹
        // 自助授权申请卡。ensureDefaultOncallBound 本身带 fast-path 短路且 idempotent。
        await ensureDefaultOncallBound(larkAppId, chatId, chatType).catch(err =>
          logger.warn(`[oncall:${larkAppId}] pre-permission auto-bind failed for ${chatId.substring(0, 12)}: ${err}`),
        );
        const isAllowed = canTalk(larkAppId, chatId, senderOpenId);

        // /introduce — collaboration handshake. Intercept before any routing
        // so the command never reaches a CLI session (each @ed bot's daemon
        // independently records the mentions[] open_ids + names). 无需授权：
        // 任何人都能登记花名册（只记 observed，不授予任何权限）。
        if (await tryHandleIntroduceCommand(larkAppId, message, senderOpenId)) {
          return;
        }

        if (await tryHandleReplyModeCommand(larkAppId, message, senderOpenId, isAllowed)) {
          return;
        }

        // /grant、/revoke — 群内授权元命令。在路由/spawn 之前拦截（仅 owner，需明确 @ 本 bot），
        // 否则会被当成 prompt 喂给 CLI 会话。
        if (await tryHandleGrantCommand(larkAppId, message, senderOpenId)) {
          return;
        }

        logger.debug('Received message:', message);

        // Diagnostic: record the Lark quote-bubble UI quirk where root_id
        // appears without thread_id. decideRouting now treats this as
        // "no thread" (chat-scope / topic / new-topic depending on context),
        // which is the authoritative behavior. Logging it here so we can spot
        // any future surprise in the wild.
        if (message.root_id && !message.thread_id) {
          logger.info(
            `[routing] root_id w/o thread_id (Lark UI quirk, treating as top-level): ` +
            `msg=${messageId.substring(0, 12)} chat=${chatId.substring(0, 12)} ` +
            `type=${chatType} root=${String(message.root_id).substring(0, 12)} ` +
            `parent=${String(message.parent_id ?? '').substring(0, 12)}`,
          );
        }

        const decision = await decideRoutingWithSource(larkAppId, message);
        const routing: { scope: 'thread' | 'chat'; anchor: string } = {
          scope: decision.scope,
          anchor: decision.anchor,
        };
        let routingSource = decision.source;
        let replyRootId: string | undefined;
        const explicitlyMentionedThisBot = isBotMentioned(larkAppId, message, senderOpenId);

        // ambient 下明确交给他人的群消息直接忽略，避免单人群和新话题免 @ 兜底重新放行。
        if (chatType === 'group' && !explicitlyMentionedThisBot
            && resolveGroupMentionMode(larkAppId) === 'ambient'
            && mentionsAnotherMember(larkAppId, message)) {
          logger.debug(`Ignoring group message addressed to another member: ${messageId}`);
          return;
        }

        // Shared-mode follow-up: a non-@ message inside a Lark thread can belong
        // to the regular group's chat-scope session when that root was registered
        // as a shared-topic alias. Whether a 普通群 answers it without an @mention
        // is governed by the bot-global mention policy: 'always' (default) keeps
        // "@ required" so this fold-back is skipped (non-@ thread chatter falls
        // through to the gate below and is ignored — only an explicit @ continues
        // a shared topic); 'topic', 'never' and 'ambient' enable the seamless
        // no-@ fold-back. Carve-out: under 'ambient', a non-@ reply that @mentions
        // another specific member (person/bot) is a redirect to someone else →
        // back off, don't fold it in (mentionsAnotherMember). 'never'
        // (unconditional) and 'topic' are unaffected.
        if (!explicitlyMentionedThisBot
            && resolveGroupMentionMode(larkAppId) !== 'always'
            && !(resolveGroupMentionMode(larkAppId) === 'ambient' && mentionsAnotherMember(larkAppId, message))
            && routing.scope === 'thread' && message.root_id && message.thread_id && chatType === 'group') {
          const alias = handlers.resolveReplyThreadAlias?.(message.root_id, chatId, larkAppId) ?? null;
          if (alias) {
            const freshMode = await getChatMode(larkAppId, chatId, { forceRefresh: true });
            if (freshMode === 'group') {
              routing.scope = 'chat';
              routing.anchor = alias.chatId;
              replyRootId = message.root_id;
              logger.info(`[reply-mode] alias root=${message.root_id.substring(0, 12)} → chat=${alias.chatId.substring(0, 12)} session=${alias.sessionId.substring(0, 8)}`);
            }
          }
        }

        // 话题群 → 普通群 (reverse conversion). Symmetric to the forward check
        // below: when decideRouting lands on thread-scope purely because the
        // *cached* chat_mode said 'topic' (no real thread_id on the message
        // either — i.e. this would seed a brand-new thread), our 5-min cache
        // may be stale from before a flip-back to 普通群. Re-verify with
        // forceRefresh; if Lark now reports 'group', flatten to chat-scope so
        // the bot doesn't keep wrapping every top-level reply in a fresh
        // Lark topic via reply_in_thread.
        //
        // Skip when there's a real thread_id (authoritative thread signal,
        // can't be cache-stale) or when chatType is p2p (DMs always thread).
        // Runs BEFORE /t override so a `@bot /t …` in a now-flat 普通群 still
        // gets the explicit topic seed it asked for.
        if (
          routing.scope === 'thread' &&
          routing.anchor === messageId &&
          !message.thread_id &&
          chatType === 'group'
        ) {
          const freshMode = await getChatMode(larkAppId, chatId, { forceRefresh: true });
          if (freshMode === 'group') {
            const rerouted = regularGroupRouting(larkAppId, messageId, chatId);
            logger.info(
              `[chat-mode-converted] ${chatId.substring(0, 12)} chat_mode flipped 'topic' → 'group'; ` +
              `rerouting msg=${messageId.substring(0, 12)} as ${rerouted.scope}-scope`,
            );
            routing.scope = rerouted.scope;
            routing.anchor = rerouted.anchor;
            routingSource = rerouted.source;
          }
        }

        // 主动开工 — 场景②: capture only genuine topic-group seeds NOW, before
        // `/t` or the regular-group new-topic mode can create the same
        // {thread, anchor=messageId} shape in a regular group. autoStartOnNewTopic
        // is deliberately limited to 话题群.
        const autoTopicSeedScope = routingSource === 'topic-chat' ? routing.scope : 'chat';
        const autoTopicSeedAnchor = routingSource === 'topic-chat' ? routing.anchor : chatId;

        const ownerContinuation = ownerContinuationAtTopLevel(larkAppId, chatId, routingSource);
        const continuationOwner = isContinuationOwner(larkAppId, senderOpenId);
        const separateSession = ownerContinuation && requestsSeparateSession(stripLeadingMentions(
          extractMessageTextForRouting(message) ?? '', message.mentions ?? [],
        ));
        if (separateSession && !continuationOwner) {
          logger.info(`[routing] 非主人不能在普通群话题外新开会话: ${messageId}`);
          return;
        }
        if (separateSession) {
          routing.scope = 'thread';
          routing.anchor = messageId;
        }

        // /t / /topic in 普通群: flip routing to thread-scope so the bot's
        // first reply seeds a fresh Lark thread, even if a chat-scope session
        // is currently active in this chat.
        const forceTopicApplied = separateSession || maybeApplyForceTopicOverride(routing, message, messageId);
        if (forceTopicApplied) {
          logger.info(`[/t] Force-topic override: msg=${messageId.substring(0, 12)} → thread-scope, anchor=msg`);
        }

        let ownsSession = handlers.isSessionOwner?.(routing.anchor, larkAppId) ?? false;

        const ownsThreadSessionBeforeFold = routing.scope === 'thread'
          ? (handlers.isSessionOwner?.(routing.anchor, larkAppId) ?? false)
          : false;
        const foldedReplyRootId = await maybeFoldMentionedRegularGroupThreadToChat({
          larkAppId, chatId, chatType, message, routing, forceTopicApplied, mentionedThisBot: explicitlyMentionedThisBot, ownsThreadSession: ownsThreadSessionBeforeFold,
        });
        if (foldedReplyRootId) {
          replyRootId = foldedReplyRootId;
          ownsSession = handlers.isSessionOwner?.(routing.anchor, larkAppId) ?? false;
        } else {
          const seedReplyRootId = await maybeApplySharedTopicSeed({
            larkAppId, chatId, chatType, message, senderOpenId, messageId, routing, forceTopicApplied,
          });
          if (seedReplyRootId) {
            replyRootId = seedReplyRootId;
            ownsSession = handlers.isSessionOwner?.(routing.anchor, larkAppId) ?? false;
          }
        }

        // 普通群 → 话题群 conversion detection. Lark group admins can flip
        // chat_mode at any time; our 30/5-min cache lags. If routing landed on
        // chat-scope AND we own a session at this chat, the chat-scope session
        // may be stale from before a conversion. Re-fetch chat_mode with
        // forceRefresh to confirm. If it's now 'topic', the session is dead:
        // sendMessage(chatId) at dispatch time would wrap each reply in a new
        // Lark topic (the user-reported bug). Evict the stale session, then
        // route this message as if it were a brand-new thread seed so
        // handleNewTopic spawns a thread-scope session anchored at messageId.
        // Gate on ownsSession to avoid an API roundtrip on every fresh inbound.
        // Skip p2p: a DM is always 'p2p' and can never be a topic group, so the
        // check can only waste a forceRefresh roundtrip (relevant now that
        // p2pMode==='chat' makes DMs land on chat-scope).
        if (routing.scope === 'chat' && ownsSession && chatType !== 'p2p') {
          const freshMode = await getChatMode(larkAppId, chatId, { forceRefresh: true });
          if (freshMode === 'topic') {
            logger.info(
              `[chat-mode-converted] ${chatId.substring(0, 12)} chat_mode flipped 'group' → 'topic'; ` +
              `evicting stale chat-scope session and rerouting msg=${messageId.substring(0, 12)} as thread seed`,
            );
            try { handlers.onChatModeConverted?.(chatId, larkAppId); } catch (err) {
              logger.warn(`onChatModeConverted handler threw: ${err}`);
            }
            routing.scope = 'thread';
            routing.anchor = messageId;
            routingSource = 'topic-chat';
            // ownsSession was true on the stale chatId anchor; the new anchor
            // (messageId) is brand-new, so no current session owns it.
            ownsSession = false;
          }
        }
  return { senderOpenId, isAllowed, routing, routingSource, replyRootId, explicitlyMentionedThisBot, autoTopicSeedScope, autoTopicSeedAnchor, ownerContinuation, continuationOwner, forceTopicApplied, ownsSession };
}
