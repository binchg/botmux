/** 每个请求有界地跨通道降级；保留固定选模、取消、并发设置与已执行工具的边界。 */
import { mkdirSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { atomicWriteFileSync } from '../utils/atomic-write.js';
import { withFileLock } from '../utils/file-lock.js';
import { readSessionModel, writeSessionModel } from './session-model-store.js';
import { TraexAdmissionStopped } from './traex-admission.js';
import { mixedRouteId, rankMixedRoutes, type MixedPolicy, type MixedRoute } from './mixed-model-policy.js';
import type { TraexCatalogModel } from './traex-model-catalog.js';

export interface MixedHealth {
  blockedUntil?: number;
  firstTokenMs?: number;
  elapsedMs?: number;
  reason?: string;
  checkedAt?: string;
  position?: number;
}
/** 只代表明确的准入失败；慢响应、模型答错和普通工具错误不能自动归入排队。 */
export class MixedProviderUnavailable extends Error {
  /** 保留明确队列、准入拒绝与未知超时的区别，避免把等待耗时当作队列耗时。 */
  constructor(message: string, readonly reason = 'admission_rejected', readonly position?: number) { super(message); }
}

/** 状态文件按机器人隔离，写入带锁；测速仅保存数字与结果分类，不保存提示词或凭据。 */
export class MixedModelRouter {
  constructor(readonly policy: MixedPolicy, private readonly path: string) {}
  /** 读取机器人自己的健康摘要；损坏状态不能当作从未失败。 */
  read(): Record<string, MixedHealth> {
    try { return JSON.parse(readFileSync(this.path, 'utf8')); }
    catch (error: any) { if (error.code === 'ENOENT') return {}; throw error; }
  }
  /** 合并单条观测，保留其他会话已经写入的候选状态。 */
  async record(route: MixedRoute, value: MixedHealth): Promise<void> {
    mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
    await withFileLock(this.path, async () => {
      const current = this.read(), key = mixedRouteId(route);
      current[key] = { ...current[key], ...value, checkedAt: new Date().toISOString() };
      atomicWriteFileSync(this.path, JSON.stringify(current), { mode: 0o600 });
    });
  }
  /** 一次请求最多尝试配置上限个通道模型；失败后不回到已经尝试的候选。 */
  async run(options: {
    dataDir: string; sessionId: string; signal: AbortSignal;
    catalog: () => Promise<TraexCatalogModel[]>;
    run: () => Promise<void>; safe: () => boolean; notice: (message: string) => void;
    metrics?: () => { firstTokenMs?: number };
  }): Promise<void> {
    const { dataDir, sessionId, signal } = options;
    const initial = readSessionModel(dataDir, sessionId);
    if (initial?.routingMode === 'fixed') return options.run();
    let catalog: TraexCatalogModel[] = [];
    try { catalog = await options.catalog(); } catch { /* 目录不可用不能阻断其他已配置通道。 */ }
    signal.throwIfAborted();
    let expectedRevision = initial?.revision;
    const attempted = new Set<string>();
    let lastError: unknown = new MixedProviderUnavailable('混合模型均处于冷却，已停止本轮请求。');
    const candidates = rankMixedRoutes(this.policy, catalog, this.read());
    for (const route of candidates) {
      if (attempted.size >= this.policy.maxAttempts) break;
      signal.throwIfAborted();
      if (attempted.size && !options.safe()) throw new Error('本轮已经出现工具或正文输出，不再切换通道。');
      if (readSessionModel(dataDir, sessionId)?.revision !== expectedRevision) throw new Error('mixed_selection_changed');
      const request = writeSessionModel(dataDir, sessionId, { executor: route.executor, model: route.model,
        effort: route.effort, serviceTier: 'default', routingMode: 'adaptive', hookTrust: initial?.hookTrust });
      expectedRevision = request.revision;
      attempted.add(mixedRouteId(route));
      options.notice(`本轮选择 ${route.executor} · ${route.displayName ?? route.model} · ${route.effort}；准入状态以实际响应为准。`);
      const started = Date.now();
      try {
        await options.run();
        await this.record(route, { blockedUntil: 0, elapsedMs: Date.now() - started, reason: 'completed', ...options.metrics?.() });
        return;
      } catch (error) {
        signal.throwIfAborted();
        if (!(error instanceof TraexAdmissionStopped) && !(error instanceof MixedProviderUnavailable)) throw error;
        if (!options.safe() || readSessionModel(dataDir, sessionId)?.revision !== expectedRevision) throw error;
        lastError = error;
        await this.record(route, { blockedUntil: Date.now() + this.policy.cooldownMs,
          elapsedMs: Date.now() - started, reason: error instanceof TraexAdmissionStopped ? 'provider_queue_or_quota' : error.reason,
          ...(error instanceof MixedProviderUnavailable ? { position: error.position } : {}) });
        options.notice(`${route.executor} · ${route.displayName ?? route.model} 未获准入，按原能力顺序降级；本轮不重复尝试该候选。`);
      }
    }
    throw lastError;
  }
}
