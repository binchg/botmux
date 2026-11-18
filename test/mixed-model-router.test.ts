/** 混合路由的隔离、排序与安全降级契约；只使用隔离目录和模拟准入事件。 */
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, expect, it, vi } from 'vitest';
import { modelExecutorEnv } from '../src/services/model-executor.js';
import { mixedModels, rankMixedRoutes, readMixedPolicy, reserveMixedFallbacks, type MixedPolicy } from '../src/services/mixed-model-policy.js';
import { MixedModelRouter, MixedProviderUnavailable } from '../src/services/mixed-model-router.js';
import { readSessionModel, writeSessionModel, writeSessionExecutor, writeSessionModelRuntime, rememberSuccessfulRoute } from '../src/services/session-model-store.js';
import { validateModelSelection } from '../src/services/session-model-selection.js';
import type { TraexCatalogModel } from '../src/services/traex-model-catalog.js';
import { parseSessionModelIntent } from '../src/services/session-model-intent.js';
import { sanitizePerBotEnv } from '../src/core/per-bot-env.js';

const roots: string[] = [];
/** 为每项契约创建独立状态目录，结束时仅清理测试自行创建的数据。 */
function root(): string { const dir = mkdtempSync(join(tmpdir(), 'mixed-model-')); roots.push(dir); return dir; }
afterEach(() => roots.splice(0).forEach(dir => rmSync(dir, { recursive: true, force: true })));
const policy: MixedPolicy = { maxAttempts: 3, cooldownMs: 120000, routes: [
  { executor: 'traex', model: 'gpt-6-astra', policyModel: 'gpt-6-astra', effort: 'xhigh' },
  { executor: 'ark', model: 'ep-real', policyModel: 'gpt-6-astra', effort: 'xhigh', displayName: 'GPT-6-Astra' },
  { executor: 'codex-app', model: 'gpt-6.1-sol', policyModel: 'gpt-6.1-sol', effort: 'xhigh' },
] };
const catalog: TraexCatalogModel[] = [{ model: 'gpt-6-astra', displayName: 'Astra', efforts: ['xhigh'],
  loadPercent: 50, quota: { state: 'unknown' } }];

it('没有显式开关时不启用，方舟不能复用全局 Codex 目录', () => {
  expect(readMixedPolicy({})).toBeUndefined();
  const env = { HOME: root() };
  mkdirSync(join(env.HOME, '.codex')); writeFileSync(join(env.HOME, '.codex/config.toml'), '');
  expect(modelExecutorEnv('codex-app', env)).toBe(env);
  expect(modelExecutorEnv('traex', env)).toBe(env);
  expect(() => modelExecutorEnv('ark', env)).toThrow('ark_isolated_config_required');
  expect(() => modelExecutorEnv('ark', { ...env, ARK_CODEX_HOME: join(env.HOME, '.codex') })).toThrow('ark_global_config_forbidden');
  const isolated = join(env.HOME, 'ark'); mkdirSync(isolated); writeFileSync(join(isolated, 'config.toml'), '');
  expect(modelExecutorEnv('ark', { ...env, ARK_CODEX_HOME: isolated }).CODEX_HOME).toBe(isolated);
  expect(env).not.toHaveProperty('CODEX_HOME');
});

it('机器人配置可注入模型隔离参数，仍拒绝覆盖内部会话身份', () => {
  expect(sanitizePerBotEnv({ MIXED_MODEL_ROUTES_FILE: '/private/routes.json', ARK_CODEX_HOME: '/private/ark',
    BOTMUX_SESSION_ID: 'foreign' })).toEqual({ MIXED_MODEL_ROUTES_FILE: '/private/routes.json', ARK_CODEX_HOME: '/private/ark' });
});

it('保留能力优先级，真实空闲 TraeX 优先，繁忙时选其它通道', () => {
  expect(rankMixedRoutes(policy, catalog, {}).map(row => row.executor)).toEqual(['traex', 'ark', 'codex-app']);
  expect(rankMixedRoutes(policy, [{ ...catalog[0], loadPercent: 180, queueSize: 90 }], {})[0].executor).toBe('ark');
  expect(rankMixedRoutes(policy, [], {})[0].executor).toBe('ark');
  expect(rankMixedRoutes(policy, catalog, { 'traex:gpt-6-astra': { blockedUntil: 101 } }, 100)[0].executor).toBe('ark');
  expect(rankMixedRoutes(policy, catalog, { 'traex:gpt-6-astra': { blockedUntil: 101 } }, 102)[0].executor).toBe('traex');
});

it('带通道的模型标识不会误选同名模型，显式执行器不能被目录覆盖', () => {
  const models = mixedModels(policy);
  expect(validateModelSelection({ model: 'ark:ep-real', effort: 'xhigh' }, models)).toMatchObject({ executor: 'ark', model: 'ep-real' });
  expect(() => validateModelSelection({ executor: 'traex', model: 'ark:ep-real' }, models)).toThrow('unsupported_model');
});

it('明确指定方舟或 TraeX 时保留提供方，模型讨论不改变通道', () => {
  expect(parseSessionModelIntent('本会话使用方舟 gpt-6-astra xhigh')).toMatchObject({ executor: 'ark', model: 'gpt-6-astra', routingMode: 'fixed' });
  expect(parseSessionModelIntent('使用 traex gpt-6.1-sol xhigh')).toMatchObject({ executor: 'traex' });
  expect(parseSessionModelIntent('方舟和 codex 哪个更快？')).toBeUndefined();
});

it('尚未实测的目录候选可以手选，不能自动改变现有排序', () => {
  const configured = { ...policy, routes: policy.routes.map(route => ({ ...route, automatic: route.executor !== 'traex' })) };
  expect(rankMixedRoutes(configured, catalog, {}).map(route => route.executor)).toEqual(['ark', 'codex-app']);
  expect(mixedModels(configured)).toHaveLength(3);
});

it('新话题先探测 TraeX，原生 Codex 后降到方舟并保留最后一档机会', () => {
  const configured: MixedPolicy = { ...policy, executorOrder: ['traex', 'codex-app', 'gateway', 'ark'] };
  const ranked = rankMixedRoutes(configured, [{ ...catalog[0], loadPercent: 300, queueSize: 12 }], {});
  expect(ranked.map(route => route.executor)).toEqual(['traex', 'codex-app', 'ark']);
  expect(reserveMixedFallbacks(ranked, 2).map(route => route.executor)).toEqual(['traex', 'ark']);
  expect(reserveMixedFallbacks([ranked[0], { ...ranked[0], model: 'second' }, ...ranked.slice(1)], 3))
    .toEqual(ranked);
});

it('已有线程追问优先复用成功的通道，恢复后的 TraeX 不触发迁移', async () => {
  const { options } = fixture();
  const router = new MixedModelRouter({ ...policy, keepSessionRoute: true,
    executorOrder: ['traex', 'codex-app', 'gateway', 'ark'] }, join(options.dataDir, 'sticky.json'));
  const { dataDir, sessionId } = options;
  const selection = { executor: 'codex-app' as const, model: 'gpt-6.1-sol', effort: 'xhigh', routingMode: 'adaptive' as const };
  writeSessionExecutor(dataDir, { sessionId, executor: 'codex-app', threadId: 'same' });
  writeSessionModelRuntime(dataDir, { sessionId, pid: process.pid, phase: 'completed', threadId: 'same', selection });
  rememberSuccessfulRoute(dataDir, sessionId);
  writeSessionModelRuntime(dataDir, { sessionId, pid: process.pid, phase: 'ready', threadId: 'same', selection });
  options.catalog = vi.fn(options.catalog);
  await router.run(options);
  expect(options.catalog).not.toHaveBeenCalled();
  expect(options.run).toHaveBeenCalledTimes(1);
  expect(readSessionModel(dataDir, sessionId)).toMatchObject(selection);
});

it('受管型号不允许进入直连目录，且历史固定会话不回退到其它提供方', async () => {
  const { router, options } = fixture();
  const managed = { ...policy, gatewayOnlyModels: ['gpt-6.1-sol'] };
  const path = join(options.dataDir, 'routes.json');
  writeFileSync(path, JSON.stringify({ version: 1, ...managed }));
  expect(() => readMixedPolicy({ MIXED_MODEL_ROUTES_FILE: path })).toThrow('managed_gateway_required');
  writeSessionModel(options.dataDir, options.sessionId, { executor: 'traex', model: 'gpt-6.1-sol', effort: 'xhigh', routingMode: 'fixed' });
  const locked = new MixedModelRouter({ ...managed, routes: policy.routes.slice(0, 2) }, join(options.dataDir, 'locked.json'));
  await expect(locked.run(options)).rejects.toThrow('仅通过受管网关');
  expect(options.run).not.toHaveBeenCalled();
  expect(router.read()).toEqual({});
});

it('拒绝重复候选和无限重试配置', () => {
  const path = join(root(), 'policy.json');
  writeFileSync(path, JSON.stringify({ version: 1, ...policy, maxAttempts: 100 }));
  expect(() => readMixedPolicy({ MIXED_MODEL_ROUTES_FILE: path })).toThrow('invalid_mixed_limits');
  writeFileSync(path, JSON.stringify({ version: 1, ...policy, routes: [...policy.routes, policy.routes[0]] }));
  expect(() => readMixedPolicy({ MIXED_MODEL_ROUTES_FILE: path })).toThrow('invalid_mixed_policy');
});

/** 构造唯一请求身份及取消信号，不连接外部模型或真实机器人。 */
function fixture() {
  const dataDir = root(), router = new MixedModelRouter(policy, join(dataDir, 'health.json'));
  return { router, options: { dataDir, sessionId: 'session', signal: new AbortController().signal,
    catalog: async () => catalog, run: vi.fn(async () => {}), safe: () => true, notice: vi.fn(),
    metrics: () => ({ firstTokenMs: 1234 }) } };
}

it('只在准入失败时降级一次，保存通道冷却与真实测速', async () => {
  const { router, options } = fixture(); options.run.mockRejectedValueOnce(new MixedProviderUnavailable('429'));
  await router.run(options);
  expect(options.run).toHaveBeenCalledTimes(2);
  expect(readSessionModel(options.dataDir, options.sessionId)).toMatchObject({ executor: 'ark', routingMode: 'adaptive' });
  expect(router.read()['traex:gpt-6-astra'].blockedUntil).toBeGreaterThan(Date.now());
  expect(router.read()['ark:ep-real']).toMatchObject({ reason: 'completed', firstTokenMs: 1234 });
});

it.each(['tool', 'ordinary', 'fixed', 'cancel', 'revision'])('%s 边界不自动切换或重放', async kind => {
  const { router, options } = fixture(), controller = new AbortController(); options.signal = controller.signal;
  options.safe = () => kind !== 'tool';
  if (kind === 'fixed') writeSessionModel(options.dataDir, options.sessionId,
    { executor: 'ark', model: 'ep-real', effort: 'xhigh', routingMode: 'fixed' });
  options.run.mockImplementation(async () => {
    if (kind === 'cancel') controller.abort();
    if (kind === 'revision') writeSessionModel(options.dataDir, options.sessionId,
      { executor: 'codex-app', model: 'user-chosen', effort: 'low', routingMode: 'fixed' });
    throw kind === 'ordinary' ? new Error('tool failed') : new MixedProviderUnavailable('429');
  });
  await expect(router.run(options)).rejects.toThrow();
  expect(options.run).toHaveBeenCalledTimes(1);
  expect(router.read()).toEqual({});
});

it('每轮达到上限就终止，下次请求在冷却期避开失败通道', async () => {
  const { router, options } = fixture(); options.run.mockRejectedValue(new MixedProviderUnavailable('429'));
  await expect(router.run(options)).rejects.toThrow('429');
  expect(options.run).toHaveBeenCalledTimes(3);
  options.run.mockClear();
  await expect(router.run(options)).rejects.toThrow('冷却');
  expect(options.run).not.toHaveBeenCalled();
});
