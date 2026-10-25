/** 消息去重、快速应答与慢卡片回调补丁；由 event-dispatcher.ts 拆分，来源 c397c9af。 */
import { logger } from '../../utils/logger.js';
import { tag } from './card-action-session-helpers.js';
import { updateMessage } from './client.js';
import { EventHandlers } from './event-types.js';
import { t, localeForBot } from '../../i18n/index.js';
import { handleCardAction } from './card-handler.js';
import { _resetCacheForTest as _resetSeenMessagesForTest } from '../../services/seen-message-store.js';

export const EVENT_CLAIM_TTL_MS = 2 * 60 * 60_000; // 2h — covers the 15s/5min/1h retry tiers
export const EVENT_CLAIM_PRUNE_INTERVAL_MS = 5 * 60_000;
export const EVENT_CLAIM_PRUNE_SIZE = 5000;
export const eventClaims = new Map<string, number>();
export let eventClaimsLastPrunedAt = 0;

export function pruneEventClaims(now = Date.now()): void {
  eventClaimsLastPrunedAt = now;
  for (const [key, expiresAt] of eventClaims) {
    if (expiresAt <= now) eventClaims.delete(key);
  }
}

export function claimEventOnce(key: string): boolean {
  const now = Date.now();
  // Prune under size pressure OR on a time interval, so a busy bot's map stays
  // bounded regardless of call cadence (the size gate alone never fires below
  // the threshold, leaving expired entries pinned for the full TTL).
  if (eventClaims.size > EVENT_CLAIM_PRUNE_SIZE || now - eventClaimsLastPrunedAt > EVENT_CLAIM_PRUNE_INTERVAL_MS) {
    pruneEventClaims(now);
  }
  const expiresAt = eventClaims.get(key);
  if (expiresAt && expiresAt > now) return false;
  eventClaims.set(key, now + EVENT_CLAIM_TTL_MS);
  return true;
}

// `claim` defaults to the in-memory event-id claim; the message path passes a
// persistent message_id claim (claimMessageOnce) so a daemon restart or the 6h
// re-push tier can't replay an already-handled message. The claim MUST be fully
// synchronous (see INVARIANT below) — both claimEventOnce and claimMessageOnce are.
export function scheduleAckSafeEvent(key: string, work: () => Promise<void>, label: string, claim: () => boolean = () => claimEventOnce(key)): void {
  if (!claim()) {
    logger.info(`[event-dedupe] duplicate ${label} ignored: ${key}`);
    return;
  }
  // INVARIANT: the claim above + this setImmediate scheduling must stay fully
  // synchronous (no await before we get here). WS events arrive in order and
  // setImmediate is FIFO, so same-anchor messages reach serializeByAnchor in
  // arrival order ONLY while nothing awaits ahead of the schedule. An await here
  // would reintroduce the kickoff-ordering bug serializeByAnchor guards against.
  setImmediate(() => {
    void work().catch(err => logger.error(`Error handling ${label}: ${err}`));
  });
}

// Fallback for an event that carries no stable id at all. Dedupe must never
// silently DROP a real message, so we hand back a unique key (process it, accept
// a rare duplicate) rather than a content-prefix key that could collide with a
// distinct message and suppress it for the whole TTL.
export let unkeyableEventSeq = 0;
export function unkeyableEventKey(): string {
  return `__unkeyable__:${++unkeyableEventSeq}`;
}

export function eventIdForKey(data: any): string | undefined {
  return data?.event_id ?? data?.uuid ?? data?.header?.event_id ?? data?.event?.event_id;
}

// card.action.trigger is a synchronous callback with a 3s deadline and NO
// re-push (unlike events). If a handler (e.g. restart, which spawns a worker)
// might exceed the budget, we ACK before 3s with a toast and patch the card
// afterwards — missing the deadline otherwise surfaces error 200341 to the user.
// 2500ms leaves headroom for the WS frame round-trip inside the 3s window.
export const CARD_ACTION_ACK_TIMEOUT_MS = 2500;
export const CARD_ACTION_TIMEOUT = Symbol('card-action-timeout');
export const cardActionInFlight = new Set<string>();

export function cardActionMessageId(data: any): string | undefined {
  return data?.context?.open_message_id ?? data?.open_message_id;
}

export function cardActionKey(larkAppId: string, data: any): string {
  const eventId = eventIdForKey(data);
  if (eventId) return `card.action.trigger:${larkAppId}:${eventId}`;
  const action = data?.action;
  const value = action?.value ?? {};
  return `card.action.trigger:${larkAppId}:${JSON.stringify({
    messageId: cardActionMessageId(data),
    operator: data?.operator?.open_id,
    action: value?.action ?? action?.option ?? action?.tag,
    rootId: value?.root_id,
    sessionId: value?.session_id,
    // Detail actions can share action labels across rows; include row ids so
    // rapid clicks on different rows do not collide in the in-flight dedupe key.
    scheduleId: value?.schedule_id,
    runId: value?.run_id,
    nonce: value?.card_nonce ?? value?.nonce,
    option: action?.option,
    key: value?.key,
    // Settings toggles share one action; distinguish the target field/value.
    field: value?.field,
    next_value: value?.next_value,
    // Pagination actions share one action; distinguish the target page.
    page: value?.page,
    // Navigation context and page size affect the card that will be rebuilt.
    origin: value?.origin,
    pageSize: value?.page_size,
    // `dashboard_scope` distinguishes the global tool-panel card from a
    // per-bot view that might happen to be open on the same module. Without
    // it a rapid global→per-bot click sequence within the dedupe window
    // would hash-collide and the second click would be silently dropped.
    dashboardScope: value?.dashboard_scope,
    // Groups detail/actions can share the same `dash_groups_*` action within
    // one card but target different chat/bot cells. Include both ids so
    // managing bot A in group X doesn't dedupe bot B in group Y.
    chatId: value?.chat_id,
    appId: value?.app_id,
  })}`;
}

export function shapeCardActionResult(result: any): any {
  // The handler may return:
  //   - an already-shaped Lark response ({toast} and/or {card}) -> pass through;
  //   - a raw card body (e.g. toggle_stream) -> wrap as an in-place card patch.
  if (result && (result.toast || result.card)) return result;
  if (result) return { card: { type: 'raw', data: result } };
  return undefined;
}

export function serializeRawCardForPatch(cardData: any): string | undefined {
  if (cardData === undefined || cardData === null) return undefined;
  return typeof cardData === 'string' ? cardData : JSON.stringify(cardData);
}

export async function patchTimedOutCardActionResult(larkAppId: string, data: any, shapedResult: any): Promise<void> {
  const messageId = cardActionMessageId(data);
  if (!messageId || !shapedResult?.card) return;
  const card = shapedResult.card;
  const raw = card.type === 'raw' ? card.data : card;
  const body = serializeRawCardForPatch(raw);
  if (!body) return;
  await updateMessage(larkAppId, messageId, body);
}

export async function handleCardActionAckSafe(data: any, larkAppId: string, handlers: EventHandlers): Promise<any> {
  const eventId = eventIdForKey(data);
  const key = cardActionKey(larkAppId, data);

  // Durable dedupe ONLY when the platform gave a stable per-interaction id:
  // suppresses a same-interaction redelivery over the long-connection so a
  // non-idempotent action (restart/close) can't double-fire after the first
  // copy already finished — the in-flight Set alone clears in finally() and
  // would miss that. We deliberately do NOT durably claim the payload-based
  // fallback key: distinct clicks of the same button (e.g. toggling stream
  // on/off) legitimately repeat and must not be pinned for the whole TTL.
  if (eventId && !claimEventOnce(key)) {
    logger.info(`[event-dedupe] duplicate card action ignored (claimed): ${key}`);
    return { toast: { type: 'info', content: t('toast.action_received_no_repeat', undefined, localeForBot(larkAppId)) } };
  }

  if (cardActionInFlight.has(key)) {
    logger.info(`[event-dedupe] duplicate card action ignored while in-flight: ${key}`);
    return { toast: { type: 'info', content: t('toast.action_in_progress', undefined, localeForBot(larkAppId)) } };
  }

  cardActionInFlight.add(key);
  let timedOut = false;
  const work = handlers.handleCardAction(data, larkAppId)
    .then(shapeCardActionResult)
    .catch(err => {
      logger.error(`Error handling card action: ${err}`);
      return undefined;
    });

  void work.then(result => {
    if (!timedOut || !result) return;
    if (!result.card && result.toast) {
      // A toast-only result can't be re-surfaced after we already ACKed with the
      // generic "后台处理中" toast: toasts ride the synchronous callback response,
      // and the message-update API only patches the card. Log rather than drop.
      logger.warn(`[card-action] slow handler resolved to a toast-only result after ACK; not shown to user: ${JSON.stringify(result.toast)}`);
      return;
    }
    return patchTimedOutCardActionResult(larkAppId, data, result)
      .catch(err => logger.warn(`Failed to patch timed-out card action result: ${err}`));
  }).finally(() => {
    cardActionInFlight.delete(key);
  });

  const timeout = new Promise(resolve => setTimeout(resolve, CARD_ACTION_ACK_TIMEOUT_MS, CARD_ACTION_TIMEOUT));
  const result = await Promise.race([work, timeout]);
  if (result === CARD_ACTION_TIMEOUT) {
    timedOut = true;
    logger.warn(`[card-action] handler exceeded ${CARD_ACTION_ACK_TIMEOUT_MS}ms; ACKing first and continuing in background: ${key}`);
    return { toast: { type: 'info', content: t('toast.action_received_bg', undefined, localeForBot(larkAppId)) } };
  }
  return result;
}

/** Test-only: clear callback dedupe claims between cases. */
export function __resetEventClaimsForTest(): void {
  eventClaims.clear();
  cardActionInFlight.clear();
  // The message path now dedupes via the persistent seen-message store; clear its
  // in-memory cache too so cases reusing the same message_id don't suppress each other.
  _resetSeenMessagesForTest();
}
