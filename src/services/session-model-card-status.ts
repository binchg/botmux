/** 会话卡中的实际模型快照；首次延后补齐，后续切换限频，负载波动不单独刷新。 */
import { getSession } from './session-store.js';
import { readSessionCardCustomization } from './session-card-customization.js';
import { sessionModelDisplay } from './session-model-display.js';
import { sessionModelStatus } from './session-model-store.js';

type State = ReturnType<typeof sessionModelStatus>;
interface Snapshot { identity: string; label?: string; nextAt: number }
const snapshots = new Map<string, Snapshot>();
const keyFor = (dir: string, id: string, card: string) => `${dir}:${id}:${card}`;

/** 仅使用运行回执；正常请求到运行、完成的过渡不产生展示刷新。 */
function value(state: State): Pick<Snapshot, 'identity' | 'label'> {
  const display = sessionModelDisplay(state.runtime ?? undefined, state.runnerAlive);
  if (!display) return { identity: '' };
  const phase = ['requested', 'running', 'completed'].includes(display.state) ? '' : display.state;
  return { identity: [display.model, display.effort, phase].join(':'), label: display.label };
}

/** 独立模型设置面板实时显示；同一即时卡保留快照，避免跟随负载频繁更新。 */
export function sessionModelCardStatus(dir: string, id: string, state: State, card?: string, now = Date.now()): string | undefined {
  if (!readSessionCardCustomization(dir, getSession(id)?.larkAppId).modelInCard) return undefined;
  const current = value(state);
  if (!card) return current.label;
  const key = keyFor(dir, id, card), previous = snapshots.get(key);
  if (!previous || (current.identity !== previous.identity && now >= previous.nextAt)) {
    if (snapshots.size >= 512) snapshots.delete(snapshots.keys().next().value!);
    snapshots.set(key, { ...current, nextAt: now + (current.label ? 30_000 : 15_000) });
  }
  return snapshots.get(key)?.label ?? (current.label ? '待回执' : undefined);
}

/** 后台只在身份变化且到达刷新窗口时补卡；恢复后的存量卡允许补齐一次。 */
export function sessionModelCardNeedsRefresh(dir: string, id: string, card: string, now = Date.now()): boolean {
  if (!readSessionCardCustomization(dir, getSession(id)?.larkAppId).modelInCard) return false;
  const previous = snapshots.get(keyFor(dir, id, card));
  return !previous || (now >= previous.nextAt && value(sessionModelStatus(dir, id)).identity !== previous.identity);
}
