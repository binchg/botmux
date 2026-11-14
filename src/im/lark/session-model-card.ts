import { config } from '../../config.js';
import { sessionModelStatus, type ModelSelection } from '../../services/session-model-store.js';
import type { AvailableSessionModel } from '../../services/session-model-selection.js';
import type { Locale } from '../../i18n/index.js';

const text = (content: string) => ({ tag: 'div', text: { tag: 'lark_md', content } });
const safe = (value?: string) => value?.replace(/[^\w.:-]/g, '') || '未知';
const label = (s: ModelSelection, en: boolean) => `${safe(s.model)} · ${safe(s.effort)} · Fast ${s.serviceTier === 'priority' ? 'ON' : s.serviceTier === 'default' ? 'OFF' : (en ? 'unknown' : '未知')}`;

/** Actual runtime and requested settings remain distinct until the runner acknowledges them. */
export function sessionModelCardElements(sessionId: string, cliId?: string, locale?: Locale): any[] {
  if (cliId !== 'codex-app') return [];
  const en = locale === 'en';
  try {
    const state = sessionModelStatus(config.session.dataDir, sessionId);
    const current = state.runtime?.selection;
    const rows = [text(current
      ? `**${en ? 'Current' : '当前'}** · ${label(current, en)}${state.runnerAlive ? '' : (en ? ' (last receipt; runner offline)' : '（最近回执，运行器离线）')}`
      : `${en ? 'Current model / reasoning / Fast: awaiting runtime receipt' : '当前模型 / 推理 / Fast：等待运行回执'}`)];
    if (state.desired && state.desired.revision !== state.runtime?.revision) {
      rows.push(text(`${en ? 'Pending next turn' : '待下一轮生效'} · ${label(state.desired, en)}`));
    }
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
  const selected = models.find(m => (m.configName ?? m.model) === selection?.model || m.model === selection?.model);
  const base = { session_id: sessionId, root_id: rootId, cli_id: 'codex-app', action: 'session_model_set' };
  const select = (field: string, choices: string[], current?: string) => ({ tag: 'select_static',
    placeholder: { tag: 'plain_text', content: field === 'model' ? '模型' : field === 'effort' ? '推理强度' : 'Fast' },
    ...(current && choices.includes(current) ? { initial_option: current } : {}),
    options: choices.map(value => ({ text: { tag: 'plain_text', content: field === 'serviceTier' ? (value === 'priority' ? 'Fast ON' : 'Fast OFF') : value }, value })),
    value: { ...base, field } });
  const elements = [text(`仅修改本会话（${sessionId.slice(0, 8)}）。选择后自动保存，下一轮生效。`),
    ...sessionModelCardElements(sessionId, 'codex-app', locale),
    { tag: 'action', actions: [select('model', [...new Set(models.map(m => m.configName ?? m.model))], selection?.model)] }];
  if (selected) elements.push({ tag: 'action', actions: [
    select('effort', selected.supportedReasoningEfforts.map(e => e.reasoningEffort), selection?.effort),
    select('serviceTier', ['default', ...(selected.serviceTiers?.some(t => t.id === 'priority') ? ['priority'] : [])], selection?.serviceTier),
  ] });
  return JSON.stringify({ config: { wide_screen_mode: true }, header: { template: 'blue',
    title: { tag: 'plain_text', content: '⚙️ 本会话模型配置' } }, elements });
}
