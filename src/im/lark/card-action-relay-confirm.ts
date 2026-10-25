/** 接力目标核验与会话迁移确认；由 card-handler.ts 拆分，来源 c397c9af。 */
import { CardActionContext, CARD_ACTION_UNHANDLED } from './card-action-context.js';
import { localeForBot, t } from '../../i18n/index.js';
import type { DaemonSession } from '../../core/types.js';
import { sessionAnchorId } from '../../core/types.js';
import { sendMessage, replyMessage, deleteMessage } from './client.js';

/** 接力目标核验与会话迁移确认；未命中时交给下一处理器。 */
export async function handleRelayConfirmAction(context: CardActionContext): Promise<any> {
  const { larkAppId, activeSessions, action, value, cardMessageId, operatorOpenId } = context;
  if (value?.action === 'relay_confirm' && larkAppId) {
    const loc = localeForBot(larkAppId);
    const sourceSessionId = value.session_id;
    const targetChatId = value.target_chat_id;
    const targetRootId = value.root_id;
    // root_id IS the target anchor for thread-scope (the 话题 root); for chat-
    // scope the anchor is chatId and root_id is unused for routing.
    // target_chat_type tells transferSession whether the destination is a DM
    // (p2p) so the session's chatType flips with it; legacy cards lack the
    // field and default to 'group' (their pickers never offered DM targets).
    const targetScope = (value.target_scope as 'thread' | 'chat') ?? 'chat';
    const targetChatType = (value.target_chat_type as 'group' | 'p2p') ?? 'group';
    const targetAnchor = targetScope === 'chat' ? targetChatId : targetRootId;
    const invokerOpenId = value.invoker_open_id as string | undefined;
    if (!sourceSessionId || !targetChatId || !targetRootId) {
      return { toast: { type: 'error', content: t('card.relay.toast_failed', { error: 'missing_value' }, loc) } };
    }
    // Invoker-only confirm: redundant with the ownerOpenId check below in
    // normal flow (invoker = session owner = picker invoker), but defends
    // against the edge case where the source session changed owners after
    // the picker was rendered, OR where the picker was shared/forwarded.
    // Legacy cards (no invoker_open_id) fall through to ownerOpenId only.
    if (invokerOpenId && operatorOpenId && invokerOpenId !== operatorOpenId) {
      return { toast: { type: 'error', content: t('card.relay.toast_not_invoker', undefined, loc) } };
    }
    // Locate the source session in the in-process registry. Since picker only
    // lists sessions of THIS bot in OTHER chats, the source must live in our
    // activeSessions — if it's gone, treat as not found rather than reaching
    // across daemons (cross-daemon pull is out of v1 scope).
    let sourceDs: DaemonSession | undefined;
    for (const cand of activeSessions.values()) {
      if (cand.larkAppId === larkAppId && cand.session.sessionId === sourceSessionId) {
        sourceDs = cand;
        break;
      }
    }
    if (!sourceDs) {
      return { toast: { type: 'error', content: t('card.relay.toast_not_found', undefined, loc) } };
    }
    if (sourceDs.session.ownerOpenId && sourceDs.session.ownerOpenId !== operatorOpenId) {
      return { toast: { type: 'error', content: t('card.relay.toast_not_owner', undefined, loc) } };
    }
    // Anchor-based self-relay guard: a thread-scope source in the SAME chat
    // (different 话题) is a legitimate cross-topic move, so refuse only when the
    // source and target anchors are identical.
    if (sessionAnchorId(sourceDs) === targetAnchor) {
      return { toast: { type: 'error', content: t('card.relay.toast_same_chat', undefined, loc) } };
    }
    // Real-session preflight — done BEFORE M1 send so a refusal doesn't
    // leave a misleading "已接力" announcement in the target chat.
    // collectRelayPickerEntries already filters scratches at render time,
    // but a stale picker (rendered before a scratch was created) could
    // still produce a confirm click; this is the depth defense.
    {
      const { isRelayableRealSession } = await import('../../core/worker-pool.js');
      if (!isRelayableRealSession(sourceDs)) {
        return { toast: { type: 'error', content: t('card.relay.toast_not_started_yet', undefined, loc) } };
      }
    }
    // Pre-flight target-chat conflict check — done BEFORE sendMessage M1 so
    // a refusal doesn't leave a misleading "已接力" announcement in the
    // target chat (王皓 caught this in testing). Mirror the same predicate
    // transferSession uses, plus the `!!worker` filter that excludes daemon
    // command scratch sessions (e.g. the /relay command's own session,
    // which shares the bot's larkAppId + chatId but has no worker).
    const targetConflict = [...activeSessions.values()].find(c =>
      c !== sourceDs
      && c.larkAppId === larkAppId
      && sessionAnchorId(c) === targetAnchor
      && !!c.worker
    );
    if (targetConflict) {
      const conflictTitle = targetConflict.session.title || targetConflict.session.sessionId.substring(0, 8);
      // Send as a regular text message in the target chat instead of a
      // popup toast — per王皓's preference for visible/persistent error
      // ("不要用弹窗，就用消息形式"). No toast returned so the operator
      // sees the chat message land where the error actually applies.
      // Pass raw text — sendMessage wraps text-msgType bodies itself; the
      // earlier `JSON.stringify({text: ...})` caused double-wrapping and
      // Lark rendered the JSON literally (王皓 caught this in the M1).
      const errText = t('cmd.relay.target_has_session_msg', { title: conflictTitle }, loc);
      sendMessage(larkAppId, targetChatId, errText, 'text').catch(() => undefined);
      return;
    }
    // Resolve a friendly source chat label for the M1 announcement — falls
    // back to the raw chatId if Lark can't return a name. A p2p source has no
    // chat name (chat.get often fails or returns empty for DMs) — use the
    // locale-aware 单聊 label instead of leaking a raw oc_ id into the M1.
    const { getChatName } = await import('./client.js');
    const sourceLabel = sourceDs.chatType === 'p2p'
      ? t('card.relay.type_p2p', undefined, loc)
      : (await getChatName(larkAppId, sourceDs.chatId)) ?? sourceDs.chatId;
    // Send the M1 announcement.
    //   chat-scope: a plain top-level message; its id becomes the (audit-only)
    //               rootMessageId after the transfer (mirrors /relay --create).
    //   thread-scope: reply_in_thread INTO the target 话题 (anchor) so the
    //               announcement lands in the 话题; the session anchors on the
    //               话题 root (targetAnchor), NOT the M1 id.
    let m1MessageId: string;
    try {
      const m1Text = t(targetChatType === 'p2p' ? 'cmd.relay.m1_announce_dm' : 'cmd.relay.m1_announce', { sourceChat: sourceLabel, groupName: targetChatId }, loc);
      m1MessageId = targetScope === 'thread'
        ? await replyMessage(larkAppId, targetAnchor, m1Text, 'text', /*replyInThread*/ true)
        : await sendMessage(larkAppId, targetChatId, m1Text, 'text');
    } catch (err: any) {
      return { toast: { type: 'error', content: t('card.relay.toast_failed', { error: err?.message ?? 'send_m1_failed' }, loc) } };
    }
    const { transferSession } = await import('../../core/worker-pool.js');
    // chat-scope → anchor on the M1 id (audit-only); thread-scope → anchor on
    // the 话题 root (targetAnchor) so future replies in the 话题 route here.
    const r = targetScope === 'thread'
      ? await transferSession(sourceDs.session.sessionId, targetChatId, targetAnchor, targetChatType, 'thread')
      : await transferSession(sourceDs.session.sessionId, targetChatId, m1MessageId, targetChatType, 'chat');
    if (!r.ok) {
      // Best-effort: orphan M1 cleanup so a failed transfer doesn't leave a
      // misleading "已接力" message in the target chat (王皓's "明明失败了
      // 却返回成功了" complaint). Race-condition fallback only — the
      // pre-flight checks above should catch the common cases first.
      deleteMessage(larkAppId, m1MessageId).catch(() => { /* leave it */ });
      if (r.error === 'target_chat_has_session') {
        // Lost the race vs the pre-flight check — still surface as a message.
        const errText = t('cmd.relay.target_has_session_msg', { title: '' }, loc);
        sendMessage(larkAppId, targetChatId, errText, 'text').catch(() => undefined);
        return;
      }
      if (r.error === 'adopt_not_relayable') {
        return { toast: { type: 'error', content: t('card.relay.toast_adopt_not_relayable', undefined, loc) } };
      }
      if (r.error === 'worker_busy') {
        return { toast: { type: 'error', content: t('card.relay.toast_worker_busy', undefined, loc) } };
      }
      if (r.error === 'not_started_yet') {
        return { toast: { type: 'error', content: t('card.relay.toast_not_started_yet', undefined, loc) } };
      }
      return { toast: { type: 'error', content: t('card.relay.toast_failed', { error: r.error }, loc) } };
    }
    // Best-effort: remove the picker card now that the selection resolved.
    if (cardMessageId && larkAppId) {
      deleteMessage(larkAppId, cardMessageId).catch(() => { /* leave it */ });
    }
    return { toast: { type: 'success', content: t('card.relay.toast_success', undefined, loc) } };
  }
  return CARD_ACTION_UNHANDLED;
}
