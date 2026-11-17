/** 会话卡的稳定方向标签与实时占用摘要；登记变化可低频补齐，任务标签保持不变。 */
import { getSession } from './session-store.js';
import { sessionModelStatus } from './session-model-store.js';
import { readSessionCardCustomization } from './session-card-customization.js';
import { readSessionCardBindings, shortSessionProject } from './session-card-bindings.js';
import { stableSessionTaskTag } from './session-card-task-tag.js';

type State = ReturnType<typeof sessionModelStatus>;
const snapshots = new Map<string, { text: string; nextAt: number }>();

/** 读取已绑定的工作区和设备，不把控制仓路径当作业务 worktree。 */
function context(dir: string, id: string, state: State): { tag: string; location: string } | undefined {
  const session = getSession(id);
  if (!session || !readSessionCardCustomization(dir, session.larkAppId).taskContext) return;
  const bound = readSessionCardBindings({ sessionId: id, nativeIds: [session.cliSessionId, state.runtime?.threadId].filter((v): v is string => !!v), workingDir: session.workingDir });
  const tag = stableSessionTaskTag(dir, id, session.title, bound.project);
  const devices = [...bound.devices.slice(0, 2), ...(bound.devices.length > 2 ? [`+${bound.devices.length - 2}台`] : [])];
  return { tag, location: [...(bound.worktrees.length ? bound.worktrees : [shortSessionProject(session.workingDir || '')]), ...devices].join(' · ') };
}

/** 标题仅用首轮冻结的标签，不依赖当前追问、模型或轮次。 */
export function sessionCardTaskTag(dir: string, id: string): string | undefined {
  return context(dir, id, sessionModelStatus(dir, id))?.tag;
}

/** 首次立即显示已知占用；同一卡后续变动至少间隔三十秒。 */
export function sessionCardTaskLocation(dir: string, id: string, state: State, card?: string, now = Date.now()): string | undefined {
  const value = context(dir, id, state);
  if (!value) return;
  if (!card) return value.location;
  const key = `${dir}:${id}:${card}`, previous = snapshots.get(key);
  if (!previous || (previous.text !== value.location && now >= previous.nextAt)) {
    if (snapshots.size >= 512) snapshots.delete(snapshots.keys().next().value!);
    snapshots.set(key, { text: value.location, nextAt: now + 30_000 });
  }
  return snapshots.get(key)?.text;
}

/** 仅占用摘要真正变化且达到窗口时请求 PATCH，释放后不继续展示旧设备。 */
export function sessionCardTaskContextNeedsRefresh(dir: string, id: string, card: string, now = Date.now()): boolean {
  const previous = snapshots.get(`${dir}:${id}:${card}`);
  if (previous && now < previous.nextAt) return false;
  const current = context(dir, id, sessionModelStatus(dir, id));
  return !!current && (!previous || previous.text !== current.location);
}
