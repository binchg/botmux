// 即时卡共享机器人订阅额度快照，异步查询并复用原有卡片刷新队列。
import { getBot } from '../bot-registry.js';
import { config } from '../config.js';
import type { Locale } from '../i18n/types.js';
import { expandHomePath } from '../utils/working-dir.js';
import { formatCodexQuota, readCodexQuota, type CodexQuotaWindow } from './codex-quota.js';
import { readSessionCardCustomization } from './session-card-customization.js';
import { getSession } from './session-store.js';

const REFRESH_MS = 60_000;
const MAX_CARDS = 512;

/** 每个机器人的当前启动配置及最新额度查询结果。 */
interface QuotaSnapshot {
  codexBin?: string;
  cwd: string;
  env?: Record<string, string>;
  nextReadAt: number;
  windows: CodexQuotaWindow[];
}

const botSnapshots = new Map<string, QuotaSnapshot>();
const cardLabels = new Map<string, string>();

/** 只有启用该能力的 Codex App 机器人和所属操作者会话才能显示机器人订阅额度。 */
function quotaLabel(dir: string, id: string, locale: Locale, now: number): string | undefined {
  const session = getSession(id);
  const appId = session?.larkAppId;
  if (!appId || session.status !== 'active' || session.adoptedFrom) return;
  const prefs = readSessionCardCustomization(dir, appId);
  if (!prefs.codexQuota) return;
  const owner = session.ownerOpenId;
  const explicitOwner = prefs.codexQuotaSessionOwners?.[session.sessionId];
  const bot = getBot(appId);
  const canDisplay = prefs.codexQuotaAllSessions === true
    || (!!owner && (bot.resolvedAllowedUsers.includes(owner) || explicitOwner === owner));
  if (bot.config.cliId !== 'codex-app' || (session.cliId ?? bot.config.cliId) !== 'codex-app'
    || bot.config.wrapperCli || session.wrapperCli || !canDisplay
    || (session.agentFrozen && session.cliPathOverride !== bot.config.cliPathOverride)) return;

  const codexBin = bot.config.cliPathOverride;
  const cwd = expandHomePath(bot.config.workingDir ?? config.daemon.workingDir);
  const env = bot.config.env;
  let snapshot = botSnapshots.get(appId);
  if (!snapshot || snapshot.codexBin !== codexBin || snapshot.cwd !== cwd || snapshot.env !== env) {
    snapshot = { codexBin, cwd, env, nextReadAt: 0, windows: [] };
    botSnapshots.set(appId, snapshot);
  }
  if (now >= snapshot.nextReadAt) {
    const target = snapshot;
    target.nextReadAt = now + REFRESH_MS;
    // 首张卡和终端状态更新只走同步快照，不等待 app-server 启动或网络回包。
    setImmediate(() => {
      void readCodexQuota({ codexBin, cwd, env: { ...process.env, ...env } }).then(
        windows => { target.windows = windows; },
        () => { target.windows = []; },
      );
    });
  }
  return formatCodexQuota(snapshot.windows, locale);
}

/** 记下本次渲染的额度行，以便后台只在内容变化后补刷。 */
export function sessionCardCodexQuota(dir: string, id: string, locale: Locale, card: string, now = Date.now()): string | undefined {
  const label = quotaLabel(dir, id, locale, now);
  const key = `${dir}:${id}:${card}`;
  if (label === undefined) cardLabels.delete(key);
  else {
    if (!cardLabels.has(key) && cardLabels.size >= MAX_CARDS) cardLabels.delete(cardLabels.keys().next().value!);
    cardLabels.set(key, label);
  }
  return label;
}

/** 冷启动时触发后台查询；仅额度行出现、变化或消失时需要 PATCH。 */
export function sessionCardCodexQuotaNeedsRefresh(dir: string, id: string, locale: Locale, card: string, now = Date.now()): boolean {
  return quotaLabel(dir, id, locale, now) !== cardLabels.get(`${dir}:${id}:${card}`);
}
