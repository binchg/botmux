/** 语音、重启、关闭、恢复和重试操作；由 card-handler.ts 拆分，来源 c397c9af。 */
import { SessionCardContext, CARD_ACTION_UNHANDLED } from './card-action-context.js';
import { localeForBot, t } from '../../i18n/index.js';
import { canTalk, canOperate } from './event-dispatcher.js';
import { logger } from '../../utils/logger.js';
import { tag, voicedCardIds, voiceSummaryInstruction, sessionCliId } from './card-action-session-helpers.js';
import { sessionAnchorId } from '../../core/types.js';
import type { DaemonToWorker } from '../../types.js';
import { forkWorker, deliverEphemeralOrReply, killWorker, resolvePrivateCardAudience, clearUsageLimitState, CARD_POSTING_SENTINEL, writableTerminalLinkFor, scheduleCardPatch } from '../../core/worker-pool.js';
import { getBot } from '../../bot-registry.js';
import { config } from '../../config.js';
import { getCliDisplayName, buildStreamingCard } from './card-builder.js';
import { buildClosedSessionCard } from '../../core/closed-session-card.js';
import * as sessionStore from '../../services/session-store.js';
import { sendEphemeralCard } from './client.js';
import { resumeSession, persistStreamCardState } from '../../core/session-manager.js';
import { buildTerminalUrl } from '../../core/terminal-url.js';

/** 语音、重启、关闭、恢复和重试操作；未命中时交给下一处理器。 */
export async function handleLifecycleAction(context: SessionCardContext): Promise<any> {
  const { larkAppId, activeSessions, sessionReply, value, cardMessageId, operatorOpenId, actionType, rootId, sKey, ds } = context;
    if (actionType === 'voice_summary') {
      const locDs = localeForBot(ds?.larkAppId ?? larkAppId);
      if (!ds) {
        return { toast: { type: 'warning', content: t('card.voice.toast_session_gone', undefined, locDs) } };
      }
      // 权限：仅 canTalk / canOperate 用户可点；其他人提示需授权（无声门会让人以为按钮坏了）。
      if (!canTalk(ds.larkAppId, ds.chatId, operatorOpenId) && !canOperate(ds.larkAppId, ds.chatId, operatorOpenId)) {
        logger.info(`[${tag(ds)}] voice_summary blocked for unauthorized user: ${operatorOpenId ?? '?'}`);
        return { toast: { type: 'warning', content: t('card.voice.toast_need_auth', undefined, locDs) } };
      }
      const dedupeKey = cardMessageId ?? `${sessionAnchorId(ds)}::voice`;
      if (voicedCardIds.has(dedupeKey)) {
        return { toast: { type: 'info', content: t('card.voice.toast_already', undefined, locDs) } };
      }
      voicedCardIds.add(dedupeKey);
      if (voicedCardIds.size > 5000) { voicedCardIds.clear(); voicedCardIds.add(dedupeKey); }
      if (ds.worker && !ds.worker.killed) {
        ds.worker.send({ type: 'message', content: voiceSummaryInstruction(locDs) } as DaemonToWorker);
      } else {
        forkWorker(ds, voiceSummaryInstruction(locDs), ds.hasHistory);
      }
      logger.info(`[${tag(ds)}] voice_summary triggered by ${operatorOpenId ?? '?'}`);
      return { toast: { type: 'success', content: t('card.voice.toast_wait', undefined, locDs) } };
    }

    if (actionType === 'restart' && ds) {
      // Adopt sessions: hard-reject. botmux never owned the user's CLI;
      // restarting would mean killing their tmux pane / Claude process,
      // which violates the bridge invariant. Defense in depth — buildSessionCard
      // already omits the restart button when adoptMode=true, but a stale
      // pre-fix card or a malformed action payload could still arrive.
      const locDs = localeForBot(ds.larkAppId);
      if (ds.adoptedFrom) {
        logger.warn(`[${tag(ds)}] Rejected restart on adopt session — would kill user's pane`);
        await sessionReply(rootId, t('card.action.adopt_no_restart', undefined, locDs));
        return;
      }
      const botCfg = getBot(ds.larkAppId).config;
      const effectiveCliId = sessionCliId(ds);
      if (ds.worker) {
        logger.info(`[${tag(ds)}] Restart via card button`);
        ds.worker.send({ type: 'restart' } as DaemonToWorker);
        const cliName = getCliDisplayName(effectiveCliId);
        const restartedMsg = t('card.action.restarted', { cliName }, locDs);
        await deliverEphemeralOrReply(ds, operatorOpenId, restartedMsg, 'text', () => sessionReply(rootId, restartedMsg));
      } else {
        logger.info(`[${tag(ds)}] Re-forking worker via card button`);
        forkWorker(ds, '', ds.hasHistory);
        const cliName = getCliDisplayName(effectiveCliId);
        const restartedFreshMsg = t('card.action.restarted_fresh', { cliName }, locDs);
        await deliverEphemeralOrReply(ds, operatorOpenId, restartedFreshMsg, 'text', () => sessionReply(rootId, restartedFreshMsg));
        // DM card will be sent by the ready handler when worker starts
      }
    }

    if (actionType === 'close') {
      if (!ds) {
        // 会话已不在 activeSessions（已关过 / 卡片过期 / daemon 重启丢失）——点「关闭
        // 会话」却静默无反应会让人以为按钮坏了，给一条失败 toast（成功路径不弹，已关卡即反馈）。
        return { toast: { type: 'warning', content: t('card.action.session_gone', undefined, localeForBot(larkAppId)) } };
      }
      const botCfg = getBot(ds.larkAppId).config;
      // Build the closed card BEFORE killWorker/closeSession — it reads the
      // live session's identity off `ds`.
      const card = buildClosedSessionCard(ds, localeForBot(ds.larkAppId));
      killWorker(ds);
      sessionStore.closeSession(ds.session.sessionId);
      activeSessions.delete(sKey);
      // The closed card carries session title / CLI name / workingDir / resume
      // command. In private-card mode those must not leak to the group — send the
      // closed card ephemeral to the same owner audience instead. No group
      // fallback on failure (privacy wins; the session is already closed).
      // `value.visibility === 'private'` pins the decision to the card that was
      // clicked, so a card built in private mode stays ephemeral even if the
      // bot's `privateCard` config was turned off in the meantime.
      if (value?.visibility === 'private' || botCfg.privateCard) {
        const audience = resolvePrivateCardAudience(ds);
        for (const openId of audience) {
          await sendEphemeralCard(ds.larkAppId, ds.chatId, openId, card).catch(err =>
            logger.warn(`[${tag(ds)}] private close card ephemeral send to ${openId.substring(0, 8)}… failed: ${err}`));
        }
        logger.info(`[${tag(ds)}] Closed via card button (private close card → ${audience.length} owner(s))`);
      } else {
        await deliverEphemeralOrReply(ds, operatorOpenId, card, 'interactive', () => sessionReply(rootId, card, 'interactive'));
        logger.info(`[${tag(ds)}] Closed via card button`);
      }
    }

    if (actionType === 'resume') {
      const targetSessionId = value?.session_id;
      const locDsResume = localeForBot(ds?.larkAppId ?? larkAppId);
      if (!targetSessionId) {
        await sessionReply(rootId, t('card.action.resume_missing_session_id', undefined, locDsResume));
      } else {
        const result = await resumeSession(targetSessionId, activeSessions);
        if (result.ok) {
          const cliName = getCliDisplayName(result.ds.session.cliId ?? getBot(result.ds.larkAppId).config.cliId);
          const resumeMsg = t('card.action.resume_success', { cliName }, localeForBot(result.ds.larkAppId));
          await deliverEphemeralOrReply(result.ds, operatorOpenId, resumeMsg, 'text', () => sessionReply(rootId, resumeMsg));
          logger.info(`[${targetSessionId.substring(0, 8)}] Resumed via card button`);
        } else if (result.error === 'not_found') {
          await sessionReply(rootId, t('card.action.resume_not_found', { short: targetSessionId.substring(0, 8) }, locDsResume));
        } else if (result.error === 'not_closed') {
          await sessionReply(rootId, t('card.action.resume_not_closed', undefined, locDsResume));
        } else if (result.error === 'anchor_occupied') {
          const detail = result.activeSessionId
            ? t('card.action.resume_anchor_holder', { short: result.activeSessionId.substring(0, 8) }, locDsResume)
            : '';
          await sessionReply(rootId, t('card.action.resume_anchor_occupied', { detail }, locDsResume));
        } else if (result.error === 'adopt_unsupported') {
          await sessionReply(rootId, t('card.action.resume_adopt_unsupported', undefined, locDsResume));
        }
      }
    }

    if (actionType === 'disconnect' && ds) {
      killWorker(ds);
      sessionStore.closeSession(ds.session.sessionId);
      activeSessions.delete(sKey);
      await sessionReply(rootId, t('card.action.disconnected', undefined, localeForBot(ds.larkAppId)));
      logger.info(`[${tag(ds)}] Disconnected (adopt) via card button`);
    }

    if (actionType === 'takeover' && ds && ds.adoptedFrom) {
      await sessionReply(rootId, t('card.action.takeover_retired', undefined, localeForBot(ds.larkAppId)));
      logger.info(`[${tag(ds)}] Legacy takeover action ignored (bridge era; historical card)`);
    }

    if (actionType === 'retry_last_task' && ds) {
      const locDs = localeForBot(ds.larkAppId);
      const cliInput = ds.lastCliInput;
      if (!cliInput) {
        await sessionReply(rootId, t('card.action.retry_last_task_missing', undefined, locDs));
        return;
      }
      if (!ds.usageLimit) {
        await sessionReply(rootId, t('card.action.retry_last_task_unavailable', undefined, locDs));
        return;
      }
      if (!ds.usageLimit.retryReady && ds.usageLimit.retryAtMs > Date.now()) {
        await sessionReply(rootId, t('card.action.retry_last_task_not_ready', { retryLabel: ds.usageLimit.retryLabel }, locDs));
        return;
      }

      clearUsageLimitState(ds);
      ds.lastScreenStatus = 'working';
      ds.streamCardPending = true;
      ds.currentTurnTitle = (ds.lastUserPrompt || ds.currentTurnTitle || ds.session.title || getCliDisplayName(sessionCliId(ds))).substring(0, 50);
      ds.currentImageKey = undefined;
      persistStreamCardState(ds);

      let cardJson: string | undefined;
      if (ds.streamCardId && ds.streamCardId !== CARD_POSTING_SENTINEL && ds.workerPort) {
        const readUrl = buildTerminalUrl(ds);
        cardJson = buildStreamingCard(
          ds.session.sessionId,
          sessionAnchorId(ds),
          readUrl,
          ds.currentTurnTitle,
          '',
          'working',
          sessionCliId(ds),
          ds.displayMode ?? 'hidden',
          ds.streamCardNonce,
          ds.currentImageKey,
          !!ds.adoptedFrom,
          false,
          locDs,
          undefined,
          writableTerminalLinkFor(ds),
        );
        scheduleCardPatch(ds, cardJson);
      }

      if (ds.worker && !ds.worker.killed) {
        ds.worker.send({ type: 'message', content: cliInput } as DaemonToWorker);
      } else {
        forkWorker(ds, cliInput, ds.hasHistory);
      }
      logger.info(`[${tag(ds)}] Retrying last task after usage limit`);
      if (cardJson) {
        try { return JSON.parse(cardJson); } catch { /* fall through */ }
      }
      return;
    }
  return CARD_ACTION_UNHANDLED;
}
