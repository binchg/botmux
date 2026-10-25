/** 会话绑定校验、旧卡匹配与语音去重；由 card-handler.ts 拆分，来源 c397c9af。 */
import type { DaemonSession } from '../../core/types.js';
import { type Locale, t } from '../../i18n/index.js';
import { sessionKey } from '../../core/types.js';
import { getBot } from '../../bot-registry.js';
import { config } from '../../config.js';
import { logger } from '../../utils/logger.js';

export function tag(ds: DaemonSession): string {
  return ds.session.sessionId.substring(0, 8);
}

export const LEGACY_SELF_HEAL_ACTIONS = new Set(['toggle_display', 'toggle_stream', 'refresh_screenshot']);

// 🔊 语音总结 once-only guard: card message ids that already triggered a voice
// summary. Keyed by the clicked card's message id so any number of users
// clicking the same reply only ever generates ONE voice bubble (防刷屏).
// In-memory (per daemon lifetime) — a restart resets it, which at worst allows
// one re-trigger on an old card; acceptable. Capped to avoid unbounded growth.
export const voicedCardIds = new Set<string>();

// Instruction injected into the session when the voice button is clicked. The
// model (which still has its just-sent reply in context) condenses it into
// spoken prose and emits it via `botmux send --voice`. Kept terse and explicit
// so the model produces ONE voice bubble and no stray text card. Resolved per
// the bot's locale so an English-mode bot gets the English instruction.
export function voiceSummaryInstruction(locale?: Locale): string {
  return t('card.voice.summary_instruction', undefined, locale);
}

export function isLegacySelfHealAction(actionType?: string): boolean {
  return !!actionType && LEGACY_SELF_HEAL_ACTIONS.has(actionType);
}

export function getSessionByActionValue(
  activeSessions: Map<string, DaemonSession>,
  rootId: string | undefined,
  larkAppId: string | undefined,
  sessionId: string | undefined,
  actionType: string | undefined,
): DaemonSession | undefined {
  const primary = rootId && larkAppId ? activeSessions.get(sessionKey(rootId, larkAppId)) : undefined;
  if (primary && (!sessionId || primary.session.sessionId === sessionId)) return primary;

  if (sessionId) {
    for (const ds of activeSessions.values()) {
      if (ds.larkAppId === larkAppId && ds.session.sessionId === sessionId) return ds;
    }
  }

  // Legacy visible cards may carry a stale/closed session_id.  Only redirect
  // self-healing display actions to the current root session; sensitive actions
  // (close/restart/disconnect/get_write_link/term_action/...) must not operate
  // on a different current session just because an old card shared the root.
  if (primary && isLegacySelfHealAction(actionType)) return primary;
  return undefined;
}

export function sessionCliId(ds: DaemonSession) {
  return ds.session.cliId ?? getBot(ds.larkAppId).config.cliId;
}

export function validateCardCliBinding(ds: DaemonSession, value?: Record<string, string>): boolean {
  const expected = value?.cli_id;
  if (!expected) return true;
  const actual = sessionCliId(ds);
  if (actual === expected) return true;

  // Backward-compat migration path: some already-visible Worker(CoCo) cards
  // were rendered with cli_id=claude-code before the binding fix.  Let only
  // display self-healing actions through so the handler can PATCH the clicked
  // card into the current session/CLI.  Never allow stale mismatched cards to
  // trigger sensitive/session-mutating actions.
  if (expected === 'claude-code' && actual !== 'claude-code' && isLegacySelfHealAction(value?.action)) {
    logger.warn(
      `[${tag(ds)}] Accepting legacy mismatched CLI card for self-heal: ` +
      `action=${value?.action ?? '?'} expected=${expected} actual=${actual}`,
    );
    return true;
  }

  logger.warn(
    `[${tag(ds)}] Ignoring card action from mismatched CLI card: ` +
    `action=${value?.action ?? '?'} expected=${expected} actual=${actual}`,
  );
  return false;
}
