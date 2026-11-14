import { CARD_ACTION_UNHANDLED, type SessionCardContext } from './card-action-context.js';
import { config } from '../../config.js';
import { listCodexAppModels } from '../../services/codex-app-threads.js';
import { readSessionModel, readSessionModelRuntime, sessionModelStatus, writeSessionModel } from '../../services/session-model-store.js';
import { validateModelSelection } from '../../services/session-model-selection.js';
import { buildSessionModelCard } from './session-model-card.js';
import { localeForBot } from '../../i18n/index.js';

export async function handleSessionModelAction(context: SessionCardContext): Promise<any> {
  const { actionType, ds, value, action, sessionReply, rootId } = context;
  if (!['session_model_open', 'session_model_set'].includes(actionType)) return CARD_ACTION_UNHANDLED;
  const error = (content: string) => ({ toast: { type: 'error', content } });
  if (!ds || ds.session.status !== 'active' || ds.session.cliId !== 'codex-app' || ds.adoptedFrom || ds.initConfig?.adoptMode) return error('当前会话不支持此配置或已关闭');
  const id = ds.session.sessionId, dir = config.session.dataDir;
  try {
    const previous = readSessionModel(dir, id) ?? readSessionModelRuntime(dir, id)?.selection;
    const models = await listCodexAppModels({ codexBin: previous?.executor === 'traex' ? 'traex' : ds.initConfig?.cliPathOverride, cwd: ds.session.workingDir });
    if (ds.session.status !== 'active') return error('会话已关闭');
    if (actionType === 'session_model_set') {
      if (!['model', 'effort', 'serviceTier'].includes(value.field) || typeof action?.option !== 'string') return error('无效的会话配置');
      const option = action.option;
      const latest = readSessionModel(dir, id) ?? readSessionModelRuntime(dir, id)?.selection;
      const patch: Record<string, string> = { [value.field]: option };
      if (value.field === 'model') {
        const target = models.find(m => (m.configName ?? m.model) === option);
        if (!target) return error('该模型当前不可用');
        patch.effort = target.supportedReasoningEfforts.some(e => e.reasoningEffort === latest?.effort) ? latest!.effort : target.defaultReasoningEffort;
        patch.serviceTier = latest?.serviceTier === 'priority' && target.serviceTiers?.some(t => t.id === 'priority') ? 'priority' : 'default';
      }
      writeSessionModel(dir, id, validateModelSelection(patch, models, latest));
      if (sessionModelStatus(dir, id).status === 'pending_runner_reload' && ds.worker && !ds.worker.killed) ds.worker.send({ type: 'reload_app_runner_when_idle' });
      return { toast: { type: 'success', content: '仅本会话已保存，下一轮生效' },
        card: { type: 'raw', data: JSON.parse(buildSessionModelCard(id, rootId, models, localeForBot(ds.larkAppId))) } };
    }
    await sessionReply(rootId, buildSessionModelCard(id, rootId, models, localeForBot(ds.larkAppId)), 'interactive');
    return { toast: { type: 'success', content: '已打开本会话配置' } };
  } catch { return error('读取或保存会话模型失败，请稍后重试'); }
}
