// 构建飞书 /status 回复，并在授权范围内附带 Codex 订阅实时额度。
import { getBot } from '../bot-registry.js';
import type { BotState } from '../bot-registry.js';
import { config } from '../config.js';
import { t, type Locale } from '../i18n/index.js';
import { getCliDisplayName } from '../im/lark/card-builder.js';
import { formatCodexQuota, readCodexQuota } from '../services/codex-quota.js';
import { expandHome, getSessionWorkingDir } from './session-manager.js';
import { buildTerminalUrl } from './terminal-url.js';
import type { DaemonSession } from './types.js';
import { getCurrentCliVersion } from './worker-pool.js';

/** 使用会话冻结的 Codex 启动入口；仅向本机器人配置的操作人展示订阅额度。 */
async function codexQuotaStatus(
  bot: BotState,
  session: DaemonSession | undefined,
  senderId: string | undefined,
  cwd: string,
  locale: Locale,
): Promise<string | undefined> {
  if (!senderId || !bot.resolvedAllowedUsers?.includes(senderId)) return;
  const agent = session?.initConfig ?? (session?.session.agentFrozen ? session.session : bot.config);
  const cliId = session?.initConfig?.cliId ?? session?.session.cliId ?? bot.config.cliId;
  if (cliId !== 'codex-app' && cliId !== 'codex') return;

  const unavailable = locale === 'en' ? 'Codex remaining quota unavailable' : 'Codex 剩余额度暂不可用';
  // 外部接管的终端或包装器可能携带不同的认证环境，无法确认时不借用默认账号。
  if (agent.wrapperCli || session?.initConfig?.adoptMode || session?.adoptedFrom || session?.session.adoptedFrom) {
    return unavailable;
  }
  try {
    const windows = await readCodexQuota({
      codexBin: agent.cliPathOverride,
      cwd: session?.initConfig?.workingDir ?? cwd,
      env: { ...process.env, ...(session?.initConfig ? session.initConfig.env : bot.config.env) },
    });
    return formatCodexQuota(windows, locale) ?? unavailable;
  } catch {
    // 额度查询失败也保留会话状态，不回传可能包含账号信息的 RPC 错误。
    return unavailable;
  }
}

/** 将会话经过的毫秒数转换为最多两级的可读时长。 */
function formatUptime(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m${seconds % 60}s`;
  return `${Math.floor(minutes / 60)}h${minutes % 60}m`;
}

/** 读取会话或机器人状态；没有会话的话题也可查询配置账号的额度。 */
export async function buildSessionStatus(options: {
  appId?: string;
  session?: DaemonSession;
  senderId?: string;
  activeCount: number;
  locale: Locale;
}): Promise<string> {
  const { appId, session, senderId, activeCount, locale } = options;
  const bot = appId ? getBot(appId) : undefined;
  const cliName = bot ? getCliDisplayName(bot.config.cliId) : 'CLI';
  const cwd = session ? getSessionWorkingDir(session) : expandHome(bot?.config.workingDir ?? config.daemon.workingDir);
  const quota = bot ? await codexQuotaStatus(bot, session, senderId, cwd, locale) : undefined;
  const version = getCurrentCliVersion();
  if (!session) {
    const fallback = t('cmd.status.fallback_no_session', { count: activeCount, cliName, version }, locale);
    return quota ? `${fallback}\n${quota}` : fallback;
  }

  const alive = session.worker && !session.worker.killed;
  const now = Date.now();
  const terminal = session.workerPort ? buildTerminalUrl(session) : '-';
  return [
    `Session: ${session.session.sessionId}`,
    `Status: ${t(alive ? 'cmd.status.running' : 'cmd.status.waiting', undefined, locale)}`,
    `Terminal: ${terminal}`,
    `CWD: ${cwd}`,
    `${cliName}: v${session.cliVersion}${session.cliVersion !== version ? ` (latest: v${version})` : ''}`,
    ...(alive ? [`Uptime: ${formatUptime(now - session.spawnedAt)}`] : []),
    `Last message: ${formatUptime(now - session.lastMessageAt)} ago`,
    `Active sessions: ${activeCount}`,
    ...(quota ? [quota] : []),
  ].join('\n');
}
