/** 负载用于请求前预选，实际排队事件用于熔断；不把静默或慢推理当成排队。 */
import { createRequire } from 'node:module';
import { mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { atomicWriteFileSync } from '../utils/atomic-write.js';
import { withFileLock } from '../utils/file-lock.js';
import { traeHome } from './traex-paths.js';
import { traexAppServerPids } from './traex-process-scope.js';

// 用户参考榜单顺序；目录中尚不存在的型号只保留优先级，不能作为可用模型调用。
export const TRAEX_MODEL_ORDER = ['gpt-6-astra', 'gpt-6.1-sol', 'gpt-6.1-terra', 'gpt-5.6-sol',
  'gpt-5.6-terra', 'gpt-6-sol', 'gpt-5.6-luna', 'gpt-6-luna', 'gpt-5.5', 'gpt-5.4', 'gpt-5.2'];
export interface TraexAdaptivePolicy { models: string[]; cooldownMs: number; quotaResetHour?: number }
export function readTraexAdaptivePolicy(env = process.env, enabledByDefault = false): TraexAdaptivePolicy | undefined {
  if (env.TRAEX_ADAPTIVE_ENABLED === '0') return undefined;
  const configured = env.TRAEX_ADAPTIVE_MODELS ?? (enabledByDefault ? TRAEX_MODEL_ORDER.join(',') : '');
  const models = [...new Set(configured.split(',').map(x => x.trim().toLowerCase()).filter(Boolean))];
  if (!models.length) return undefined;
  if (models.length > 16 || models.some(x => !/^[\w.-]+$/.test(x))) throw new Error('invalid_traex_adaptive_models');
  const cooldownMs = Number(env.TRAEX_ADAPTIVE_COOLDOWN_MS ?? 120000);
  if (!Number.isFinite(cooldownMs) || cooldownMs < 1000 || cooldownMs > 3600000) throw new Error('invalid_traex_adaptive_cooldown');
  const quotaResetHour = Number(env.TRAEX_ADAPTIVE_QUOTA_RESET_HOUR ?? 6);
  if (!Number.isInteger(quotaResetHour) || quotaResetHour < 0 || quotaResetHour > 23) throw new Error('invalid_traex_adaptive_quota_reset_hour');
  return { models, cooldownMs, quotaResetHour };
}

interface Health { blockedUntil: Record<string, number>; quotaBlockedUntil: Record<string, number> }
export function nextDailyQuotaResetMs(now: number, hour = 6): number {
  const reset = new Date(now);
  reset.setHours(hour, 0, 0, 0);
  if (reset.getTime() <= now) reset.setDate(reset.getDate() + 1);
  return reset.getTime();
}

/** Only explicit quota-exhaustion wording takes this path. Generic 429 errors
 * retain their existing retry policy because they do not prove daily exhaustion. */
export function isTraexDailyQuotaExhausted(message: string): boolean {
  const normalized = message.toLowerCase();
  return /daily\s+quota\s+(?:is\s+)?exhausted|(?:daily\s+)?quota\s+(?:has\s+)?been\s+exhausted|quota[_ -]?exhausted/u.test(normalized);
}
export class TraexAdaptiveRouter {
  constructor(readonly policy: TraexAdaptivePolicy, private readonly path: string) {}
  private read(): Health {
    try {
      const state = JSON.parse(readFileSync(this.path, 'utf8'));
      return { blockedUntil: state.blockedUntil ?? {}, quotaBlockedUntil: state.quotaBlockedUntil ?? {} };
    } catch (e: any) {
      if (e.code !== 'ENOENT') throw e;
      return { blockedUntil: {}, quotaBlockedUntil: {} };
    }
  }
  /** The first request after cooldown is the admission probe. Never interrupt
   * healthy generation just to try a more expensive model. */
  choose(available: string[], attempted = new Set<string>(), now = Date.now()): string | undefined {
    const health = this.read();
    const configured = new Set(this.policy.models);
    const eligible = available.filter(x => configured.has(x) && !attempted.has(x));
    return eligible.find(x => !(health.blockedUntil[x] > now) && !(health.quotaBlockedUntil[x] > now));
  }
  async queued(model: string, now = Date.now()): Promise<void> {
    mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
    await withFileLock(this.path, async () => {
      const state = this.read();
      state.blockedUntil[model] = Math.max(state.blockedUntil[model] ?? 0, now + this.policy.cooldownMs);
      atomicWriteFileSync(this.path, JSON.stringify(state), { mode: 0o600 });
    });
  }
  async quotaExhausted(model: string, now = Date.now()): Promise<void> {
    mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
    await withFileLock(this.path, async () => {
      const state = this.read();
      state.quotaBlockedUntil[model] = Math.max(state.quotaBlockedUntil[model] ?? 0,
        nextDailyQuotaResetMs(now, this.policy.quotaResetHour));
      atomicWriteFileSync(this.path, JSON.stringify(state), { mode: 0o600 });
    });
  }
  lower(model: string, available: string[], attempted: Set<string>): string | undefined {
    const i = this.policy.models.indexOf(model);
    return i < 0 ? undefined : this.choose(this.policy.models.slice(i + 1).filter(x => available.includes(x)), attempted);
  }
}

export interface TraexQueueEvidence { id: number; atMs: number; position?: number; quotaLowPriority?: boolean }
export function parseTraexQueueEvidence(row: any): TraexQueueEvidence | undefined {
  const body = String(row.feedback_log_body ?? '');
  if (!/\brequest_wait_in_queue\b|\bYour queue position is\b/.test(body)) return undefined;
  const match = /(?:queue position is|(?:queue_position|"position")["\s:=]+)\s*(\d+)/i.exec(body);
  const position = match ? Number(match[1]) : undefined;
  if (position === 0) return undefined;
  const quotaLowPriority = /\bmodel_quota_low_priority["\\\s:=]+true\b/i.test(body);
  return { id: Number(row.id), atMs: Number(row.ts) * 1000 + Number(row.ts_nanos ?? 0) / 1e6, position,
    ...(quotaLowPriority ? { quotaLowPriority: true } : {}) };
}

/** 每轮仅观测启动器及其真实 app-server；其它线程、进程和旧轮次不能触发降级。 */
export class TraexQueueReader {
  private db: any;
  private cursor = 0;
  constructor(private readonly threadId: string, private readonly pid: number,
    path = join(traeHome(), 'cli', 'logs_2.sqlite')) {
    const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite');
    this.db = new DatabaseSync(path, { readOnly: true });
    this.cursor = Number(this.db.prepare('SELECT COALESCE(MAX(id), 0) AS id FROM logs').get().id);
  }
  poll(afterMs: number): TraexQueueEvidence | undefined {
    const pids = traexAppServerPids(this.pid);
    const nextCursor = Number(this.db.prepare('SELECT COALESCE(MAX(id), 0) AS id FROM logs').get().id);
    // 直接读取最新队列状态，避免工具执行期间积压的旧排队事件覆盖后来的 queue_end。
    const row = this.db.prepare('SELECT id, ts, ts_nanos, feedback_log_body FROM logs WHERE id > ? '
      + 'AND id <= ? AND (thread_id = ? OR thread_id IS NULL) AND (' + pids.map(() => 'process_uuid LIKE ?').join(' OR ') + ') '
      + "AND (feedback_log_body LIKE '%request_wait_in_queue%' OR feedback_log_body LIKE '%Your queue position is%' "
      + "OR feedback_log_body LIKE '%queue_end%') ORDER BY id DESC LIMIT 1")
      .get(this.cursor, nextCursor, this.threadId, ...pids.map(pid => `pid:${pid}:%`));
    // 无排队事件也推进快照游标，避免空闲会话反复扫描历史日志。
    this.cursor = nextCursor;
    if (!row) return undefined;
    if (/\bqueue_end\b/.test(String(row.feedback_log_body))) return undefined;
    const evidence = parseTraexQueueEvidence(row);
    return evidence && evidence.atMs >= afterMs ? evidence : undefined;
  }
  close(): void { this.db?.close(); this.db = undefined; }
}
