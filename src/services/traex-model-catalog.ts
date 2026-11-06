import { execFile } from 'node:child_process';

export interface TraexCatalogModel {
  model: string;
  displayName: string;
  loadPercent?: number;
  queueSize?: number;
  efforts: string[];
  /** Server-advertised account quota. Omitted/unknown is deliberately not
   * treated as either available or exhausted. */
  quota: TraexQuotaSnapshot;
  /** Provider catalog priority is retained for diagnostics; Botmux's explicit
   * policy order remains the user-selected capability order. */
  providerPriority?: number;
}

export type TraexQuotaState = 'available' | 'exhausted' | 'unknown';
export interface TraexQuotaSnapshot {
  state: TraexQuotaState;
  remainingPercent?: number;
  resetAt?: string;
}

export interface TraexRouteCandidate {
  model: TraexCatalogModel;
  score: number;
}

const finite = (n: unknown): number | undefined => typeof n === 'number' && Number.isFinite(n) && n >= 0 ? n : undefined;
const record = (value: unknown): Record<string, any> | undefined => value && typeof value === 'object' && !Array.isArray(value)
  ? value as Record<string, any> : undefined;

/**
 * The Trae catalog has shipped quota fields under more than one metadata
 * envelope. Parse only explicit values; a missing field must remain unknown.
 */
export function parseTraexQuota(model: any): TraexQuotaSnapshot {
  const metadata = record(model?.business_metadata);
  const quota = record(metadata?.daily_quota) ?? record(metadata?.quota)
    ?? record(model?.daily_quota) ?? record(model?.quota) ?? record(metadata?.internal_usage);
  if (!quota) return { state: 'unknown' };
  const status = String(quota.status ?? quota.state ?? '').toLowerCase();
  const remaining = finite(quota.remaining_percent ?? quota.remainingPercent ?? quota.left_percent ?? quota.leftPercent);
  const used = finite(quota.used_percent ?? quota.usedPercent);
  const exhausted = quota.exhausted === true || quota.is_exhausted === true
    || /^(exhausted|depleted|used_up)$/u.test(status) || remaining === 0 || used === 100;
  const state: TraexQuotaState = exhausted ? 'exhausted'
    : remaining !== undefined || used !== undefined || /^(available|active|ok)$/u.test(status) ? 'available' : 'unknown';
  const resetAt = typeof (quota.reset_at ?? quota.resetAt) === 'string' ? String(quota.reset_at ?? quota.resetAt) : undefined;
  return { state, ...(remaining === undefined ? {} : { remainingPercent: remaining }), ...(resetAt ? { resetAt } : {}) };
}

/** 仅保留路由元数据，不保存目录中的提示词、凭据或会话内容。 */
export function parseTraexCatalog(value: any): TraexCatalogModel[] {
  if (!Array.isArray(value?.models)) throw new Error('traex_invalid_model_catalog');
  return value.models.filter((m: any) => m.visibility === 'list' && m.model_provider_id === 'trae')
    .map((m: any) => {
      const load = m.business_metadata?.load;
      return { model: String(m.config_name ?? m.slug).toLowerCase(), displayName: String(m.slug),
        loadPercent: finite(load?.load_percent), queueSize: finite(load?.queue_size),
        efforts: (m.supported_reasoning_levels ?? []).map((r: any) => r.effort), quota: parseTraexQuota(m),
        providerPriority: finite(m.priority) };
    });
}

/** --remote 强制刷新；超时或缺失数据不冒充零负载。 */
export function fetchTraexCatalog(bin = process.env.TRAEX_APP_SERVER_BIN || 'traex', cwd = process.cwd()): Promise<TraexCatalogModel[]> {
  return new Promise((resolve, reject) => {
    execFile(bin, ['debug', 'models', '--remote'], { cwd, timeout: 10000, maxBuffer: 8 * 1024 * 1024 }, (error, stdout) => {
      if (error) { reject(new Error('traex_catalog_unavailable')); return; }
      try { resolve(parseTraexCatalog(JSON.parse(stdout))); }
      catch { reject(new Error('traex_invalid_model_catalog')); }
    });
  });
}

/** A reported catalog queue and an exhausted daily quota while busy are hard
 * exclusions. Load is a soft pressure signal, never a stand-alone gate. */
export function isTraexCatalogCandidate(model: TraexCatalogModel, effort = 'xhigh'): boolean {
  if (!model.efforts.includes(effort)) return false;
  if (model.queueSize !== undefined && model.queueSize > 0) return false;
  return !(model.quota.state === 'exhausted' && (model.loadPercent ?? 0) >= 100);
}

/**
 * Capability order has a material but not absolute effect. A small overload on
 * a stronger model can still win; extreme server pressure remains expensive.
 * Explicit remaining quota gets a modest preference, and unknown quota remains
 * neutral rather than being fabricated as available.
 */
function loadPressure(loadPercent: number | undefined): number {
  if (loadPercent === undefined) return 135;
  if (loadPercent <= 80) return 0;
  if (loadPercent <= 100) return (loadPercent - 80) * 2;
  if (loadPercent <= 150) return 40 + (loadPercent - 100) * 5;
  return 290 + (loadPercent - 150) * 8;
}

export function rankTraexCandidates(models: TraexCatalogModel[], policyOrder: string[], effort = 'xhigh'): TraexRouteCandidate[] {
  const byModel = new Map(models.map(model => [model.model, model]));
  return policyOrder.map((name, preference) => {
    const model = byModel.get(name);
    if (!model || !isTraexCatalogCandidate(model, effort)) return undefined;
    const quotaBias = model.quota.state === 'available' ? -20 : model.quota.state === 'exhausted' ? 600 : 0;
    return { model, score: preference * 35 + loadPressure(model.loadPercent) + quotaBias };
  }).filter((candidate): candidate is TraexRouteCandidate => !!candidate)
    .sort((a, b) => a.score - b.score || policyOrder.indexOf(a.model.model) - policyOrder.indexOf(b.model.model));
}

/** Compatibility helper for diagnostics and callers that only need IDs. */
export function eligibleTraexModels(models: TraexCatalogModel[], effort = 'xhigh'): string[] {
  return models.filter(model => isTraexCatalogCandidate(model, effort)).map(model => model.model);
}
