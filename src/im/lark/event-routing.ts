/** 私聊、群和已有话题的路由决策；由 event-dispatcher.ts 拆分，来源 c397c9af。 */
import { join } from 'node:path';
import { tag } from './card-action-session-helpers.js';
import { stripLeadingMentions } from './message-parser.js';
import { parseForceTopicInvocation } from '../../core/command-handler.js';
import { ownerContinuationEnabled } from './regular-group-continuation.js';
import { regularGroupOverrides } from '../../services/regular-group-settings.js';
import { resolveRegularGroupMode, resolveGroupMentionMode } from '../../services/chat-reply-mode-store.js';
import { isBotMentioned, mentionsAnotherMember } from './event-mentions.js';
import { getChatMode, getCachedChatMode } from './client.js';
import { logger } from '../../utils/logger.js';
import { getBot } from '../../bot-registry.js';
import { config } from '../../config.js';
import { type SummaryChatKind } from './summary-command.js';

export function extractMessageTextForRouting(message: any): string | null {
  if (!message?.content) return null;
  try {
    const obj = JSON.parse(message.content);
    // text shape: {"text":"..."}. Lark stuffs placeholder keys like "@_user_1"
    // into obj.text; the human name only lives in message.mentions[].name. We
    // must resolve keys → @${name} so stripLeadingMentions can strip them
    // before parseForceTopicInvocation sees the content. Mirrors the
    // resolveMentions logic in parseEventMessage.
    if (typeof obj?.text === 'string') {
      let text: string = obj.text;
      const mentions = message?.mentions;
      if (Array.isArray(mentions)) {
        for (const m of mentions) {
          if (m?.key && m?.name) {
            text = text.split(m.key).join(`@${m.name}`);
          }
        }
      }
      return text;
    }
    // post shape: {"zh_cn":{"content":[[{tag:"text",text:"..."},{tag:"at",...}]]}}
    // Post messages keep @mentions as separate `at` nodes (not embedded in
    // text), so the joined text-node content is already clean of placeholders.
    const inner = obj?.zh_cn ?? obj?.en_us ?? obj;
    if (Array.isArray(inner?.content)) {
      const parts: string[] = [];
      for (const para of inner.content) {
        if (!Array.isArray(para)) continue;
        for (const node of para) {
          if (node?.tag === 'text' && typeof node.text === 'string') {
            parts.push(node.text);
          }
        }
      }
      return parts.length > 0 ? parts.join('') : null;
    }
  } catch { /* malformed content — skip */ }
  return null;
}

/**
 * If the inbound message starts with `/t` / `/topic` AND the routing
 * currently lands on chat-scope, override to thread-scope anchored at
 * the inbound message_id. This makes "force topic mode" work even when
 * the bot already owns a chat-scope session in the chat — the dispatcher
 * routes to handleNewTopic at a fresh anchor instead of falling into
 * handleThreadReply on the chat-scope owner.
 *
 * Already-thread messages (real Lark 话题, p2p, 话题群) are left alone:
 * the prefix is still stripped downstream by handleNewTopic.
 */
export function maybeApplyForceTopicOverride(
  routing: { scope: 'thread' | 'chat'; anchor: string },
  message: any,
  messageId: string,
): boolean {
  if (routing.scope !== 'chat') return false;
  const rawText = extractMessageTextForRouting(message);
  if (!rawText) return false;
  const stripped = stripLeadingMentions(rawText.trim(), message?.mentions ?? []);
  if (!parseForceTopicInvocation(stripped)) return false;
  routing.scope = 'thread';
  routing.anchor = messageId;
  return true;
}

export async function maybeApplySharedTopicSeed(input: {
  larkAppId: string;
  chatId: string;
  chatType: 'group' | 'p2p';
  message: any;
  senderOpenId: string | undefined;
  messageId: string;
  routing: { scope: 'thread' | 'chat'; anchor: string };
  forceTopicApplied?: boolean;
}): Promise<string | undefined> {
  const { larkAppId, chatId, chatType, message, senderOpenId, messageId, routing, forceTopicApplied } = input;
  if (forceTopicApplied) return undefined;
  if (chatType !== 'group') return undefined;
  if (!message.thread_id && (ownerContinuationEnabled(larkAppId, chatId)
    || regularGroupOverrides(larkAppId, chatId).reuse === false)) return undefined;
  if (resolveRegularGroupMode(larkAppId, chatId) !== 'shared') return undefined;
  // Seeding a shared topic normally needs an @mention. But the 'never' and
  // 'ambient' mention policies answer non-@ messages too — and in shared mode it
  // must still OPEN a topic (reply in a thread reusing the chat session), not
  // fall back to a flat top-level reply. So allow non-@ seeding under 'never'
  // (unconditional) or 'ambient' — but for 'ambient' NOT when the message
  // @mentions another specific member (person/bot) without @ing us: that is a
  // redirect to someone else, so we back off (mentionsAnotherMember).
  const seedMentionMode = resolveGroupMentionMode(larkAppId);
  if (!isBotMentioned(larkAppId, message, senderOpenId)
      && !(seedMentionMode === 'never'
        || (seedMentionMode === 'ambient' && !mentionsAnotherMember(larkAppId, message)))) return undefined;
  const freshMode = routing.scope === 'thread'
    ? await getChatMode(larkAppId, chatId, { forceRefresh: true })
    : (getCachedChatMode(larkAppId, chatId) ?? 'group');
  if (freshMode !== 'group') return undefined;
  routing.scope = 'chat';
  routing.anchor = chatId;
  logger.info(`[reply-mode] shared turn msg=${messageId.substring(0, 12)} routes through chat=${chatId.substring(0, 12)}`);
  return message.thread_id ? (message.root_id ?? messageId) : messageId;
}

export async function maybeFoldMentionedRegularGroupThreadToChat(input: {
  larkAppId: string;
  chatId: string;
  chatType: 'group' | 'p2p';
  message: any;
  routing: { scope: 'thread' | 'chat'; anchor: string };
  forceTopicApplied?: boolean;
  mentionedThisBot: boolean;
  ownsThreadSession?: boolean;
}): Promise<string | undefined> {
  const { larkAppId, chatId, chatType, message, routing, forceTopicApplied, mentionedThisBot, ownsThreadSession } = input;
  if (forceTopicApplied || ownsThreadSession) return undefined;
  if (!mentionedThisBot) return undefined;
  if (chatType !== 'group') return undefined;
  const rootId: string | undefined = message?.root_id;
  const threadId: string | undefined = message?.thread_id;
  if (!rootId || !threadId) return undefined;
  const rawText = extractMessageTextForRouting(message);
  if (rawText) {
    const stripped = stripLeadingMentions(rawText.trim(), message?.mentions ?? []);
    if (parseForceTopicInvocation(stripped)) return undefined;
  }

  // In a regular group, `chat` and `shared` both mean "use the group's one
  // chat-scope session/context". Lark still reports replies inside an existing
  // topic as root_id+thread_id, so decideRouting's generic real-thread rule
  // would otherwise fork a brand-new thread-scope session every time another
  // human/bot @mentions us inside that topic. Keep the visible reply in the
  // same topic (replyRootId=rootId), but route the turn through the group
  // chat-scope session. `new-topic` and `chat-topic` are the modes that
  // intentionally keep per-topic independent sessions — they must NOT fold:
  // new-topic forks every top-level @ too, while chat-topic keeps top level
  // flat but lets each native Lark topic run its own session.
  const mode = resolveRegularGroupMode(larkAppId, chatId);
  if (mode === 'new-topic' || mode === 'chat-topic') return undefined;
  const freshMode = await getChatMode(larkAppId, chatId, { forceRefresh: true });
  if (freshMode !== 'group') return undefined;
  routing.scope = 'chat';
  routing.anchor = chatId;
  logger.info(`[reply-mode] mentioned thread root=${rootId.substring(0, 12)} folds into chat=${chatId.substring(0, 12)}`);
  return rootId;
}

/** Compute the scope + anchor for an inbound message:
 *   - root_id + thread_id     → thread-scope, anchor = root_id (real Lark 话题)
 *   - 话题群 + no real thread → thread-scope, anchor = message_id (thread seed)
 *   - p2p + no real thread    → thread-scope, anchor = message_id (each DM
 *                               top-level message starts a fresh topic; a
 *                               reply inside an existing thread carries
 *                               root_id+thread_id and threads into its session)
 *   - 普通群 + no real thread  → resolved regular-group mode:
 *                               new-topic uses thread-scope anchored at
 *                               message_id; chat / shared stay chat-scope
 *                               anchored at chat_id (shared folds into a topic
 *                               post-routing, see maybeApplySharedTopicSeed).
 *
 *  Why we gate on thread_id (not root_id alone): Lark 客户端的引用气泡 / 快速
 *  回复 UI 有时会给"用户视角的顶层消息"塞 root_id 但**不会**塞 thread_id。
 *  飞书官方文档：root_id/parent_id "仅在回复消息场景会有返回值"；thread_id
 *  "不返回说明该消息非话题消息"。所以 thread_id 才是"是否真的处于话题里"的
 *  权威信号。只看 root_id 会把 quote-bubble 错认为话题回复，把用户从 chat-scope
 *  会话里拽走、又起一个孤立的 thread session。
 *  Exported for unit tests. */
export type RoutingSource = 'real-thread' | 'p2p' | 'topic-chat' | 'regular-group-thread' | 'regular-group-chat';

export type RoutingDecision = {
  scope: 'thread' | 'chat';
  anchor: string;
  source: RoutingSource;
};

export function regularGroupRouting(larkAppId: string, messageId: string, chatId: string): RoutingDecision {
  if (regularGroupOverrides(larkAppId, chatId).reuse === false) {
    return { scope: 'thread', anchor: messageId, source: 'regular-group-thread' };
  }
  if (ownerContinuationEnabled(larkAppId, chatId)) {
    return { scope: 'chat', anchor: chatId, source: 'regular-group-chat' };
  }
  // Only `new-topic` forks a fresh thread-scope session for a TOP-LEVEL @.
  // `shared` stays chat-scope here (the topic fold happens post-routing, see
  // maybeApplySharedTopicSeed); `chat` is the flat default; `chat-topic` is also
  // flat at top level (it only diverges for native topics, where the fold is
  // skipped — see maybeFoldMentionedRegularGroupThreadToChat). resolveRegularGroupMode
  // is the single decision point so the modes never both fire.
  if (resolveRegularGroupMode(larkAppId, chatId) === 'new-topic') {
    return { scope: 'thread', anchor: messageId, source: 'regular-group-thread' };
  }
  return { scope: 'chat', anchor: chatId, source: 'regular-group-chat' };
}

export async function decideRoutingWithSource(
  larkAppId: string,
  message: any,
): Promise<RoutingDecision> {
  const rootId: string | undefined = message.root_id;
  const threadId: string | undefined = message.thread_id;
  const chatType: string = message.chat_type ?? 'group';
  const messageId: string = message.message_id;
  const chatId: string = message.chat_id;

  // 私聊 chat 模式：整段 DM 一律折进同一个扁平 chat-scope 会话。必须先于下面的
  // real-thread（root_id+thread_id）分支判断 —— 否则用户在 DM 里"回复某条消息"
  // 形成的 thread 形态消息会被提前分流到 thread-scope，破坏"连续单聊会话"语义
  // （典型触发：thread→chat 模式切换后回复旧 thread，或 Lark 给 DM 回复塞了
  // thread_id）。仅 p2p 且 p2pMode==='chat' 命中，群聊 / p2p 默认 thread 模式不受影响。
  if (chatType === 'p2p' && getBot(larkAppId)?.config?.p2pMode === 'chat') {
    return { scope: 'chat', anchor: chatId, source: 'p2p' };
  }

  if (rootId && threadId) return { scope: 'thread', anchor: rootId, source: 'real-thread' };

  // 私聊默认（thread 模式）：每条 top-level DM 都视为新话题 — 跟话题群同款，匹配
  // Lark DM 的话题化默认行为，避免无限把 1:1 对话塞进同一个 CLI 进程里。
  if (chatType === 'p2p') {
    return { scope: 'thread', anchor: messageId, source: 'p2p' };
  }

  // Group chat — fetch chat_mode (cached) to disambiguate 话题群 from 普通群.
  const mode = await getChatMode(larkAppId, chatId);
  if (mode === 'topic') {
    return { scope: 'thread', anchor: messageId, source: 'topic-chat' };
  }
  return regularGroupRouting(larkAppId, messageId, chatId);
}

export async function decideRouting(
  larkAppId: string,
  message: any,
): Promise<{ scope: 'thread' | 'chat'; anchor: string }> {
  const { scope, anchor } = await decideRoutingWithSource(larkAppId, message);
  return { scope, anchor };
}

export async function classifySummaryChatKind(input: {
  larkAppId: string;
  chatId: string;
  routingSource: RoutingSource;
}): Promise<SummaryChatKind | undefined> {
  if (input.routingSource === 'topic-chat') return 'topic';
  if (input.routingSource === 'regular-group-chat' || input.routingSource === 'regular-group-thread') return 'regularGroup';
  // Real thread replies can occur in topic groups and in regular groups that
  // use threaded replies. Ask Lark for the current chat mode only for explicit
  // /summary so normal routing does not pay this extra lookup.
  if (input.routingSource === 'real-thread') {
    const mode = await getChatMode(input.larkAppId, input.chatId, { forceRefresh: true });
    return mode === 'topic' ? 'topic' : 'regularGroup';
  }
  return undefined;
}
