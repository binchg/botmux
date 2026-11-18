/** 显式启用的混合模型目录，沿用 TraeX 能力顺序，保留逐通道的真实准入证据。 */
import { readFileSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { TRAEX_MODEL_ORDER } from './traex-adaptive-model.js';
import { rankTraexCandidates, type TraexCatalogModel } from './traex-model-catalog.js';
import type { AvailableSessionModel } from './session-model-selection.js';
import type { ModelExecutor } from './model-executor.js';

export interface MixedRoute {
  executor: ModelExecutor;
  model: string;
  policyModel: string;
  effort: string;
  displayName?: string;
  automatic?: boolean;
}
export interface MixedPolicy { routes: MixedRoute[]; maxAttempts: number; cooldownMs: number }
export const mixedRouteId = (route: Pick<MixedRoute, 'executor' | 'model'>) => `${route.executor}:${route.model}`;

/** 缺少开关时完全不介入；非法配置拒绝运行，不静默回退到全局配置。 */
export function readMixedPolicy(env = process.env): MixedPolicy | undefined {
  const file = env.MIXED_MODEL_ROUTES_FILE;
  if (!file) return undefined;
  if (!isAbsolute(file)) throw new Error('mixed_policy_absolute_path_required');
  const value = JSON.parse(readFileSync(file, 'utf8'));
  const routes = value.routes as MixedRoute[];
  if (value.version !== 1 || !Array.isArray(routes) || !routes.length || routes.length > 64
    || routes.some(route => !['traex', 'codex-app', 'ark'].includes(route.executor)
      || !/^[\w.-]{1,120}$/.test(route.model) || !/^[\w.-]{1,120}$/.test(route.policyModel)
      || (route.automatic !== undefined && typeof route.automatic !== 'boolean')
      || !['xhigh', 'high', 'medium', 'low', 'none'].includes(route.effort))
    || new Set(routes.map(mixedRouteId)).size !== routes.length) throw new Error('invalid_mixed_policy');
  const maxAttempts = value.maxAttempts ?? 3, cooldownMs = value.cooldownMs ?? 120000;
  if (!Number.isInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 6
    || !Number.isFinite(cooldownMs) || cooldownMs < 1000 || cooldownMs > 3600000) throw new Error('invalid_mixed_limits');
  return { routes, maxAttempts, cooldownMs };
}

/** 不根据测速自评分改变能力顺序；未知负载仅标为待探测，不能称为空闲或排队。 */
export function rankMixedRoutes(policy: MixedPolicy, catalog: TraexCatalogModel[],
  health: Record<string, { blockedUntil?: number; firstTokenMs?: number }>, now = Date.now()): MixedRoute[] {
  const order = [...new Set([...TRAEX_MODEL_ORDER, ...policy.routes.map(route => route.policyModel)])];
  const traex = rankTraexCandidates(catalog, order, 'xhigh', true);
  return policy.routes.map((route, index) => {
    const state = health[mixedRouteId(route)];
    if (route.automatic === false || (state?.blockedUntil ?? 0) > now) return undefined;
    const candidate = traex.find(row => row.model.model === route.model);
    if (route.executor === 'traex' && !candidate) return undefined;
    // 原生和方舟的未知负载只增加探测成本；TraeX 的真实目录沿用原评分。
    const score = route.executor === 'traex' ? candidate!.score
      : order.indexOf(route.policyModel) * 35 + 30;
    // 首 token 只作同能力候选的小幅排序，不能覆盖能力、繁忙和冷却边界。
    return { route, score: score + Math.min((state?.firstTokenMs ?? 0) / 1000, 10), index };
  }).filter((row): row is NonNullable<typeof row> => !!row)
    .sort((a, b) => a.score - b.score || a.index - b.index).map(row => row.route);
}

/** 飞书卡片与 CLI 使用带通道的唯一标识，避免同名模型选到错误提供方。 */
export function mixedModels(policy: MixedPolicy): AvailableSessionModel[] {
  return policy.routes.map(route => ({ model: route.model, id: mixedRouteId(route), executor: route.executor,
    displayName: route.displayName, defaultReasoningEffort: route.effort,
    supportedReasoningEfforts: [{ reasoningEffort: route.effort }], serviceTiers: [{ id: 'default' }] }));
}
