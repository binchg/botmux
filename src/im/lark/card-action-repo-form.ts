/** 仓库选择与工作区表单提交；由 card-handler.ts 拆分，来源 c397c9af。 */
import { SessionCardContext, CARD_ACTION_UNHANDLED } from './card-action-context.js';
import { localeForBot, t } from '../../i18n/index.js';
import { getBot } from '../../bot-registry.js';
import { config } from '../../config.js';
import { sessionCliId, tag } from './card-action-session-helpers.js';
import { publishAttentionPatch } from '../../core/session-activity.js';
import { ensureSessionWhiteboard, buildNewTopicPrompt, getAvailableBots, rememberLastCliInput, getSessionWorkingDir } from '../../core/session-manager.js';
import { join, basename as pathBasename } from 'node:path';
import { forkWorker } from '../../core/worker-pool.js';
import { logger } from '../../utils/logger.js';
import { deleteMessage } from './client.js';
import { validateWorkingDir } from '../../core/working-dir.js';
import { commitRepoSelection, stringListFromLarkMultiSelect, multiWorktreeParentPath, duplicateMultiWorktreeChildNames } from './card-action-repo-selection.js';
import { findConfigField, applyConfigField } from '../../services/bot-config-store.js';
import { buildRepoSelectCard } from './card-builder.js';
import { worktreeSlugFromContextAI } from '../../services/worktree-slug-ai.js';
import { handleCardAction } from './card-handler.js';

/** 仓库选择与工作区表单提交；未命中时交给下一处理器。 */
export async function handleRepoFormAction(context: SessionCardContext): Promise<any> {
  const { data, deps, larkAppId, activeSessions, lastRepoScan, sessionReply, action, value, cardMessageId, operatorOpenId, actionType, rootId, ds } = context;
    if (actionType === 'skip_repo' && ds) {
      const locDs = localeForBot(ds.larkAppId);
      if (ds.pendingRepo) {
        const selfBot = getBot(ds.larkAppId);
        const botCfg = selfBot.config;
        const effectiveCliId = sessionCliId(ds);
        // Skip repo selection — spawn CLI with default working dir
        ds.pendingRepo = false;
        publishAttentionPatch(ds);
        const pendingPrompt = ds.pendingPrompt ?? '';
        const pendingRawInput = ds.pendingRawInput;
        // Raw-input cold start still wraps any input buffered while the repo
        // card was pending (follow-ups / attachments) — delivered right after
        // the raw input on prompt_ready instead of being dropped.
        const hasBufferedInput =
          pendingPrompt.trim().length > 0 ||
          (ds.pendingAttachments?.length ?? 0) > 0 ||
          (ds.pendingFollowUps?.length ?? 0) > 0;
        if (!pendingRawInput || hasBufferedInput) ensureSessionWhiteboard(ds);
        const wrappedPrompt = (!pendingRawInput || hasBufferedInput)
          ? buildNewTopicPrompt(
              pendingPrompt,
              ds.session.sessionId,
              effectiveCliId,
              botCfg.cliPathOverride,
              ds.pendingAttachments,
              ds.pendingMentions,
              await getAvailableBots(ds.larkAppId, ds.chatId),
              ds.pendingFollowUps,
              { name: selfBot.botName, openId: selfBot.botOpenId },
              locDs,
              ds.pendingSender,
              { larkAppId: ds.larkAppId, chatId: ds.chatId, whiteboardId: ds.session.whiteboardId },
            )
          : '';
        const prompt = pendingRawInput ? '' : wrappedPrompt;
        if (pendingRawInput && hasBufferedInput) {
          ds.pendingFollowUpInput = {
            userPrompt: pendingPrompt || (ds.pendingFollowUps?.join('\n\n') ?? ''),
            cliInput: wrappedPrompt,
          };
        }
        rememberLastCliInput(ds, pendingRawInput ?? pendingPrompt, pendingRawInput ?? prompt);
        ds.pendingPrompt = undefined;
        ds.pendingAttachments = undefined;
        ds.pendingMentions = undefined;
        ds.pendingSender = undefined;
        ds.pendingFollowUps = undefined;
        forkWorker(ds, prompt);
        const cwd = getSessionWorkingDir(ds);
        await sessionReply(rootId, t('cmd.skip.opened', { cwd }, locDs));
        logger.info(`[${tag(ds)}] Skip repo, spawning CLI in ${cwd}`);
      } else {
        await sessionReply(rootId, t('card.action.continue_using_current_repo', { cwd: getSessionWorkingDir(ds) }, locDs));
      }
      if (cardMessageId && larkAppId) deleteMessage(larkAppId, cardMessageId);
      ds.repoCardMessageId = undefined;
    }

    // Manual working-directory entry from the repo card form. The project scan
    // may not surface every useful directory; this mirrors `/repo <path>` from
    // the card. Permission is gated at the top (isSensitive + pendingRepoOwner
    // exception), same as skip_repo. Always a plain commit — worktree creation
    // needs a scanned git repo root, not an arbitrary path.
    if (actionType === 'repo_manual_submit' && ds) {
      const locDs = localeForBot(ds.larkAppId);
      const rawPath = String(action?.form_value?.repo_manual_path ?? '').trim();
      if (!rawPath) {
        return { toast: { type: 'error', content: t('card.repo.manual_empty', undefined, locDs) } };
      }
      const validation = validateWorkingDir(rawPath, locDs);
      if (!validation.ok) {
        return { toast: { type: 'error', content: validation.error } };
      }
      // A worktree creation in flight holds the commit lock — a manual switch
      // interleaving there would double-fork (same guard as the plain switch).
      if (ds.worktreeCreating) {
        return { toast: { type: 'info', content: t('cmd.repo.worktree_in_progress', undefined, locDs) } };
      }
      const selectedPath = validation.resolvedPath;
      const displayName = pathBasename(selectedPath) || selectedPath;
      await commitRepoSelection(
        { ds, rootId, cardMessageId, larkAppId, operatorOpenId, activeSessions, sessionReply },
        selectedPath,
        displayName,
      );
    }

    if (actionType === 'worktree_toggle_mode' && ds) {
      // Flip the persisted per-bot worktree picker mode (single ⇄ multi), then
      // re-send a fresh repo card in the new mode — a form can't ride an
      // in-place patch, so the old card is withdrawn and a new one posted.
      const locDs = localeForBot(ds.larkAppId);
      const spec = findConfigField('worktreeMultiPicker');
      if (!spec) return;
      const next = getBot(ds.larkAppId).config.worktreeMultiPicker !== true;
      const r = await applyConfigField(ds.larkAppId, spec, next);
      if (!r.ok) return { toast: { type: 'error', content: t('cmd.config.write_failed', { reason: r.reason }, locDs) } };
      const projects = lastRepoScan.get(ds.chatId) ?? [];
      // await so a rejected delete is caught here (not an unhandled rejection);
      // a missing/already-gone card is fine — we post the fresh one regardless.
      if (ds.repoCardMessageId && ds.larkAppId) { try { await deleteMessage(ds.larkAppId, ds.repoCardMessageId); } catch { /* card already gone */ } }
      const newCard = buildRepoSelectCard(projects, getSessionWorkingDir(ds), rootId, locDs, next);
      ds.repoCardMessageId = await sessionReply(rootId, newCard, 'interactive');
      return { toast: { type: 'info', content: t(next ? 'card.repo.toast_worktree_mode_switched' : 'card.repo.toast_worktree_mode_switched_back', undefined, locDs) } };
    }

    if (actionType === 'repo_worktree_submit' && ds) {
      const locDs = localeForBot(ds.larkAppId);
      const selectedPaths = stringListFromLarkMultiSelect(action?.form_value?.repo_worktree_paths);
      if (selectedPaths.length === 0) {
        return { toast: { type: 'error', content: t('card.repo.worktree_empty', undefined, locDs) } };
      }
      if (ds.worktreeCreating) {
        return { toast: { type: 'info', content: t('cmd.repo.worktree_in_progress', undefined, locDs) } };
      }
      const branch = String(action?.form_value?.repo_worktree_branch ?? '').trim() || undefined;
      const multiParent = selectedPaths.length > 1
        ? multiWorktreeParentPath(selectedPaths, branch ?? await worktreeSlugFromContextAI(ds.session.title, ds.pendingPrompt) ?? 'worktree')
        : undefined;
      if (multiParent) {
        const duplicateNames = duplicateMultiWorktreeChildNames(selectedPaths, lastRepoScan.get(ds.chatId));
        if (duplicateNames.length > 0) {
          return { toast: { type: 'error', content: t('card.repo.worktree_child_conflict', { names: duplicateNames.join(', ') }, locDs) } };
        }
      }
      const rootIdForAction = rootId;
      void handleCardAction({
        ...data,
        action: {
          value: { key: 'repo_worktree', root_id: rootIdForAction, repo_worktree_paths_json: JSON.stringify(selectedPaths), ...(branch ? { branch } : {}), ...(multiParent ? { parent_path: multiParent } : {}) },
          option: selectedPaths[0],
        },
      }, deps, larkAppId);
      return { toast: { type: 'info', content: t('card.repo.toast_worktree_creating', undefined, locDs) } };
    }
  return CARD_ACTION_UNHANDLED;
}
