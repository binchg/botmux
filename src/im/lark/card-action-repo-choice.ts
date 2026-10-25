/** 仓库下拉选择与异步工作区创建；由 card-handler.ts 拆分，来源 c397c9af。 */
import { CardActionContext } from './card-action-context.js';
import { logger } from '../../utils/logger.js';
import { sessionKey } from '../../core/types.js';
import { canOperate } from './event-dispatcher.js';
import { t, localeForBot } from '../../i18n/index.js';
import { stringListFromLarkMultiSelect, duplicateMultiWorktreeChildNames, worktreeChildNameForRepo, commitRepoSelection } from './card-action-repo-selection.js';
import { join, basename as pathBasename } from 'node:path';
import { tag } from './card-action-session-helpers.js';
import { worktreeSlugFromContextAI } from '../../services/worktree-slug-ai.js';
import { createRepoWorktree, removeRepoWorktree } from '../../services/git-worktree.js';

/** 校验仓库选项后切换或创建工作区，保留异步创建与会话失效检查。 */
export async function handleRepoChoice(context: CardActionContext, option: string): Promise<any> {
  const { larkAppId, activeSessions, lastRepoScan, sessionReply, action, value, cardMessageId, operatorOpenId } = context;
  const isWorktreeOpen = action?.value?.key === 'repo_worktree';
  const selectedPath = option;
  const rootId = action?.value?.root_id;
  logger.info(`Card action: repo ${isWorktreeOpen ? 'worktree-open' : 'switch'} to ${selectedPath} (root_id: ${rootId})`);

  if (!rootId) {
    logger.warn('Card action: no root_id in action value');
    return;
  }

  const targetDs = larkAppId ? activeSessions.get(sessionKey(rootId, larkAppId)) : undefined;
  if (!targetDs) {
    logger.warn(`Card action: no active session found for root ${rootId}`);
    return;
  }

  // 权限边界：pendingRepo（首次选 repo 才能 spawn）放行「会话发起人 或 canOperate」，
  // 让本群授权用户能完成自己的首次使用；非 pending 的 mid-session 切换是管理动作，要 canOperate。
  const isSessionOwnerOp = !!operatorOpenId && operatorOpenId === targetDs.session.ownerOpenId;
  const allowRepo = targetDs.pendingRepo
    ? (isSessionOwnerOp || canOperate(targetDs.larkAppId, targetDs.chatId, operatorOpenId))
    : canOperate(targetDs.larkAppId, targetDs.chatId, operatorOpenId);
  if (!allowRepo) {
    logger.info(`Repo card action blocked for ${operatorOpenId} (pending=${targetDs.pendingRepo})`);
    return { toast: { type: 'error', content: t('card.grant.toast_no_repo_perm', undefined, localeForBot(targetDs.larkAppId)) } };
  }

  // Resolve the project name from cached scan
  const cached = lastRepoScan.get(targetDs.chatId);
  const project = cached?.find(p => p.path === selectedPath);
  const displayName = project ? `${project.name} (${project.branch})` : selectedPath;
  let selectedWorktreePaths = [selectedPath];
  if (isWorktreeOpen && typeof action?.value?.repo_worktree_paths_json === 'string') {
    try {
      selectedWorktreePaths = stringListFromLarkMultiSelect(JSON.parse(action.value.repo_worktree_paths_json));
    } catch {
      selectedWorktreePaths = [];
    }
    if (selectedWorktreePaths.length === 0) {
      return { toast: { type: 'error', content: t('card.repo.worktree_empty', undefined, localeForBot(targetDs.larkAppId)) } };
    }
  }

  const locTarget = localeForBot(targetDs.larkAppId);

  // `/close` deletes the active-map entry without touching sessionId or
  // pendingRepo — identity against the map is the only tell that the session
  // this flow captured is gone. Checked alongside the generation snapshots.
  const repoSessionKey = sessionKey(rootId, larkAppId!);
  const sessionStillActive = () => activeSessions.get(repoSessionKey) === targetDs;

  // Shared commit context for a resolved directory — funnels the dropdown,
  // worktree and manual-entry flows through the same module-level
  // commitRepoSelection (pin dir, then fork pending CLI or close+recreate).
  const commitCtx = { ds: targetDs, rootId, cardMessageId, larkAppId, operatorOpenId, activeSessions, sessionReply };

  if (isWorktreeOpen) {
    // Worktree creation involves a `git fetch` that can take many seconds —
    // ack the card action immediately with a toast and finish asynchronously.
    // On failure the card (and pendingRepo state) stays put so the user can
    // pick again or fall back to a plain switch.
    if (targetDs.worktreeCreating) {
      // The async path escapes the card-action in-flight dedup — gate repeats
      // here, or two creations would race and the loser's commitSelection
      // would yank the session the winner just spawned.
      return { toast: { type: 'info', content: t('cmd.repo.worktree_in_progress', undefined, locTarget) } };
    }
    const parentPath = action?.value?.parent_path;
    if (selectedWorktreePaths.length > 1 && parentPath) {
      const duplicateNames = duplicateMultiWorktreeChildNames(selectedWorktreePaths, cached);
      if (duplicateNames.length > 0) {
        return { toast: { type: 'error', content: t('card.repo.worktree_child_conflict', { names: duplicateNames.join(', ') }, locTarget) } };
      }
    }
    targetDs.worktreeCreating = true;
    // Session generation snapshot: if another selection lands while git runs
    // (pendingRepo consumed, or the session swapped), committing this worktree
    // afterwards would kill that fresh session — notify instead of switching.
    const startSessionId = targetDs.session.sessionId;
    const wasPending = !!targetDs.pendingRepo;
    const sessionChanged = () =>
      !sessionStillActive() ||
      targetDs.session.sessionId !== startSessionId ||
      !!targetDs.pendingRepo !== wasPending;
    const notSwitched = async (creation: { path: string; branch: string }, when: string) => {
      logger.info(`[${tag(targetDs)}] Worktree ${creation.path} created but session changed ${when} — not switching`);
      await sessionReply(rootId, t('cmd.repo.worktree_created_not_switched', { path: creation.path, branch: creation.branch }, locTarget));
    };
    void (async () => {
      try {
        let creation;
        // Track each successful (sourceRepo → created worktree) so a later repo's
        // failure in a multi-repo batch can roll the earlier ones back instead of
        // leaking orphaned worktree dirs/branches.
        const created: Array<{ repo: string; result: { path: string; branch: string; baseRef: string } }> = [];
        try {
          const branch = action?.value?.branch?.trim() || undefined;
          const slug = branch ? undefined : await worktreeSlugFromContextAI(targetDs.session.title, targetDs.pendingPrompt);
          for (const repoPath of selectedWorktreePaths) {
            const result = await createRepoWorktree(repoPath, {
              branch,
              slug,
              worktreePath: selectedWorktreePaths.length > 1 && parentPath
                ? join(parentPath, worktreeChildNameForRepo(repoPath, cached))
                : undefined,
            });
            created.push({ repo: repoPath, result });
          }
          creation = selectedWorktreePaths.length > 1 && parentPath
            ? {
                path: parentPath,
                branch: branch ?? created.map(c => c.result.branch).join(', '),
                baseRef: Array.from(new Set(created.map(c => c.result.baseRef))).join(', '),
              }
            : created[0]!.result;
        } catch (e) {
          // The repo that threw is the one right after the last success.
          const failedRepo = selectedWorktreePaths[created.length] ?? selectedPath;
          const errMsg = e instanceof Error ? e.message : String(e);
          logger.warn(`[${tag(targetDs)}] Worktree creation failed for ${failedRepo}: ${errMsg}`);
          let rolledBack = 0;
          for (const c of created) {
            try { await removeRepoWorktree(c.repo, c.result.path); rolledBack++; }
            catch (re) { logger.warn(`[${tag(targetDs)}] rollback of ${c.result.path} failed: ${re instanceof Error ? re.message : re}`); }
          }
          await sessionReply(rootId, rolledBack > 0
            ? t('card.repo.worktree_rolled_back', { repo: pathBasename(failedRepo), error: errMsg, count: rolledBack }, locTarget)
            : t('cmd.repo.worktree_failed', { error: errMsg }, locTarget));
          return;
        }
        if (sessionChanged()) return notSwitched(creation, 'mid-flight');
        await sessionReply(rootId, t('cmd.repo.worktree_created', {
          path: creation.path, branch: creation.branch, base: creation.baseRef,
        }, locTarget));
        // The reply above awaited a Lark round-trip — a plain switch (which is
        // NOT gated by worktreeCreating) can land in that window. Re-check
        // right before committing, or we'd kill the session it just spawned.
        if (sessionChanged()) return notSwitched(creation, 'during reply');
        try {
          // The "worktree 已创建：…" notice above already confirms the switch —
          // suppress commitRepoSelection's own "已选择/已切换" to avoid a dup.
          await commitRepoSelection(commitCtx, creation.path, `${pathBasename(creation.path)} (${creation.branch})`, { suppressConfirmReply: true });
        } catch (e) {
          // The worktree DOES exist at this point — only the switch failed.
          // Don't report it as a creation failure, or the user retries and
          // trips over "worktree target already exists".
          logger.warn(`[${tag(targetDs)}] Worktree ${creation.path} created but switching failed: ${e instanceof Error ? e.message : e}`);
          await sessionReply(rootId, t('cmd.repo.worktree_switch_failed', { path: creation.path, error: e instanceof Error ? e.message : String(e) }, locTarget));
        }
      } finally {
        targetDs.worktreeCreating = false;
      }
    })();
    return { toast: { type: 'info', content: t('card.repo.toast_worktree_creating', undefined, locTarget) } };
  }

  // Plain switch — blocked while a worktree creation/commit is in flight. The
  // worktree commit awaits (Lark replies, prompt prep) after its generation
  // checks; a plain selection interleaving there would double-fork. One lock
  // gates both kinds until the commit settles.
  if (targetDs.worktreeCreating) {
    return { toast: { type: 'info', content: t('cmd.repo.worktree_in_progress', undefined, locTarget) } };
  }
  await commitRepoSelection(commitCtx, selectedPath, displayName);
}
