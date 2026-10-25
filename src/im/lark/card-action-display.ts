/** 卡片展示模式、截图和终端快捷键；由 card-handler.ts 拆分，来源 c397c9af。 */
import { SessionCardContext, CARD_ACTION_UNHANDLED } from './card-action-context.js';
import { t, localeForBot } from '../../i18n/index.js';
import type { DisplayMode, DaemonToWorker, TermActionKey } from '../../types.js';
import { loadFrozenCards, saveFrozenCards } from '../../services/frozen-card-store.js';
import { sessionCliId, tag } from './card-action-session-helpers.js';
import { persistStreamCardState } from '../../core/session-manager.js';
import { buildTerminalUrl } from '../../core/terminal-url.js';
import { getCliDisplayName, buildStreamingCard, truncateContent } from './card-builder.js';
import { sessionAnchorId, frozenDisplayMode } from '../../core/types.js';
import { cardUsageLimit, writableTerminalLinkFor, scheduleCardPatch, CARD_POSTING_SENTINEL } from '../../core/worker-pool.js';
import { updateMessage } from './client.js';
import { logger } from '../../utils/logger.js';
import { getBot } from '../../bot-registry.js';
import { config } from '../../config.js';

/** 卡片展示模式、截图和终端快捷键；未命中时交给下一处理器。 */
export async function handleDisplayAction(context: SessionCardContext): Promise<any> {
  const { larkAppId, sessionReply, value, cardMessageId, actionType, ds } = context;
    if (actionType === 'toggle_display' || actionType === 'toggle_stream') {
      if (!ds) {
        // 同 close：会话已不在线时「显示 / 隐藏输出」静默无反应 → 给失败 toast（成功不弹）。
        return { toast: { type: 'warning', content: t('card.action.session_gone', undefined, localeForBot(larkAppId)) } };
      }
      const clickedNonce: string | undefined = value?.card_nonce;
      const isFrozenClick = clickedNonce && ds.streamCardNonce && clickedNonce !== ds.streamCardNonce;

      const nextMode = (current: DisplayMode): DisplayMode =>
        current === 'hidden' ? 'screenshot' : 'hidden';

      if (isFrozenClick) {
        // Historical card — toggle using cached state
        if (!ds.frozenCards) ds.frozenCards = loadFrozenCards(ds.session.sessionId);
        const frozen = ds.frozenCards.get(clickedNonce!);
        if (!frozen) {
          // The clicked card can predate the frozen-card cache for the current
          // active session (e.g. a stale Worker card whose session_id/card_nonce
          // came from a now-closed session). Migrate the visible card to the
          // current root session/CLI instead of leaving stale terminal URL/chrome.
          const effectiveCliId = sessionCliId(ds);
          const cur: DisplayMode = ds.displayMode ?? 'hidden';
          const next = nextMode(cur);
          ds.displayMode = next;
          persistStreamCardState(ds);
          if (ds.worker) {
            ds.worker.send({ type: 'set_display_mode', mode: next } as DaemonToWorker);
          }
          if (cardMessageId && ds.workerPort) {
            const readUrl = buildTerminalUrl(ds);
            const turnTitle = ds.currentTurnTitle || ds.session.title || getCliDisplayName(effectiveCliId);
            const cardJson = buildStreamingCard(
              ds.session.sessionId,
              sessionAnchorId(ds),
              readUrl,
              turnTitle,
              ds.lastScreenContent || '',
              ds.lastScreenStatus || 'working',
              effectiveCliId,
              next,
              ds.streamCardNonce,
              ds.currentImageKey,
              !!ds.adoptedFrom,
              false,
              localeForBot(ds.larkAppId),
              cardUsageLimit(ds),
              writableTerminalLinkFor(ds),
            );
            updateMessage(ds.larkAppId, cardMessageId, cardJson).catch(err =>
              logger.debug(`[${tag(ds)}] Failed to migrate unknown frozen card: ${err}`),
            );
            logger.info(`[${tag(ds)}] Migrated unknown frozen card to ${next} (legacy nonce=${clickedNonce})`);
            try { return JSON.parse(cardJson); } catch { /* fall through */ }
          }
          logger.debug(`[${tag(ds)}] Toggle on unknown frozen card could not migrate: nonce=${clickedNonce}`);
          return;
        }
        // Self-heal known historical cards by migrating the clicked card to the
        // current live session/CLI instead of rebuilding from cached frozen
        // title/content/imageKey. The cache may have been persisted while this
        // thread was bound to a different CLI (or before cli_id existed), and
        // reusing its imageKey is exactly what makes a second click snap back to
        // an old Claude Code screenshot.
        const cur: DisplayMode = ds.displayMode ?? frozenDisplayMode(frozen);
        const next = nextMode(cur);
        ds.displayMode = next;
        persistStreamCardState(ds);
        if (ds.worker) {
          ds.worker.send({ type: 'set_display_mode', mode: next } as DaemonToWorker);
        }
        const effectiveCliId = sessionCliId(ds);
        const readUrl = ds.workerPort ? buildTerminalUrl(ds) : '';
        const turnTitle = ds.currentTurnTitle || ds.session.title || getCliDisplayName(effectiveCliId);
        const cardJson = buildStreamingCard(
          ds.session.sessionId,
          sessionAnchorId(ds),
          readUrl,
          turnTitle,
          ds.lastScreenContent || '',
          ds.lastScreenStatus || 'working',
          effectiveCliId,
          next,
          ds.streamCardNonce,
          ds.currentImageKey,
          !!ds.adoptedFrom,
          false,
          localeForBot(ds.larkAppId),
          cardUsageLimit(ds),
          writableTerminalLinkFor(ds),
        );
        updateMessage(ds.larkAppId, frozen.messageId, cardJson).catch(err =>
          logger.debug(`[${tag(ds)}] Failed to migrate frozen card: ${err}`),
        );
        ds.frozenCards.delete(clickedNonce!);
        saveFrozenCards(ds.session.sessionId, ds.frozenCards);
        logger.info(`[${tag(ds)}] Migrated frozen card to current ${next} (legacy nonce=${clickedNonce})`);
        try { return JSON.parse(cardJson); } catch { /* fall through */ }
        return;
      }

      // Current (latest) card — change displayMode + tell worker
      const botCfg = getBot(ds.larkAppId).config;
      const effectiveCliId = sessionCliId(ds);
      const cur: DisplayMode = ds.displayMode ?? 'hidden';
      const next = nextMode(cur);
      ds.displayMode = next;
      persistStreamCardState(ds);
      if (ds.worker) {
        ds.worker.send({ type: 'set_display_mode', mode: next } as DaemonToWorker);
      }
      if (ds.streamCardId && ds.workerPort) {
        const readUrl = buildTerminalUrl(ds);
        const turnTitle = ds.currentTurnTitle || ds.session.title || getCliDisplayName(effectiveCliId);
        const cardJson = buildStreamingCard(
          ds.session.sessionId,
          sessionAnchorId(ds),
          readUrl,
          turnTitle,
          ds.lastScreenContent || '',
          ds.lastScreenStatus || 'working',
          effectiveCliId,
          next,
          ds.streamCardNonce,
          ds.currentImageKey,
          !!ds.adoptedFrom,
          false,
          localeForBot(ds.larkAppId),
          cardUsageLimit(ds),
          writableTerminalLinkFor(ds),
        );
        if (cardMessageId && cardMessageId !== ds.streamCardId) {
          updateMessage(ds.larkAppId, cardMessageId, cardJson).catch(err =>
            logger.debug(`[${tag(ds)}] Failed to migrate clicked legacy card: ${err}`),
          );
        } else {
          scheduleCardPatch(ds, cardJson);
        }
        logger.info(`[${tag(ds)}] Display mode → ${next}`);
        try { return JSON.parse(cardJson); } catch { /* fall through */ }
      }
      logger.info(`[${tag(ds)}] Display mode → ${next}`);
      return;
    }

    // Export current terminal text as a thread reply. One-shot action — the
    // card body itself stays in screenshot mode. For frozen cards, export
    // from the cached frozen content; for the live card, use ds.lastScreenContent.
    if (actionType === 'export_text' && ds) {
      const clickedNonce: string | undefined = value?.card_nonce;
      const isFrozenClick = clickedNonce && ds.streamCardNonce && clickedNonce !== ds.streamCardNonce;
      let content = '';
      if (isFrozenClick) {
        if (!ds.frozenCards) ds.frozenCards = loadFrozenCards(ds.session.sessionId);
        content = ds.frozenCards.get(clickedNonce!)?.content ?? '';
      } else {
        content = ds.lastScreenContent ?? '';
      }
      const locDs = localeForBot(ds.larkAppId);
      const body = content.trim() ? truncateContent(content, locDs) : t('card.action.no_output', undefined, locDs);
      await sessionReply(sessionAnchorId(ds), body);
      logger.info(`[${tag(ds)}] Exported terminal text (${body.length} chars)`);
      return;
    }

    // Manual screenshot refresh — force immediate capture bypassing 10s interval + hash dedup.
    if (actionType === 'refresh_screenshot' && ds) {
      if (ds.worker) {
        ds.worker.send({ type: 'refresh_screen' } as DaemonToWorker);
        logger.info(`[${tag(ds)}] Manual screenshot refresh`);
      }
      // Return the current card JSON so Feishu doesn't revert the displayed
      // image to the originally-POSTed initial frame while waiting for the
      // fresh screenshot PATCH (~1s).
      if (ds.streamCardId && ds.streamCardId !== CARD_POSTING_SENTINEL && ds.workerPort) {
        const botCfg = getBot(ds.larkAppId).config;
        const effectiveCliId = sessionCliId(ds);
        const readUrl = buildTerminalUrl(ds);
        const turnTitle = ds.currentTurnTitle || ds.session.title || getCliDisplayName(effectiveCliId);
        const cardJson = buildStreamingCard(
          ds.session.sessionId,
          sessionAnchorId(ds),
          readUrl,
          turnTitle,
          ds.lastScreenContent || '',
          ds.lastScreenStatus || 'working',
          effectiveCliId,
          ds.displayMode ?? 'screenshot',
          ds.streamCardNonce,
          ds.currentImageKey,
          !!ds.adoptedFrom,
          false,
          localeForBot(ds.larkAppId),
          cardUsageLimit(ds),
          writableTerminalLinkFor(ds),
        );
        if (cardMessageId && cardMessageId !== ds.streamCardId) {
          updateMessage(ds.larkAppId, cardMessageId, cardJson).catch(err =>
            logger.debug(`[${tag(ds)}] Failed to migrate clicked legacy card: ${err}`),
          );
        }
        try { return JSON.parse(cardJson); } catch { /* fall through */ }
      }
      return;
    }

    // Quick-action keys (Esc, ^C, Tab, Space, Enter, ←↑↓→, ½ page) — forward to worker.
    if (actionType === 'term_action' && ds) {
      const key = value?.key as TermActionKey | undefined;
      if (!key) return;
      if (ds.worker) {
        ds.worker.send({ type: 'term_action', key } as DaemonToWorker);
        logger.info(`[${tag(ds)}] term_action: ${key}`);
      }
      if (ds.streamCardId && ds.streamCardId !== CARD_POSTING_SENTINEL && ds.workerPort) {
        const botCfg = getBot(ds.larkAppId).config;
        const effectiveCliId = sessionCliId(ds);
        const readUrl = buildTerminalUrl(ds);
        const turnTitle = ds.currentTurnTitle || ds.session.title || getCliDisplayName(effectiveCliId);
        const cardJson = buildStreamingCard(
          ds.session.sessionId,
          sessionAnchorId(ds),
          readUrl,
          turnTitle,
          ds.lastScreenContent || '',
          ds.lastScreenStatus || 'working',
          effectiveCliId,
          ds.displayMode ?? 'screenshot',
          ds.streamCardNonce,
          ds.currentImageKey,
          !!ds.adoptedFrom,
          false,
          localeForBot(ds.larkAppId),
          cardUsageLimit(ds),
          writableTerminalLinkFor(ds),
        );
        try { return JSON.parse(cardJson); } catch { /* fall through */ }
      }
      return;
    }
  return CARD_ACTION_UNHANDLED;
}
