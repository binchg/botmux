// 即时卡共享机器人订阅额度快照，异步查询并复用原有卡片刷新队列。
import { getBot } from '../bot-registry.js';
import { config } from '../config.js';
import type { Locale } from '../i18n/types.js';
import { expandHomePath } from '../utils/working-dir.js';
import { formatCodexQuota, readCodexQuota, type CodexQuotaWindow } from './codex-quota.js';
import { readOriginalCodexQuota } from './codex-original-daemon.js';
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
  pending?: boolean;
}

const botSnapshots = new Map<string, QuotaSnapshot>();
const nativeSnapshots = new Map<string, QuotaSnapshot>();
const cardLabels = new Map<string, string>();

function refreshQuota(snapshot: QuotaSnapshot, now: number, read: () => Promise<CodexQuotaWindow[]>): void {
  if (now < snapshot.nextReadAt) return;
  snapshot.nextReadAt = now + REFRESH_MS;
  snapshot.pending = true;
  setImmediate(() => {
    void read().then(windows => { snapshot.windows = windows; }, () => { snapshot.windows = []; })
      .finally(() => { snapshot.pending = false; });
  });
}

function quotaStatus(snapshot: QuotaSnapshot, locale: Locale) {
  const label = formatCodexQuota(snapshot.windows, locale);
  if (label) return { label };
  const pending = snapshot.pending === true;
  return { pending, label: locale === 'en'
    ? `Codex remaining quota · ${pending ? 'Reading' : 'Unavailable'}`
    : `Codex 剩余额度 · ${pending ? '读取中' : '暂不可用'}` };
}

function botQuota(appId: string, now: number): QuotaSnapshot {
  const { config: bot } = getBot(appId);
  const codexBin = bot.cliPathOverride;
  const cwd = expandHomePath(bot.workingDir ?? config.daemon.workingDir);
  const env = bot.env;
  let snapshot = botSnapshots.get(appId);
  if (!snapshot || snapshot.codexBin !== codexBin || snapshot.cwd !== cwd || snapshot.env !== env) {
    snapshot = { codexBin, cwd, env, nextReadAt: 0, windows: [] };
    botSnapshots.set(appId, snapshot);
  }
  refreshQuota(snapshot, now, () => readCodexQuota({ codexBin, cwd, env: { ...process.env, ...env } }));
  return snapshot;
}

export function prewarmSessionCardCodexQuota(dir: string, appId: string): void {
  const prefs = readSessionCardCustomization(dir, appId);
  if (!prefs.codexQuota || !prefs.codexQuotaAllSessions) return;
  const { config: bot } = getBot(appId);
  if (bot.cliId === 'codex-app' && !bot.wrapperCli) botQuota(appId, Date.now());
}

/** External sessions query their own Codex library, independently of the bot's account. */
export function nativeSessionCardQuota(dir: string, appId: string, threadId: string, owner: string, codexHome: string,
  codexBin: string, cwd: string, locale: Locale, now = Date.now()): { label: string; pending?: boolean } | undefined {
  const prefs = readSessionCardCustomization(dir, appId);
  if (!prefs.codexQuota) return;
  if (!prefs.codexQuotaAllSessions && prefs.codexQuotaSessionOwners?.[threadId] !== owner
    && !getBot(appId).resolvedAllowedUsers.includes(owner)) return;
  const key = JSON.stringify([codexHome, codexBin]);
  let snapshot = nativeSnapshots.get(key);
  if (!snapshot) {
    snapshot = { codexBin, cwd, nextReadAt: 0, windows: [] };
    if (nativeSnapshots.size >= 32) nativeSnapshots.delete(nativeSnapshots.keys().next().value!);
    nativeSnapshots.set(key, snapshot);
  }
  refreshQuota(snapshot, now, async () => (await readOriginalCodexQuota(codexHome)) ??
    readCodexQuota({ codexBin, cwd, env: { ...process.env, CODEX_HOME: codexHome } }));
  return quotaStatus(snapshot, locale);
}

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

  const snapshot = botQuota(appId, now);
  return prefs.codexQuotaAllSessions ? quotaStatus(snapshot, locale).label : formatCodexQuota(snapshot.windows, locale);
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
