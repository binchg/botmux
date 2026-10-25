/** 接力会话选择、分页与搜索；由 card-handler.ts 拆分，来源 c397c9af。 */
import { CardActionContext, CARD_ACTION_UNHANDLED } from './card-action-context.js';
import { localeForBot, t } from '../../i18n/index.js';

/** 接力会话选择、分页与搜索；未命中时交给下一处理器。 */
export async function handleRelayPickerAction(context: CardActionContext): Promise<any> {
  const { larkAppId, activeSessions, action, value, operatorOpenId } = context;
  if (value?.action && larkAppId && ['relay_select', 'relay_page', 'relay_search'].includes(value.action as string)) {
    const loc = localeForBot(larkAppId);
    const targetChatId = value.target_chat_id;
    const targetRootId = value.root_id;
    // root_id IS the relay target anchor (chatId for chat-scope, 话题 root for
    // thread-scope). target_scope tells the confirm/re-render which it is;
    // target_chat_type (group | p2p) rides along so confirm can flip the
    // session's chatType for DM targets. Default 'group' covers legacy cards.
    const targetScope = (value.target_scope as 'thread' | 'chat') ?? 'chat';
    const targetChatType = (value.target_chat_type as 'group' | 'p2p') ?? 'group';
    const invokerOpenId = value.invoker_open_id as string | undefined;
    if (!targetChatId || !targetRootId || !operatorOpenId) {
      return { toast: { type: 'error', content: t('card.relay.toast_failed', { error: 'missing_value' }, loc) } };
    }
    // Picker is owner-only: only the user who summoned it may flip pages,
    // search, or select. Otherwise A's invocation in a shared chat could be
    // silently swapped to C's session list when C clicks a button. Cards
    // built before this guard was deployed lack invoker_open_id — we let
    // them through (legacy) rather than break in-flight pickers; new cards
    // are protected from the moment they're rendered.
    if (invokerOpenId && invokerOpenId !== operatorOpenId) {
      return { toast: { type: 'error', content: t('card.relay.toast_not_invoker', undefined, loc) } };
    }

    // Reconstruct the next state from the action.
    const carriedSearch = (value.search as string) ?? '';
    const carriedPage = Number(value.page ?? 0) || 0;
    const carriedSelected = (value.selected as string) ?? '';

    let nextSearch = carriedSearch;
    let nextPage = carriedPage;
    let nextSelected: string | undefined = carriedSelected || undefined;

    if (value.action === 'relay_search') {
      // v2 input fires `behaviors[].callback` directly — the typed text
      // arrives as action.input_value (NOT form_value), since we're no
      // longer wrapping the input in a form. Reset page on new search.
      nextSearch = String((action as any)?.input_value ?? '').trim();
      nextPage = 0;
      // Don't carry over the selection on a new search — the selected entry
      // may not match the new filter, and even if it does, "I just searched
      // for something else" implies the user is changing what they want.
      nextSelected = undefined;
    } else if (value.action === 'relay_page') {
      nextPage = Number(value.page ?? 0) || 0;
    } else if (value.action === 'relay_select') {
      nextSelected = value.session_id;
    }

    // Exclude by the target ANCHOR (root_id), not chatId — keeps 同群 other-
    // topic sessions in the candidate list on re-render, matching初次渲染.
    const { collectRelayPickerEntries } = await import('../../services/relay-picker.js');
    const entries = await collectRelayPickerEntries(activeSessions, larkAppId, targetRootId, operatorOpenId);
    const { buildRelayPickerCard } = await import('./card-builder.js');
    const cardJson = buildRelayPickerCard(
      entries,
      targetChatId,
      targetRootId,
      // Preserve the original invoker so the re-rendered card stays bound
      // to them. Fall back to operatorOpenId for legacy cards rendered
      // before invoker_open_id was added (shouldn't normally happen since
      // the check above already lets legacy through, but a render needs a
      // string regardless).
      invokerOpenId ?? operatorOpenId,
      loc,
      {
        selectedSessionId: nextSelected,
        searchQuery: nextSearch,
        page: nextPage,
      },
      targetScope,
      targetChatType,
    );
    // Return an updated card body — event-dispatcher wraps this as
    // { card: { type: 'raw', data: <body> } } so Lark patches the picker
    // in place rather than appending a new message.
    return JSON.parse(cardJson);
  }
  return CARD_ACTION_UNHANDLED;
}
