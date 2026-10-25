/** 消息路由和文档评论回调类型；由 event-dispatcher.ts 拆分，来源 c397c9af。 */
import { type SummaryCommandRuntimeContext } from './summary-command.js';
import { handleCardAction } from './card-handler.js';
import { type DocSubscription } from '../../services/doc-subs-store.js';

export interface RoutingContext {
  chatId: string;
  /** message_id of the inbound message that triggered this routing. */
  messageId: string;
  chatType: 'group' | 'p2p';
  /** 'thread' → reply_in_thread to a (real or freshly seeded) thread root.
   *  'chat'   → plain message to the chat (no threading). */
  scope: 'thread' | 'chat';
  /** Routing key. `chatId` for chat-scope, the thread root id for
   *  thread-scope (an existing rootMessageId, or this messageId when
   *  it's the seed of a brand-new thread). */
  anchor: string;
  /** Chat-scope shared-topic reply target for this turn, if any. */
  replyRootId?: string;
  /** Command prompt that should be sent to the CLI instead of raw text. */
  promptOverride?: string;
  /** Metadata for the summary command that produced promptOverride. */
  summaryCommand?: SummaryCommandRuntimeContext;
  larkAppId: string;
}

export interface EventHandlers {
  handleCardAction: (data: any, larkAppId: string) => Promise<any>;
  handleNewTopic: (data: any, ctx: RoutingContext) => Promise<void>;
  handleThreadReply: (data: any, ctx: RoutingContext) => Promise<void>;
  /** 主动开工 — 场景①: fired when this bot is added to a chat
   *  (`im.chat.member.bot.added_v1`). The daemon decides whether to auto-start
   *  based on the bot's `autoStartOnGroupJoin` toggle + allowedUser membership.
   *  Best-effort fire-and-forget. `operatorOpenId` is who added the bot. */
  handleBotAdded?: (chatId: string, operatorOpenId: string | undefined, larkAppId: string) => Promise<void>;
  /** Check if this bot owns an active session anchored at the given id
   *  (rootMessageId for thread-scope, chatId for chat-scope). */
  isSessionOwner?: (anchor: string, larkAppId: string) => boolean;
  /** Resolve a persisted topic reply alias back to its owning chat-scope session. */
  resolveReplyThreadAlias?: (rootId: string, chatId: string, larkAppId: string) => { chatId: string; sessionId: string } | null;
  /** Fired when the dispatcher detects that a chat with a live chat-scope
   *  session has been converted to topic mode (chat_mode 'group' → 'topic'
   *  via Lark group settings). Daemon should evict the stale chat-scope
   *  session from its activeSessions map so future routing doesn't hit it
   *  and so scheduler/dashboard sends stop going through sendMessage(chatId)
   *  — which in a 话题群 wraps each top-level message in a fresh topic.
   *  Best-effort fire-and-forget; the dispatcher proceeds either way. */
  onChatModeConverted?: (chatId: string, larkAppId: string) => void;
  /** 文档评论入口（/subscribe-lark-doc）：一条命中订阅的文档评论被喂进其绑定
   *  会话。daemon 负责定位会话、投递给 worker、记录该轮回评论的落点。 */
  handleDocComment?: (ctx: DocCommentContext) => Promise<void>;
}

/** 一条已通过订阅 + 触发范围 + 自触发过滤的文档评论，交给 daemon 投递。 */
export interface DocCommentContext {
  larkAppId: string;
  /** 命中的文档订阅（含 sessionAnchor / scope / chatId）。 */
  sub: DocSubscription;
  /** 触发评论的 comment_id。 */
  commentId: string;
  /** 触发的具体回复 id（作 turnId，回评论落点也按它走）；缺省退回 commentId。 */
  replyId?: string;
  /** 评论纯文本（喂给模型的用户消息）。 */
  text: string;
  /** 评论发表者 open_id。 */
  authorOpenId?: string;
}
