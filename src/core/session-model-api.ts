import { invalidateGlobalConfigCache, readGlobalConfig } from '../global-config.js';
import { ipcRoute, readJsonBody, jsonRes } from './dashboard-ipc-server.js';
import { findActiveBySessionId, listActiveSessions } from './worker-pool.js';
import * as sessions from '../services/session-store.js';
import { config } from '../config.js';
import { listCodexAppModels } from '../services/codex-app-threads.js';
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
  ipcRoute('GET', '/api/sessions/:sessionId/model/list', async (req, res, params) => {
    try {
      const { live, session } = scope(params.sessionId);
      const selected = new URL(req.url!, 'http://localhost').searchParams.get('executor')
        ?? readSessionModel(config.session.dataDir, params.sessionId)?.executor ?? 'codex-app';
      const executor = normalizeSessionExecutor(selected);
      const models = await listCodexAppModels({ codexBin: executor === 'traex' ? 'traex' : live?.initConfig?.cliPathOverride, cwd: session.workingDir });
      jsonRes(res, 200, { ok: true, executor, models: models.map(m => ({ model: m.configName ?? m.model,
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
      const models = await listCodexAppModels({ codexBin: executor === 'traex' ? 'traex' : live?.initConfig?.cliPathOverride, cwd: session.workingDir });
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
