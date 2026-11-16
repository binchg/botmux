/** 即时卡统计快照：首次空值稍后重试，有真实数据后最多每分钟更新一次。 */
import { getSession } from './session-store.js';
import { sessionModelStatus } from './session-model-store.js';
import { resolveSessionTranscriptPath } from './transcript-resolver.js';
import { readCodexSessionStatistics, codexStatisticsText } from './codex-session-statistics.js';
import { readSessionCardCustomization } from './session-card-customization.js';

type State = ReturnType<typeof sessionModelStatus>;
interface Snapshot { lines: string[]; signature: string; nextAt: number }
const snapshots = new Map<string, Snapshot>();
const keyFor = (dir: string, id: string, locale: string | undefined, card: string) => `${dir}:${id}:${locale ?? 'zh'}:${card}`;

/** 使用实际执行器与原生线程查找日志；允许首次未落盘的路径在下一窗口重新解析。 */
function measure(id: string, state: State, locale: string | undefined, now: number): Snapshot {
  const session = getSession(id);
  const resolved = resolveSessionTranscriptPath({ cliId: state.runtime?.selection?.executor === 'traex' ? 'traex' : 'codex',
    sessionId: id, cliSessionId: state.runtime?.threadId ?? session?.cliSessionId, cwd: session?.workingDir, fresh: true });
  const stats = resolved ? readCodexSessionStatistics(resolved.path, now, state.runnerAlive && state.runtime?.phase === 'running') : undefined;
  return { lines: codexStatisticsText(stats, session?.createdAt, now, locale === 'en').split('\n'),
    signature: stats ? JSON.stringify([resolved?.path, stats.runningMs, stats.tools, stats.inputTokens, stats.outputTokens, stats.cachedTokens]) : '',
    nextAt: now + (stats ? 60_000 : 15_000) };
}

/** 同一卡在窗口内复用统计，保留三行布局；空统计不会永久冻结。 */
export function sessionCardStatistics(dir: string, id: string, state: State, locale?: string, card?: string, now = Date.now()): string[] {
  const key = card ? keyFor(dir, id, locale, card) : undefined;
  const previous = key ? snapshots.get(key) : undefined;
  if (previous && now < previous.nextAt) return previous.lines;
  const current = measure(id, state, locale, now);
  if (key) {
    if (snapshots.size >= 512) snapshots.delete(snapshots.keys().next().value!);
    snapshots.set(key, current);
  }
  return current.lines;
}

/** 只在真实测量变化时补卡；静止会话不会仅因创建时长变化而反复请求飞书。 */
export function sessionCardStatisticsNeedsRefresh(dir: string, id: string, locale: string | undefined, card: string, now = Date.now()): boolean {
  if (!readSessionCardCustomization(dir, getSession(id)?.larkAppId).modelInCard) return false;
  const previous = snapshots.get(keyFor(dir, id, locale, card));
  if (!previous) return true;
  if (now < previous.nextAt) return false;
  const next = measure(id, sessionModelStatus(dir, id), locale, now);
  if (next.signature !== previous.signature) return true;
  previous.nextAt = next.nextAt;
  return false;
}
