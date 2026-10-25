/** 终端输入、本地终端和操作链接；由 card-handler.ts 拆分，来源 c397c9af。 */
import { SessionCardContext, CARD_ACTION_UNHANDLED } from './card-action-context.js';
import { logger } from '../../utils/logger.js';
import { tag, sessionCliId } from './card-action-session-helpers.js';
import { localeForBot, t } from '../../i18n/index.js';
import { buildTuiPromptCard, buildTuiPromptResolvedCard, buildTuiPromptProcessingCard, getCliDisplayName, buildSessionCard } from './card-builder.js';
import { sessionAnchorId } from '../../core/types.js';
import { updateMessage } from './client.js';
import type { DaemonToWorker } from '../../types.js';
import { join } from 'node:path';
import { publishAttentionPatch } from '../../core/session-activity.js';
import { openLocalTerminalForSession } from '../../core/local-terminal-opener.js';
import { getBot } from '../../bot-registry.js';
import { config } from '../../config.js';
import { buildTerminalUrl } from '../../core/terminal-url.js';
import { deliverWriteLinkCard, deliverEphemeralOrReply } from '../../core/worker-pool.js';

/** 终端输入、本地终端和操作链接；未命中时交给下一处理器。 */
export async function handleTerminalInputAction(context: SessionCardContext): Promise<any> {
  const { larkAppId, sessionReply, action, value, cardMessageId, operatorOpenId, actionType, rootId, ds } = context;
    if (actionType === 'tui_keys' && ds) {
      let keys: string[] = [];
      try { keys = JSON.parse(value?.keys ?? '[]'); } catch { /* bad json */ }
      const isFinal = value?.is_final === '1';
      const optionType = value?.option_type ?? 'select';
      const selectedIndex = Number(value?.selected_index ?? 0);
      const selectedText = value?.selected_text ?? `Option ${selectedIndex + 1}`;

      if (optionType === 'toggle') {
        // Toggle: only update card UI, do NOT send keys to terminal yet.
        // Keys will be sent in batch when confirm is clicked.
        if (!ds.tuiToggledIndices) ds.tuiToggledIndices = [];
        const idx = ds.tuiToggledIndices.indexOf(selectedIndex);
        if (idx >= 0) ds.tuiToggledIndices.splice(idx, 1);
        else ds.tuiToggledIndices.push(selectedIndex);
        logger.info(`[${tag(ds)}] TUI toggle (card only): option ${selectedIndex}, toggled: [${ds.tuiToggledIndices}]`);
        // PATCH card to update ☐/☑ state
        if (cardMessageId && ds.tuiPromptOptions) {
          const locDs = localeForBot(ds.larkAppId);
          const updatedCard = buildTuiPromptCard(
            sessionAnchorId(ds),
            ds.session.sessionId,
            ds.currentTurnTitle || t('card.action.tui_select_title', undefined, locDs),
            ds.tuiPromptOptions,
            true,
            ds.tuiToggledIndices,
            locDs,
          );
          updateMessage(ds.larkAppId, cardMessageId, updatedCard).catch(err =>
            logger.debug(`[${tag(ds)}] Failed to update TUI toggle card: ${err}`),
          );
          try { return JSON.parse(updatedCard); } catch { /* fall through */ }
        }
        return;
      }

      // For confirm: batch all toggled options' keys first, then confirm keys
      if (ds.worker) {
        let allKeys: string[] = [];
        if (ds.tuiToggledIndices?.length && ds.tuiPromptOptions) {
          // Send each toggled option's keys in sequence
          for (const ti of ds.tuiToggledIndices.sort((a, b) => a - b)) {
            const opt = ds.tuiPromptOptions[ti];
            if (opt?.keys?.length) {
              allKeys.push(...opt.keys);
            }
          }
        }
        // Then the action's own keys (confirm/select)
        allKeys.push(...keys);

        if (allKeys.length > 0) {
          ds.worker.send({ type: 'tui_keys', keys: allKeys, isFinal } as DaemonToWorker);
          logger.info(`[${tag(ds)}] TUI keys: [${allKeys.join(',')}] final=${isFinal} — "${selectedText}"`);
        }

        if (isFinal) {
          const resolveText = ds.tuiToggledIndices?.length
            ? ds.tuiToggledIndices.map(i => ds.tuiPromptOptions?.[i]?.text).filter(Boolean).join(', ')
            : selectedText;
          const finalText = resolveText || selectedText;
          const locDs = localeForBot(ds.larkAppId);
          if (cardMessageId) {
            setTimeout(() => {
              const resolvedCard = buildTuiPromptResolvedCard(finalText, locDs);
              updateMessage(ds.larkAppId, cardMessageId, resolvedCard).catch(err =>
                logger.debug(`[${tag(ds)}] Failed to update TUI prompt card: ${err}`),
              );
            }, allKeys.length * 100 + 500);
          }
          ds.tuiPromptCardId = undefined;
          ds.tuiPromptOptions = undefined;
          ds.tuiPromptMultiSelect = undefined;
          ds.tuiToggledIndices = undefined;
          publishAttentionPatch(ds);
          try { return JSON.parse(buildTuiPromptProcessingCard(finalText, locDs)); } catch { /* fall through */ }
        }
      }
    }

    if (actionType === 'tui_text_input' && ds) {
      const inputTextRaw = action?.form_value?.tui_custom_input;
      const inputText = typeof inputTextRaw === 'string' ? inputTextRaw : '';
      let inputKeys: string[] = [];
      try { inputKeys = JSON.parse(value?.input_keys ?? '[]'); } catch { /* bad json */ }
      const locDs = localeForBot(ds.larkAppId);
      if (ds.worker && inputText && inputKeys.length > 0) {
        // Atomic IPC — worker handles keys + text in one flow to avoid race
        ds.worker.send({ type: 'tui_text_input', keys: inputKeys, text: inputText } as DaemonToWorker);
        logger.info(`[${tag(ds)}] TUI text input: "${inputText}" (keys: ${JSON.stringify(inputKeys)})`);
        if (cardMessageId) {
          const resolvedCard = buildTuiPromptResolvedCard(inputText, locDs);
          updateMessage(ds.larkAppId, cardMessageId, resolvedCard).catch(err =>
            logger.debug(`[${tag(ds)}] Failed to update TUI prompt card: ${err}`),
          );
        }
        ds.tuiPromptCardId = undefined;
        ds.tuiPromptOptions = undefined;
        publishAttentionPatch(ds);
      }
      try {
        return JSON.parse(buildTuiPromptResolvedCard(inputText || t('card.action.tui_custom_input', undefined, locDs), locDs));
      } catch { /* fall through */ }
    }

    if (actionType === 'open_local_terminal') {
      const locDs = localeForBot(ds?.larkAppId ?? larkAppId);
      if (!ds) {
        return { toast: { type: 'warning', content: t('card.action.session_gone', undefined, locDs) } };
      }
      const result = openLocalTerminalForSession(ds);
      if (result.ok) {
        logger.info(`[${tag(ds)}] Local terminal open requested via card (${result.launcher}, ${result.backend})`);
        return { toast: { type: 'success', content: t('card.action.local_terminal_opened', { cliName: getCliDisplayName(sessionCliId(ds)) }, locDs) } };
      }
      logger.warn(`[${tag(ds)}] Local terminal open failed: ${result.error}${result.detail ? ` (${result.detail})` : ''}`);
      if (result.error === 'cli_unavailable') {
        return { toast: { type: 'warning', content: t('card.action.local_cli_missing', { cliName: getCliDisplayName(sessionCliId(ds)), executable: result.executable ?? sessionCliId(ds) }, locDs) } };
      }
      if (result.error === 'resume_unavailable' || result.error === 'unsupported_platform' || result.error === 'launcher_unavailable') {
        return { toast: { type: 'warning', content: t('card.action.local_terminal_unsupported', { cliName: getCliDisplayName(sessionCliId(ds)) }, locDs) } };
      }
      return { toast: { type: 'error', content: t('card.action.local_terminal_failed', { reason: result.detail ?? result.error }, locDs) } };
    }

    if (actionType === 'get_write_link' && ds && operatorOpenId) {
      const botCfg = getBot(ds.larkAppId).config;
      const effectiveCliId = sessionCliId(ds);
      const locDs = localeForBot(ds.larkAppId);
      if (ds.workerPort && ds.workerToken) {
        const writeUrl = buildTerminalUrl(ds, { write: true });
        const cardJson = buildSessionCard(
          ds.session.sessionId,
          sessionAnchorId(ds),
          writeUrl,
          ds.session.title || getCliDisplayName(effectiveCliId),
          effectiveCliId,
          true, // showManageButtons — write-link card includes restart & close
          !!ds.adoptedFrom, // adoptMode — disconnect, never close-the-CLI
          locDs,
        );
        // 普通群发「仅自己可见」私密卡，话题群 / 单聊自动回退私聊 DM（两条通道都私密，
        // 不泄露写入 token）。fire-and-forget，保持卡片回调快速返回。
        void deliverWriteLinkCard(ds, operatorOpenId, cardJson);
        // 乐观回执：投递是异步的（话题群要先 ephemeral 失败再 DM，两次往返 await 容易
        // 超过 2500ms 的 ACK 窗口而被丢弃），点完立即弹 toast，让用户知道链接已私密发出。
        return { toast: { type: 'success', content: t('card.action.write_link_sent', undefined, locDs) } };
      } else {
        // 普通群发「仅自己可见」私密卡；话题群 / 单聊不支持 ephemeral，回退为同样内容的
        // 卡片回复（而非纯文本），三种场景都渲染成卡片，行为不变。
        const notReadyCard = JSON.stringify({
          config: { wide_screen_mode: true },
          elements: [{ tag: 'markdown', content: t('card.action.terminal_not_ready', undefined, locDs) }],
        });
        await deliverEphemeralOrReply(ds, operatorOpenId, notReadyCard, 'interactive', () => sessionReply(rootId, notReadyCard, 'interactive'));
      }
    }
  return CARD_ACTION_UNHANDLED;
}
