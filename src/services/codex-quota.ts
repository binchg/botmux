// 通过 Codex app-server 读取订阅额度，只向调用方返回额度窗口和剩余百分比。
import { resolveCommand } from '../adapters/cli/registry.js';
import { AppServerClient } from './app-runner-client.js';

interface RateLimitWindow {
  usedPercent?: number;
  windowDurationMins?: number | null;
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
    windows.push({
      window: name,
      durationMinutes: typeof duration === 'number' && Number.isSafeInteger(duration) && duration > 0 ? duration : undefined,
      remainingPercent: Math.max(0, 100 - used),
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
