import { invalidateGlobalConfigCache, readGlobalConfig } from '../global-config.js';
import { ipcRoute, readJsonBody, jsonRes } from './dashboard-ipc-server.js';
import { findActiveBySessionId, listActiveSessions } from './worker-pool.js';
import * as sessions from '../services/session-store.js';
import { config } from '../config.js';
import { listCodexAppModels } from '../services/codex-app-threads.js';
import { executorModels } from '../services/model-executor.js';
import { mixedModels, readMixedPolicy } from '../services/mixed-model-policy.js';
import { rankMixedRoutes, mixedRouteId } from '../services/mixed-model-policy.js';
import { MixedModelRouter } from '../services/mixed-model-router.js';
import { fetchTraexCatalog } from '../services/traex-model-catalog.js';
import { normalizeSessionExecutor, validateModelSelection } from '../services/session-model-selection.js';
import { readSessionModel, readSessionModelRuntime, sessionModelStatus, writeSessionModel } from '../services/session-model-store.js';
import type { Session } from '../types.js';

export function assertSessionModelScope(session: Session | undefined, appId: string, adopted = false): asserts session is Session {
  if (!session || session.larkAppId !== appId) throw new Error('session_not_found');
  if (session.status !== 'active') throw new Error('session_not_active');
  if (session.cliId !== 'codex-app') throw new Error('session_model_requires_codex_app');
  if (adopted) throw new Error('adopt_model_switch_unsupported');
}
let registered = false;
let modelApiAppId = '';
export function registerSessionModelApi(appId: string): void {
  modelApiAppId = appId;
  if (registered) return;
  registered = true;
  ipcRoute('POST', '/api/hooks/reload', (_req, res) => {
    invalidateGlobalConfigCache();
    const hookTrust = readGlobalConfig().hookTrust;
    const queued: string[] = [], failed: string[] = [];
    if (!hookTrust) { jsonRes(res, 409, { ok: false, error: 'global_hook_policy_not_set' }); return; }
    for (const live of listActiveSessions()) {
      const s = live.session;
      if (s.larkAppId !== modelApiAppId || s.status !== 'active' || !['codex-app','codex','traex'].includes(s.cliId ?? '') || live.adoptedFrom || live.initConfig?.adoptMode) continue;
      try {
        if (!live.worker || live.worker.killed) throw new Error('worker_unavailable');
        live.worker.send({ type: 'reload_app_runner_when_idle' }); queued.push(s.sessionId);
      } catch { failed.push(s.sessionId); }
    }
    jsonRes(res, 200, { ok: true, hookTrust, queued, failed });
  });
  const scope = (id: string) => {
    const live = findActiveBySessionId(id), session = live?.session ?? sessions.getSession(id);
    assertSessionModelScope(session, modelApiAppId, !!(live?.adoptedFrom || live?.initConfig?.adoptMode));
    return { live, session };
  };
  ipcRoute('GET', '/api/sessions/:sessionId/model', (_req, res, params) => {
    try { scope(params.sessionId); jsonRes(res, 200, { ok: true, ...sessionModelStatus(config.session.dataDir, params.sessionId), globalHookTrust: readGlobalConfig().hookTrust ?? null }); }
    catch (e) { jsonRes(res, 409, { ok: false, error: (e as Error).message }); }
  });
  ipcRoute('GET', '/api/sessions/:sessionId/model/routes', async (_req, res, params) => {
    try {
      const { live } = scope(params.sessionId);
      const env = { ...process.env, ...live?.initConfig?.env };
      const policy = readMixedPolicy(env), path = env.MIXED_MODEL_HEALTH_FILE;
      if (!policy || !path) throw new Error('mixed_routing_not_enabled');
      let catalog: Awaited<ReturnType<typeof fetchTraexCatalog>> = [];
      let catalogAvailable = true;
      try { catalog = await fetchTraexCatalog(); } catch { catalogAvailable = false; }
      const health = new MixedModelRouter(policy, path).read();
      const ranked = rankMixedRoutes(policy, catalog, health);
      jsonRes(res, 200, { ok: true, strategy: 'original_capability_order_actual_admission_bounded_fallback',
        maxAttempts: policy.maxAttempts, cooldownMs: policy.cooldownMs, queueAdmissionVerified: false, catalogAvailable,
        selected: ranked[0] ? mixedRouteId(ranked[0]) : null,
        routes: policy.routes.map(route => ({ ...route, id: mixedRouteId(route),
          rank: ranked.indexOf(route) < 0 ? null : ranked.indexOf(route) + 1, health: health[mixedRouteId(route)] ?? null })) });
    } catch (error) { jsonRes(res, 409, { ok: false, error: (error as Error).message }); }
  });
  ipcRoute('GET', '/api/sessions/:sessionId/model/list', async (req, res, params) => {
    try {
      const { live, session } = scope(params.sessionId);
      const selected = new URL(req.url!, 'http://localhost').searchParams.get('executor')
        ?? readSessionModel(config.session.dataDir, params.sessionId)?.executor ?? 'codex-app';
      const executor = normalizeSessionExecutor(selected);
      const env = { ...process.env, ...live?.initConfig?.env };
      const mixed = readMixedPolicy(env);
      const models = mixed ? mixedModels(mixed) : await executorModels(executor, session.workingDir, live?.initConfig?.cliPathOverride, env);
      jsonRes(res, 200, { ok: true, executor, mixed: !!mixed, models: models.map(m => ({ model: mixed ? m.id : m.configName ?? m.model,
        executor: m.executor ?? executor, displayName: m.displayName,
        efforts: m.supportedReasoningEfforts.map(e => e.reasoningEffort), defaultEffort: m.defaultReasoningEffort,
        serviceTiers: ['default', ...(m.serviceTiers?.map(t => t.id).filter(t => t !== 'default') ?? [])] })) });
    } catch (e) { jsonRes(res, 409, { ok: false, error: (e as Error).message }); }
  });
  ipcRoute('POST', '/api/sessions/:sessionId/model', async (req, res, params) => {
    try {
      const { live, session } = scope(params.sessionId), body = await readJsonBody(req);
      if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error('model_selection_required');
      const previous = readSessionModel(config.session.dataDir, params.sessionId)
        ?? readSessionModelRuntime(config.session.dataDir, params.sessionId)?.selection;
      const executor = normalizeSessionExecutor((body as Record<string, unknown>).executor ?? previous?.executor ?? 'codex-app');
      const env = { ...process.env, ...live?.initConfig?.env };
      const mixed = readMixedPolicy(env);
      const models = mixed ? mixedModels(mixed) : await executorModels(executor, session.workingDir, live?.initConfig?.cliPathOverride, env);
      // 探测期间可能关闭了会话；落盘前再次核对，不能复活已停用会话。
      scope(params.sessionId);
      const selection = validateModelSelection(body, models, previous);
      writeSessionModel(config.session.dataDir, params.sessionId, selection);
      const status = sessionModelStatus(config.session.dataDir, params.sessionId);
      let reloadQueued = false;
      if (status.status === 'pending_runner_reload' && live?.worker && !live.worker.killed) {
        try { live.worker.send({ type: 'reload_app_runner_when_idle' }); reloadQueued = true; }
        catch { /* 期望配置已持久保存；状态明确保持 pending，可安全重试。 */ }
      }
      jsonRes(res, 200, { ok: true, ...status, reloadQueued, appliesTo: 'next_turn', historyTransfer: 'recent_visible_messages_on_executor_change', globalConfigChanged: false });
    } catch (e) { jsonRes(res, 409, { ok: false, error: (e as Error).message }); }
  });
}
