/** 工作区选项解析与仓库切换提交；由 card-handler.ts 拆分，来源 c397c9af。 */
import { dirname, join, basename as pathBasename } from 'node:path';
import { dirSuffixForBranch } from '../../services/git-worktree.js';
import type { ProjectInfo } from '../../services/project-scanner.js';
import type { DaemonSession } from '../../core/types.js';
import { localeForBot, t } from '../../i18n/index.js';
import { sessionKey } from '../../core/types.js';
import * as sessionStore from '../../services/session-store.js';
import { getBot } from '../../bot-registry.js';
import { config } from '../../config.js';
import { sessionCliId, tag } from './card-action-session-helpers.js';
import { publishAttentionPatch } from '../../core/session-activity.js';
import { ensureSessionWhiteboard, buildNewTopicPrompt, getAvailableBots, rememberLastCliInput } from '../../core/session-manager.js';
import { logger } from '../../utils/logger.js';
import { forkWorker, killWorker, parkStreamCard, deliverEphemeralOrReply } from '../../core/worker-pool.js';
import { fallbackTurnId } from '../../core/reply-target.js';
import { buildClosedSessionCard } from '../../core/closed-session-card.js';
import { saveFrozenCards } from '../../services/frozen-card-store.js';
import { deleteMessage } from './client.js';

export function stringListFromLarkMultiSelect(raw: unknown): string[] {
  const tokens = Array.isArray(raw)
    ? raw.filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
    : [];
  const seen = new Set<string>();
  const result: string[] = [];
  for (const token of tokens) {
    if (seen.has(token)) continue;
    seen.add(token);
    result.push(token);
  }
  return result;
}

export function multiWorktreeParentPath(repoPaths: string[], name: string): string {
  const first = repoPaths[0];
  const parentRoot = first ? dirname(first) : process.cwd();
  return join(parentRoot, dirSuffixForBranch(name));
}

export function worktreeChildNameForRepo(repoPath: string, projects: ProjectInfo[] | undefined): string {
  return projects?.find(p => p.path === repoPath)?.name ?? pathBasename(repoPath);
}

export function duplicateMultiWorktreeChildNames(repoPaths: string[], projects: ProjectInfo[] | undefined): string[] {
  const seen = new Set<string>();
  const dupes = new Set<string>();
  for (const repoPath of repoPaths) {
    const childName = worktreeChildNameForRepo(repoPath, projects);
    if (seen.has(childName)) dupes.add(childName);
    else seen.add(childName);
  }
  return [...dupes];
}

/**
 * Commit a resolved working directory onto a repo-select session: pin it, then
 * either fork the pending CLI (first selection) or close + recreate the session
 * (mid-session switch). Shared by the dropdown flow, the worktree flow (which
 * funnels back in with the freshly created worktree path) and the manual
 * directory-entry form. Extracted to module scope so the form-submit branch can
 * reuse the exact same spawn/switch path instead of duplicating it.
 */
export async function commitRepoSelection(
  ctx: {
    ds: DaemonSession;
    rootId: string;
    cardMessageId?: string;
    larkAppId?: string;
    operatorOpenId?: string;
    activeSessions: Map<string, DaemonSession>;
    sessionReply: (rid: string, content: string, msgType?: string, turnId?: string) => Promise<string>;
  },
  dirPath: string,
  dirLabel: string,
  // The worktree flow already posted a precise "worktree 已创建：path 分支 …"
  // line before funnelling in here — suppress the redundant "已选择/已切换"
  // confirmation so the user sees a single message, not two.
  opts?: { suppressConfirmReply?: boolean },
): Promise<void> {
  const { ds, rootId, cardMessageId, larkAppId, operatorOpenId, activeSessions, sessionReply } = ctx;
  const locTarget = localeForBot(ds.larkAppId);
  // `/close` deletes the active-map entry without touching sessionId or
  // pendingRepo — identity against the map is the only tell that the session
  // this flow captured is gone. Checked alongside the generation snapshots.
  const repoSessionKey = larkAppId ? sessionKey(rootId, larkAppId) : rootId;
  const sessionStillActive = () => activeSessions.get(repoSessionKey) === ds;
  const commitGenSessionId = ds.session.sessionId;

  if (ds.pendingRepo) {
    // First spawn: pin the new cwd onto the CURRENT session before forking.
    ds.workingDir = dirPath;
    ds.session.workingDir = dirPath;
    sessionStore.updateSession(ds.session);
    const selfBot = getBot(ds.larkAppId);
    const botCfg = selfBot.config;
    const effectiveCliId = sessionCliId(ds);
    // First-time repo selection — now spawn CLI with the original prompt
    ds.pendingRepo = false;
    publishAttentionPatch(ds);
    const pendingPrompt = ds.pendingPrompt ?? '';
    const pendingRawInput = ds.pendingRawInput;
    // Raw-input cold start still wraps any input buffered while the repo card
    // was pending — see the skip_repo branch for the rationale.
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
          locTarget,
          ds.pendingSender,
          { larkAppId: ds.larkAppId, chatId: ds.chatId, whiteboardId: ds.session.whiteboardId },
        )
      : '';
    const prompt = pendingRawInput ? '' : wrappedPrompt;
    // Last-line defence: prompt prep awaited above — if anything replaced
    // OR closed the session in that window, forking now would clobber it
    // (or resurrect a /close'd session).
    if (!sessionStillActive() || ds.session.sessionId !== commitGenSessionId) {
      logger.warn(`[${tag(ds)}] Session replaced or closed while preparing the pending-CLI prompt (${commitGenSessionId} → ${ds.session.sessionId}, active=${sessionStillActive()}) — aborting this fork`);
      return;
    }
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
    // A card click has no turn of its own — anchor the confirmation to the
    // session's current reply-target turn so a shared fold-back topic keeps
    // it in-thread (same leak as the /repo command path).
    if (!opts?.suppressConfirmReply) {
      await sessionReply(rootId, t('cmd.repo.selected_in_pending', { name: dirLabel }, locTarget), undefined, fallbackTurnId(ds, undefined));
    }
    logger.info(`[${tag(ds)}] Repo selected: ${dirPath}, spawning CLI`);
  } else {
    // Mid-session repo switch — close old session, start fresh.
    // Safety net (mirrors the `/repo` text-command path): build the same
    // "session closed" card `/close` emits BEFORE displacing the old session
    // (it reads the live session's identity off `ds`). The new session reuses
    // this anchor, so the old context would otherwise vanish without a trace
    // (relay/adopt/resume all hit `anchor_occupied`). The card keeps it
    // visible and carries the terminal `claude --resume` command.
    //
    // The new cwd is NOT written onto the old session here — it would pollute
    // the displaced session's stored workingDir (and the closed card), so
    // `claude --resume` later would reopen the old context in the new repo's
    // cwd. The new repo is pinned onto the fresh session below instead.
    const closedCard = buildClosedSessionCard(ds, locTarget);

    killWorker(ds);
    // Park the current card in `frozenCards` so the next POST under the new
    // session sweeps it via recall. closeSession() wipes the on-disk
    // frozen-cards file under the OLD sessionId, but the in-memory Map
    // travels with `ds` into the new session and still carries the
    // old messageId for deletion. If fork or POST fails, the parked card
    // stays in the thread instead of vanishing prematurely.
    parkStreamCard(ds);
    sessionStore.closeSession(ds.session.sessionId);

    await deliverEphemeralOrReply(
      ds,
      operatorOpenId,
      closedCard,
      'interactive',
      () => sessionReply(rootId, closedCard, 'interactive'),
    );

    const session = sessionStore.createSession(ds.chatId, rootId, dirLabel, ds.chatType);
    ds.session = session;
    ds.lastUserPrompt = undefined;
    ds.lastCliInput = undefined;
    // Pin workingDir + larkAppId onto the new session before forkWorker.
    // Without this, a daemon restart restores the session with an empty
    // workingDir and the worker spawns in the bot's default cwd, so
    // `claude --resume` looks in the wrong .claude/projects/<hash>/ dir and
    // exits code 0 immediately, crash-looping until the rate-limiter trips.
    ds.workingDir = dirPath;
    ds.session.workingDir = dirPath;
    ds.session.larkAppId = ds.larkAppId;
    sessionStore.updateSession(ds.session);
    ds.hasHistory = false;
    // Re-persist the parked card under the NEW sessionId so a daemon crash
    // before the next POST doesn't strand it. closeSession() above wiped
    // the on-disk file under the OLD sessionId; without this re-save, the
    // in-memory Map only survives in process memory.
    if (ds.frozenCards && ds.frozenCards.size > 0) {
      saveFrozenCards(ds.session.sessionId, ds.frozenCards);
    }
    // Drop the old turn's streaming-card reference so worker_ready POSTs a
    // fresh card for the new session instead of PATCHing the previous one.
    ds.streamCardId = undefined;
    ds.streamCardNonce = undefined;
    ds.streamCardPending = undefined;
    ds.lastScreenContent = undefined;
    ds.lastScreenStatus = undefined;
    forkWorker(ds, '', false);
    if (!opts?.suppressConfirmReply) {
      await sessionReply(rootId, t('cmd.repo.switched_to', { name: dirLabel }, locTarget));
    }
    logger.info(`[${tag(ds)}] Repo switched to ${dirPath}, new session created`);
  }

  // Withdraw the repo selection card
  if (cardMessageId && larkAppId) deleteMessage(larkAppId, cardMessageId);
  ds.repoCardMessageId = undefined;
}
