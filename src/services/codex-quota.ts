// 通过 Codex app-server 读取订阅额度，只向调用方返回额度窗口和剩余百分比。
import { resolveCommand } from '../adapters/cli/registry.js';
import type { Locale } from '../i18n/types.js';
import { AppServerClient } from './app-runner-client.js';

interface RateLimitWindow {
  usedPercent?: number;
  windowDurationMins?: number | null;
  resetsAt?: number | null;
}

interface RateLimitSnapshot {
  limitId?: string | null;
  primary?: RateLimitWindow | null;
  secondary?: RateLimitWindow | null;
}

interface RateLimitsResponse {
  rateLimits?: RateLimitSnapshot;
  rateLimitsByLimitId?: { codex?: RateLimitSnapshot } | null;
}

/** Codex 订阅的单个额度窗口。 */
export interface CodexQuotaWindow {
  window: 'primary' | 'secondary';
  durationMinutes?: number;
  remainingPercent: number;
  resetsAtMs?: number;
}

/** 按实际时长命名窗口；当协议未提供时长时显示主、次窗口。 */
function windowLabel(quota: CodexQuotaWindow, locale: Locale): string {
  const minutes = quota.durationMinutes;
  if (!minutes) {
    if (locale === 'en') return quota.window === 'primary' ? 'Primary' : 'Secondary';
    return quota.window === 'primary' ? '主窗口' : '次窗口';
  }
  if (minutes % 1440 === 0) return locale === 'en' ? `${minutes / 1440}d` : `${minutes / 1440} 天`;
  if (minutes % 60 === 0) return locale === 'en' ? `${minutes / 60}h` : `${minutes / 60} 小时`;
  return locale === 'en' ? `${minutes}m` : `${minutes} 分钟`;
}

/** 生成状态命令的额度窗口摘要。 */
export function formatCodexQuota(windows: CodexQuotaWindow[], locale: Locale): string | undefined {
  if (!windows.length) return undefined;
  const label = locale === 'en' ? 'Codex remaining quota' : 'Codex 剩余额度';
  const percent = new Intl.NumberFormat(locale, { maximumFractionDigits: 2 });
  return `${label} · ${windows.map(quota => `${windowLabel(quota, locale)} ${percent.format(quota.remainingPercent)}%`).join(' / ')}`;
}

/** 卡片按服务端重置时间计算剩余整小时，已过期的额度等待读取新窗口。 */
export function formatCodexCardQuota(windows: CodexQuotaWindow[], locale: Locale, now: number): string | undefined {
  const current = windows.filter(quota => quota.resetsAtMs === undefined || quota.resetsAtMs > now);
  if (!current.length) return undefined;
  const en = locale === 'en';
  const percent = new Intl.NumberFormat(locale, { maximumFractionDigits: 2 });
  const labels = current.map(quota => {
    const remaining = `${percent.format(quota.remainingPercent)}%`;
    if (quota.resetsAtMs === undefined) {
      const name = current.length > 1 ? `${windowLabel(quota, locale)} ` : '';
      return en ? `${name}${remaining} remaining` : `${name}${remaining}`;
    }
    const hours = Math.floor((quota.resetsAtMs - now) / 3_600_000);
    const days = Math.floor(hours / 24);
    const countdown = en
      ? (days ? `${days}d ${hours % 24}h` : hours ? `${hours}h` : '<1h')
      : (days ? `${days}天${hours % 24}时` : hours ? `${hours}时` : '<1时');
    return en ? `${countdown} to reset · ${remaining} remaining` : `${remaining}·${countdown}刷新`;
  });
  return `${en ? 'Quota' : '额度'} ${labels.join(' / ')}`;
}

/** 同时兼容新旧协议，只接受 Codex 订阅的额度桶。 */
export function parseCodexQuota(response: RateLimitsResponse | undefined): CodexQuotaWindow[] {
  const legacy = response?.rateLimits;
  const snapshot = response?.rateLimitsByLimitId?.codex
    ?? (legacy?.limitId == null || legacy.limitId === 'codex' ? legacy : undefined);
  const windows: CodexQuotaWindow[] = [];
  for (const name of ['primary', 'secondary'] as const) {
    const window = snapshot?.[name];
    const used = window?.usedPercent;
    if (typeof used !== 'number' || !Number.isFinite(used) || used < 0) continue;
    const duration = window?.windowDurationMins;
    const reset = window?.resetsAt;
    windows.push({
      window: name,
      durationMinutes: typeof duration === 'number' && Number.isSafeInteger(duration) && duration > 0 ? duration : undefined,
      remainingPercent: Math.max(0, 100 - used),
      ...(typeof reset === 'number' && reset > 0 && Number.isSafeInteger(reset * 1000) ? { resetsAtMs: reset * 1000 } : {}),
    });
  }
  return windows;
}

/** 在同一个超时预算内完成握手和查询，结束时关闭临时 app-server。 */
export async function readCodexQuota(options: {
  codexBin?: string;
  cwd: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
}): Promise<CodexQuotaWindow[]> {
  const client = new AppServerClient(resolveCommand(options.codexBin ?? 'codex'), options.cwd, options.env);
  let timer: NodeJS.Timeout | undefined;
  try {
    const read = async () => {
      await client.initialize();
      const response = await client.request('account/rateLimits/read', undefined);
      return parseCodexQuota(response);
    };
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('Codex quota read timed out')), options.timeoutMs ?? 7000);
    });
    return await Promise.race([read(), timeout]);
  } finally {
    clearTimeout(timer);
    client.close();
  }
}
