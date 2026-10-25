/** 敏感操作的用户和会话权限校验；由 card-handler.ts 拆分，来源 c397c9af。 */
import { CardActionContext, CARD_ACTION_UNHANDLED } from './card-action-context.js';
import { getSessionByActionValue } from './card-action-session-helpers.js';
import * as sessionStore from '../../services/session-store.js';
import { canOperate } from './event-dispatcher.js';
import { logger } from '../../utils/logger.js';
import { t, localeForBot } from '../../i18n/index.js';
import { getAllBots } from '../../bot-registry.js';
import { config } from '../../config.js';

/** 敏感操作的用户和会话权限校验；未命中时交给下一处理器。 */
export async function checkCardActionPermission(context: CardActionContext): Promise<any> {
  const { larkAppId, activeSessions, action, value, operatorOpenId } = context;
  const isSensitive = value?.action && ['restart', 'close', 'resume', 'skip_repo', 'repo_manual_submit', 'repo_worktree_submit', 'worktree_toggle_mode', 'retry_last_task', 'get_write_link', 'open_local_terminal', 'toggle_stream', 'toggle_display', 'export_text', 'term_action', 'refresh_screenshot', 'takeover', 'disconnect', 'tui_keys', 'tui_text_input', 'wf_approve', 'wf_reject', 'wf_cancel'].includes(value.action);
  if (isSensitive) {
    const rootId = value?.root_id;
    // activeSessions is keyed by sessionKey(anchor, larkAppId) — `${anchor}::${larkAppId}`
    // (double colon). Earlier this was hand-spliced with a single colon and
    // always missed, falling through to the bare-rootId legacy lookup; that
    // worked for permission gating only because chatId came from elsewhere
    // most of the time. Use sessionKey() so the bot-scoped lookup actually
    // hits, and keep the bare-rootId fallback for legacy single-bot cards.
    const ds = rootId
      ? (larkAppId
          ? getSessionByActionValue(activeSessions, rootId, larkAppId, value?.session_id, value?.action)
          : activeSessions.get(rootId))
      : undefined;
    // Resume targets a closed session — fall back to the persistent store so
    // we can still pin chatId/larkAppId for the canOperate gate.
    const closedForCtx = !ds && value?.action === 'resume' && value?.session_id
      ? sessionStore.getSession(value.session_id)
      : undefined;
    const effectiveAppId = larkAppId ?? ds?.larkAppId ?? closedForCtx?.larkAppId;
    const chatId = ds?.chatId ?? closedForCtx?.chatId;
    // pendingRepo 阶段，会话发起人（含 chat-granted 用户）可以 skip_repo / 手动填目录
    // 起会话——与 repo 下拉选择同款例外，否则被授权人连自己的首次会话都启动不了。
    // 注意：worktree_toggle_mode 故意不在此列——它持久写 bot 级 worktreeMultiPicker
    // （影响该 bot 所有后续会话），属管理动作，必须走 canOperate，不能让 talk-only/
    // chat-granted 用户借「开自己的 pending 卡」绕过去改 bot 配置。
    const pendingRepoOwnerException =
      (value.action === 'skip_repo' || value.action === 'repo_manual_submit' || value.action === 'repo_worktree_submit') && !!ds?.pendingRepo &&
      !!operatorOpenId && operatorOpenId === ds.session.ownerOpenId;
    if (effectiveAppId) {
      if (!pendingRepoOwnerException && !canOperate(effectiveAppId, chatId, operatorOpenId)) {
        logger.info(`Card action "${value.action}" blocked for non-operator user: ${operatorOpenId} (chat=${chatId})`);
        // get_write_link 显式破例：其余敏感动作沿用「静默 block（仅日志）」的既有设计
        // （test/card-handler-repo-select.test.ts 把这点 pin 住了），但「获取操作链接」是
        // 用户主动点的取权动作，静默会让人以为按钮坏了——给一条明确的「无操作权限」toast。
        if (value.action === 'get_write_link' || value.action === 'open_local_terminal') {
          const key = value.action === 'open_local_terminal'
            ? 'card.action.local_terminal_no_permission'
            : 'card.action.write_link_no_permission';
          return { toast: { type: 'warning', content: t(key, undefined, localeForBot(effectiveAppId)) } };
        }
        return;
      }
    } else {
      const bots = getAllBots();
      const allowedUsers = bots.flatMap(b => b.resolvedAllowedUsers);
      // globalGrants 与 allowedChatGroups 同理计入 hasAllowlist：只配 globalGrants（talk-only）
      // 也算限制态，否则这条手写 fallback 会算成 false → 敏感动作 fall through 成全开放。
      // 注意只进 hasAllowlist 判定，命中仍只认 allowedUsers（与 canOperate 一致，不授 operate）。
      const hasAllowlist = allowedUsers.length > 0
        || bots.some(b => (b.config.allowedChatGroups?.length ?? 0) > 0)
        || bots.some(b => (b.config.globalGrants?.length ?? 0) > 0);
      if (hasAllowlist && (!operatorOpenId || !allowedUsers.includes(operatorOpenId))) {
        logger.info(`Card action "${value.action}" blocked for non-allowed user: ${operatorOpenId}`);
        // 与上面 non-operator 分支同理：仅 get_write_link 破例给 toast，其余保持静默。
        if (value.action === 'get_write_link' || value.action === 'open_local_terminal') {
          const key = value.action === 'open_local_terminal'
            ? 'card.action.local_terminal_no_permission'
            : 'card.action.write_link_no_permission';
          return { toast: { type: 'warning', content: t(key, undefined, localeForBot(larkAppId)) } };
        }
        return;
      }
    }
  }
  return CARD_ACTION_UNHANDLED;
}
