import { config } from '../../config.js';
import { sessionModelStatus, type ModelSelection } from '../../services/session-model-store.js';
import type { AvailableSessionModel } from '../../services/session-model-selection.js';
import type { Locale } from '../../i18n/index.js';
import { getSession } from '../../services/session-store.js';
import { sessionModelCardStatus } from '../../services/session-model-card-status.js';
import { sessionCardStatistics } from '../../services/session-card-statistics.js';
import { sessionCardTaskLocation } from '../../services/session-card-task-context.js';
import { sessionCardCodexQuota } from '../../services/session-card-codex-quota.js';

const text = (content: string) => ({ tag: 'div', text: { tag: 'lark_md', content } });
const safe = (value?: string) => value?.replace(/[^\w.:-]/g, '') || '未知';

/** 实际回执与待生效配置分别展示；即时卡中的模型信息按窗口限频。 */
export function sessionModelCardElements(sessionId: string, cliId?: string, locale?: Locale, snapshotKey?: string): any[] {
  if (cliId !== 'codex-app') return [];
  const en = locale === 'en';
  try {
    const state = sessionModelStatus(config.session.dataDir, sessionId);
    const current = state.runtime?.selection;
    const session = getSession(sessionId);
    const workingDir = sessionCardTaskLocation(config.session.dataDir, sessionId, state, snapshotKey)
      ?? session?.workingDir ?? (en ? 'Unknown directory' : '目录未知');
    const compact = (v: ModelSelection) => `${safe(v.model).replace(/^gpt-/, '')} ${safe(v.effort).replace('medium', 'M').replace('xhigh', 'XH').replace('high', 'H').replace('low', 'L')} F${v.serviceTier === 'priority' ? '√' : v.serviceTier === 'default' ? '×' : '?'}`;
    const status = sessionModelCardStatus(config.session.dataDir, sessionId, state, snapshotKey)
      ?? (current ? `${state.runnerAlive ? '' : (en ? 'last ' : '上次 ')}${compact(current)}` : (en ? 'awaiting receipt' : '待回执'));
    const pending = state.desired && state.desired.revision !== state.runtime?.revision
      ? ` → ${compact(state.desired)}${en ? ' next' : ' 待生效'}` : '';
    const rows = [{ tag: 'div', text: { tag: 'plain_text', content: `📁 ${workingDir} · ${status}${pending}` } }];
    const quota = snapshotKey ? sessionCardCodexQuota(config.session.dataDir, sessionId, locale ?? 'zh', snapshotKey) : undefined;
    if (quota) rows.push({ tag: 'div', text: { tag: 'plain_text', content: quota } });
    const lines = sessionCardStatistics(config.session.dataDir, sessionId, state, locale, snapshotKey);
    for (const content of lines) rows.push({ tag: 'div', text: { tag: 'plain_text', content } });
    return rows;
  } catch { return [text(en ? 'Model status unavailable' : '模型状态暂不可用')]; }
}

export function sessionModelButton(sessionId: string, actionBase: Record<string, string>, cliId?: string): any[] {
  if (cliId !== 'codex-app') return [];
  return [{ tag: 'button', type: 'default', text: { tag: 'plain_text', content: '⚙️ 本会话模型 / 推理 / Fast' },
    value: { ...actionBase, session_id: sessionId, action: 'session_model_open' } }];
}

export function buildSessionModelCard(sessionId: string, rootId: string, models: AvailableSessionModel[], locale?: Locale): string {
  const state = sessionModelStatus(config.session.dataDir, sessionId);
  const selection = state.desired ?? state.runtime?.selection;
  const selected = models.find(m => (!m.executor || m.executor === selection?.executor)
    && ((m.configName ?? m.model) === selection?.model || m.model === selection?.model));
  const modelKey = (model: AvailableSessionModel) => model.executor && model.id ? model.id : model.configName ?? model.model;
  const base = { session_id: sessionId, root_id: rootId, cli_id: 'codex-app', action: 'session_model_set' };
  const select = (field: string, choices: string[], current?: string) => ({ tag: 'select_static',
    placeholder: { tag: 'plain_text', content: field === 'model' ? '模型' : field === 'effort' ? '推理强度' : 'Fast' },
    ...(current && choices.includes(current) ? { initial_option: current } : {}),
    options: choices.map(value => ({ text: { tag: 'plain_text', content: field === 'serviceTier' ? (value === 'priority' ? 'Fast ON' : 'Fast OFF') : value }, value })),
    value: { ...base, field } });
  const elements = [text(`仅修改本会话（${sessionId.slice(0, 8)}）。选择后自动保存，下一轮生效。`),
    ...sessionModelCardElements(sessionId, 'codex-app', locale),
    { tag: 'action', actions: [select('model', [...new Set(models.map(modelKey))], selected ? modelKey(selected) : selection?.model)] }];
  if (selected) elements.push({ tag: 'action', actions: [
    select('effort', selected.supportedReasoningEfforts.map(e => e.reasoningEffort), selection?.effort),
    select('serviceTier', ['default', ...(selected.serviceTiers?.some(t => t.id === 'priority') ? ['priority'] : [])], selection?.serviceTier),
  ] });
  return JSON.stringify({ config: { wide_screen_mode: true }, header: { template: 'blue',
    title: { tag: 'plain_text', content: '⚙️ 本会话模型配置' } }, elements });
}
