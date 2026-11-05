import { modelRuntimeAlive, readSessionModelRuntime, type SessionModelRuntime } from './session-model-store.js';
import { isAgentTeamMachineOutput } from './agent-team-output-filter.js';

export interface SessionModelDisplay {
  executor: 'traex';
  model: string | null;
  effort: string | null;
  state: string;
  label: string;
  loadPercent?: number;
}

const states: Record<string, string> = {
  ready: '候选，待请求', selecting: '刷新选模', waiting: '等待空闲模型',
  requested: '请求已接受', running: '运行中', queued: '排队，重选中',
  completed: '已完成', failed: '已停止', stopped: '运行器已停止',
};

export function modelDisplayName(model: string): string {
  return model.replace(/^gpt-/i, 'GPT-').replace(/-(sol|astra|terra|luna)$/i,
    (_, variant: string) => '-' + variant[0].toUpperCase() + variant.slice(1).toLowerCase());
}

/** 只读实际回执，不退回期望配置；选模期间不把上一轮模型显示成本轮模型。 */
export function sessionModelDisplay(runtime: SessionModelRuntime | undefined, alive = modelRuntimeAlive(runtime)): SessionModelDisplay | null {
  if (!runtime || (runtime.selection?.executor !== 'traex' && runtime.routing?.executor !== 'traex')) return null;
  let state = runtime.phase === 'failed' ? 'failed' : runtime.routing?.state ?? runtime.phase;
  if (!alive) state = 'stopped';
  const pending = ['selecting', 'waiting'].includes(state);
  const safe = (value?: string): string | null => value && /^[\w.-]{1,120}$/.test(value) ? value : null;
  const model = pending ? null : safe(runtime.selection?.model);
  const effort = safe(runtime.selection?.effort ?? runtime.routing?.effort);
  const loadPercent = runtime.routing?.loadPercent;
  const position = runtime.routing?.position;
  const details = [!['requested', 'running', 'completed'].includes(state) ? states[state] ?? '状态未知' : '',
    state === 'queued' && typeof position === 'number' ? `第 ${position} 位` : '',
    typeof loadPercent === 'number' && Number.isFinite(loadPercent) ? `负载 ${loadPercent}%` : ''].filter(Boolean);
  return { executor: 'traex', model, effort, state, loadPercent,
    label: ['TraeX', model ? modelDisplayName(model) : '尚未选定模型', effort, details.join(' · ')].filter(Boolean).join(' · ') };
}

export function readSessionModelDisplay(dir: string, id: string): SessionModelDisplay | null {
  try { return sessionModelDisplay(readSessionModelRuntime(dir, id)); } catch { return null; }
}

/** 模型信息属于展示，不进入线程上下文或机器 JSON；已标注的消息不得重复追加。 */
export function withSessionModelDisplay(content: string, display: SessionModelDisplay | null): string {
  if (!display || !content.trim() || /^> \*\*(?:模型：)?TraeX · /u.test(content) || isAgentTeamMachineOutput(content)) return content;
  return `> **${display.label}**\n\n${content}`;
}
