/** 历史线程选择与终端接管；由 card-handler.ts 拆分，来源 c397c9af。 */
import { CardActionContext, CARD_ACTION_UNHANDLED } from './card-action-context.js';
import { sessionKey } from '../../core/types.js';
import { canOperate } from './event-dispatcher.js';
import { logger } from '../../utils/logger.js';
import { t, localeForBot } from '../../i18n/index.js';
import { getBot } from '../../bot-registry.js';
import { config } from '../../config.js';
import { getSessionWorkingDir } from '../../core/session-manager.js';
import { deleteMessage } from './client.js';

/** 历史线程选择与终端接管；未命中时交给下一处理器。 */
export async function handleAdoptChoice(context: CardActionContext, option: string): Promise<any> {
  const { deps, larkAppId, activeSessions, lastRepoScan, sessionReply, action, value, cardMessageId, operatorOpenId } = context;
  if (action?.value?.key === 'codex_app_thread_select' && option) {
    const rootId = action?.value?.root_id;
    if (!rootId) return;

    const sKey = larkAppId ? sessionKey(rootId, larkAppId) : rootId;
    const ds = activeSessions.get(sKey);
    if (!ds) return;

    if (!canOperate(ds.larkAppId, ds.chatId, operatorOpenId)) {
      logger.info(`codex_app_thread_select blocked for non-operator user: ${operatorOpenId} (chat=${ds.chatId})`);
      return { toast: { type: 'error', content: t('card.grant.toast_no_repo_perm', undefined, localeForBot(ds.larkAppId)) } };
    }

    let selected: { threadId: string };
    try { selected = JSON.parse(option); } catch { return; }
    if (!selected.threadId) return;

    const botCfg = getBot(ds.larkAppId).config;
    if (botCfg.cliId !== 'codex-app') return;

    const { listCodexAppThreads } = await import('../../services/codex-app-threads.js');
    let threads: Awaited<ReturnType<typeof listCodexAppThreads>>;
    try {
      threads = await listCodexAppThreads({
        codexBin: botCfg.cliPathOverride,
        cwd: getSessionWorkingDir(ds),
        limit: 80,
      });
    } catch (err: any) {
      await sessionReply(rootId, t('cmd.codex_app_adopt.list_failed', { error: err?.message ?? String(err) }, localeForBot(ds.larkAppId)));
      return;
    }
    const target = threads.find(t => t.threadId === selected.threadId);
    if (!target) {
      await sessionReply(rootId, t('cmd.codex_app_adopt.thread_not_found', { threadId: selected.threadId }, localeForBot(ds.larkAppId)));
      if (cardMessageId && larkAppId) deleteMessage(larkAppId, cardMessageId);
      return;
    }

    const { startCodexAppThreadSession } = await import('../../core/command-handler.js');
    await startCodexAppThreadSession(target, ds, { activeSessions, sessionReply: deps.sessionReply, getActiveCount: () => 0, lastRepoScan }, larkAppId);
    if (cardMessageId && larkAppId) deleteMessage(larkAppId, cardMessageId);
    return;
  }

  if (action?.value?.key === 'adopt_select' && option) {
    const rootId = action?.value?.root_id;
    if (!rootId) return;

    const sKey = larkAppId ? sessionKey(rootId, larkAppId) : rootId;
    const ds = activeSessions.get(sKey);
    if (!ds) return;

    // /adopt 是管理动作：下拉入口同样要求 canOperate（命令路径已在 daemon 层 gate）。
    if (!canOperate(ds.larkAppId, ds.chatId, operatorOpenId)) {
      logger.info(`adopt_select blocked for non-operator user: ${operatorOpenId} (chat=${ds.chatId})`);
      return { toast: { type: 'error', content: t('card.grant.toast_no_repo_perm', undefined, localeForBot(ds.larkAppId)) } };
    }

    // Parse selected session info (tmux/herdr: key; zellij: zellijSession+zellijPaneId)
    let selected: { key?: string; source?: string; tmuxTarget?: string; zellijSession?: string; zellijPaneId?: string; cliPid?: number };
    try { selected = JSON.parse(option); } catch { return; }

    // Re-discover to get full session info and validate. Backend determines
    // which discovery to run (re-confirms the pane + pid are still alive).
    const botCfg = getBot(ds.larkAppId).config;
    let target: Awaited<ReturnType<typeof resolveAdoptTarget>>;
    async function resolveAdoptTarget() {
      if (selected.zellijPaneId) {
        const { discoverAdoptableZellijSessions } = await import('../../core/zellij-adopt-discovery.js');
        // Match by (session, paneId) only — a paneId uniquely identifies the
        // pane within a session, and the resolved CLI pid can legitimately
        // differ from the card's snapshot (wrapper⇄native pid shift), so
        // requiring an exact pid match would spuriously report 已退出. Use the
        // freshly-discovered entry (with its current pid).
        return discoverAdoptableZellijSessions(botCfg.cliId)
          .find(s => s.zellijSession === selected.zellijSession && s.zellijPaneId === selected.zellijPaneId);
      }
      const { discoverAdoptableSessions, adoptTargetKey } = await import('../../core/session-discovery.js');
      return discoverAdoptableSessions(botCfg.cliId)
        .find(s => selected.key
          ? adoptTargetKey(s) === selected.key
          : s.tmuxTarget === selected.tmuxTarget && s.cliPid === selected.cliPid);
    }
    // Discovery scans a live process tree and can transiently miss a pane under
    // load (a racing `ps` snapshot); retry a few times before giving up so a
    // momentary miss doesn't surface as "目标 CLI 会话已退出".
    target = await resolveAdoptTarget();
    for (let attempt = 0; !target && attempt < 3; attempt++) {
      await new Promise(r => setTimeout(r, 150));
      target = await resolveAdoptTarget();
    }
    if (!target) {
      await sessionReply(rootId, t('cmd.adopt.target_exited', undefined, localeForBot(ds.larkAppId)));
      if (cardMessageId && larkAppId) deleteMessage(larkAppId, cardMessageId);
      return;
    }

    // Import and call startAdoptSession
    const { startAdoptSession } = await import('../../core/command-handler.js');
    await startAdoptSession(target, ds, { activeSessions, sessionReply: deps.sessionReply, getActiveCount: () => 0, lastRepoScan }, larkAppId);
    if (cardMessageId && larkAppId) deleteMessage(larkAppId, cardMessageId);
    return;
  }

  // Second adopt filter: resume a session discovered on disk (paseo-style
  // import). Re-spawns the bot's CLI via `--resume <id>` in the recorded cwd.
  if (action?.value?.key === 'adopt_resume_select' && option) {
    const rootId = action?.value?.root_id;
    if (!rootId) return;

    const sKey = larkAppId ? sessionKey(rootId, larkAppId) : rootId;
    const ds = activeSessions.get(sKey);
    if (!ds) return;

    if (!canOperate(ds.larkAppId, ds.chatId, operatorOpenId)) {
      logger.info(`adopt_resume_select blocked for non-operator user: ${operatorOpenId} (chat=${ds.chatId})`);
      return { toast: { type: 'error', content: t('card.grant.toast_no_repo_perm', undefined, localeForBot(ds.larkAppId)) } };
    }

    let selected: { cliSessionId?: string; cwd?: string };
    try { selected = JSON.parse(option); } catch { return; }
    if (!selected.cliSessionId) return;

    // Re-discover from disk to validate the session still exists (and is not
    // already live in another botmux session) before committing to the resume.
    const botCfg = getBot(ds.larkAppId).config;
    const { discoverResumableSessionsForBot, startResumeImportSession } = await import('../../core/command-handler.js');
    const resumable = await discoverResumableSessionsForBot(botCfg.cliId, botCfg.cliPathOverride, activeSessions);
    const target = resumable.find(r => r.cliSessionId === selected.cliSessionId);
    if (!target) {
      await sessionReply(rootId, t('cmd.adopt.resume_not_found', { id: selected.cliSessionId }, localeForBot(ds.larkAppId)));
      if (cardMessageId && larkAppId) deleteMessage(larkAppId, cardMessageId);
      return;
    }

    await startResumeImportSession(target, ds, { activeSessions, sessionReply: deps.sessionReply, getActiveCount: () => 0, lastRepoScan }, larkAppId);
    if (cardMessageId && larkAppId) deleteMessage(larkAppId, cardMessageId);
    return;
  }
  return CARD_ACTION_UNHANDLED;
}
