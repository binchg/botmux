import { accessSync, constants, realpathSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import * as sessions from '../services/session-store.js';
import { dashboardEventBus } from './dashboard-events.js';
import { expandHome, validateWorkingDir } from './working-dir.js';
import type { DaemonToWorker, Session } from '../types.js';
import type { DaemonSession } from './types.js';

/** 会话目录切换状态机：请求只登记期望值，安全输入边界才替换旧运行器。 */
export interface WorkingDirRuntime {
  stop: (live: DaemonSession) => Promise<void>;
  start: (live: DaemonSession, message: Extract<DaemonToWorker, { type: 'message' }>) => void;
  send?: (live: DaemonSession, message: Extract<DaemonToWorker, { type: 'message' }>) => void | Promise<void>;
}
const inputFlights = new WeakMap<DaemonSession, Promise<void>>();

/** 校验目标目录；相对路径相对本会话解析，绝不创建误拼的新目录。 */
export function resolveSessionWorkingDir(input: unknown, base?: string): string {
  if (typeof input !== 'string' || !input.trim() || input.includes('\0')) {
    throw new Error('working_dir_required');
  }
  const expanded = expandHome(input.trim());
  if (!isAbsolute(expanded) && !base) throw new Error('absolute_working_dir_required');
  const validation = validateWorkingDir(resolve(base ?? '.', expanded));
  if (!validation.ok) throw new Error(validation.error);
  accessSync(validation.resolvedPath, constants.R_OK | constants.X_OK);
  return validation.resolvedPath;
}

/** 别名和符号链接指向同一目录时不重启已有运行器。 */
function sameDirectory(a: string | undefined, b: string): boolean {
  if (!a) return false;
  try { return realpathSync(a) === realpathSync(b); }
  catch { return a === b; }
}

/** 明确区分已配置目录、实际运行目录以及尚未应用的请求。 */
export function sessionWorkingDirStatus(session: Session, live?: DaemonSession) {
  const running = !!live?.worker && !live.worker.killed;
  return {
    sessionId: session.sessionId,
    workingDir: session.workingDir ?? live?.workingDir ?? null,
    actualWorkingDir: running ? live?.initConfig?.workingDir ?? live?.workingDir ?? session.workingDir ?? null : null,
    pendingWorkingDir: session.pendingWorkingDir ?? null,
    error: session.pendingWorkingDirError ?? null,
    status: live?.workingDirSwitchInFlight ? 'switching' : session.pendingWorkingDirError ? 'blocked'
      : session.pendingWorkingDir ? 'pending_next_turn' : running ? 'active' : 'configured',
    appliesTo: session.pendingWorkingDir ? 'next_safe_turn' : running ? 'current_runtime' : 'next_start',
    globalConfigChanged: false,
  };
}

/** 将变更同时保存到会话存储与看板；不写机器人默认值或其它会话。 */
function publish(session: Session, live?: DaemonSession): void {
  sessions.updateSession(session);
  const state = sessionWorkingDirStatus(session, live);
  // 目录状态独立于会话运行状态，不能把 working/idle 覆盖成 pending_next_turn。
  dashboardEventBus.publish({
    type: 'session.update',
    body: { sessionId: session.sessionId, patch: {
      workingDir: live?.workingDir ?? session.workingDir,
      pendingWorkingDir: state.pendingWorkingDir,
      workingDirStatus: state.status,
      workingDirError: state.error,
    } },
  });
}

/** 人工重新指定仓库或接管外部 CLI 时清掉旧请求，避免下轮覆盖最新选择。 */
export function clearPendingSessionWorkingDir(session: Session): void {
  session.pendingWorkingDir = undefined;
  session.pendingWorkingDirError = undefined;
}

/** 登记或取消目录请求；已有运行器绝不在此处被终止。 */
export function requestSessionWorkingDir(session: Session, live: DaemonSession | undefined, body: unknown): void {
  if (live?.workingDirSwitchInFlight) throw new Error('working_dir_switch_in_progress');
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error('working_dir_request_required');
  const request = body as Record<string, unknown>;
  const keys = Object.keys(request);
  if (request.cancel === true && keys.length === 1) {
    session.pendingWorkingDir = undefined;
    session.pendingWorkingDirError = undefined;
    publish(session, live);
    return;
  }
  if (keys.length !== 1 || keys[0] !== 'workingDir') throw new Error('invalid_working_dir_request');
  const target = resolveSessionWorkingDir(request.workingDir, live?.workingDir ?? session.workingDir);
  session.pendingWorkingDir = sameDirectory(live?.workingDir ?? session.workingDir, target) ? undefined : target;
  session.pendingWorkingDirError = undefined;
  publish(session, live);
}

/** 仅在安全输入流程确认旧 CLI 退出后提交目录；恢复重连不得调用此入口。 */
export function applyStoppedSessionWorkingDir(live: DaemonSession): boolean {
  if (!live.session.pendingWorkingDir) return false;
  if (!live.workingDirSwitchInFlight || (live.worker && !live.worker.killed)) {
    throw new Error('working_dir_switch_not_safely_stopped');
  }
  try {
    const target = resolveSessionWorkingDir(live.session.pendingWorkingDir);
    live.workingDir = target;
    live.session.workingDir = target;
    live.session.pendingWorkingDir = undefined;
    live.session.pendingWorkingDirError = undefined;
    live.initConfig = undefined;
    publish(live.session, live);
    return true;
  } catch (error) {
    live.session.pendingWorkingDirError = error instanceof Error ? error.message : String(error);
    publish(live.session, live);
    throw error;
  }
}

/** 同一会话的切换和新输入串行化，避免旧 worker 退出时误杀新 worker 或丢掉追问。 */
export async function sendInputWithSessionWorkingDir(
  live: DaemonSession,
  message: Extract<DaemonToWorker, { type: 'message' }>,
  runtime: WorkingDirRuntime,
): Promise<void> {
  const previous = inputFlights.get(live);
  const send = async () => {
    // 已失败的显式切换必须由重新设置或取消解除，不能从冷分支悄悄跑回旧目录。
    if (live.session.pendingWorkingDirError) throw new Error(live.session.pendingWorkingDirError);
    const pending = live.session.pendingWorkingDir;
    const running = !!live.worker && !live.worker.killed;
    // 没有 daemon worker 不代表后台 CLI 空闲；只接受运行器报告的真实 idle 边界。
    const safe = running && live.lastScreenStatus === 'idle' && !live.outboundReplies?.size;
    if (pending && safe) {
      // 路径必须在停旧进程前验证；停止期间目标仍可能消失，启动前再校验一次。
      live.workingDirSwitchInFlight = true;
      try {
        resolveSessionWorkingDir(pending);
        await runtime.stop(live);
        applyStoppedSessionWorkingDir(live);
        // start 同步交接 init.prompt；期间不再允许普通冷分支抢先 fork。
        live.workingDirSwitchInFlight = undefined;
        live.lastScreenStatus = 'working';
        runtime.start(live, message);
        if (!live.worker || live.worker.killed) throw new Error('session_worker_unavailable');
        publish(live.session, live);
        return;
      } catch (error) {
        live.session.pendingWorkingDirError = error instanceof Error ? error.message : String(error);
        publish(live.session, live);
        throw error;
      } finally {
        live.workingDirSwitchInFlight = undefined;
      }
    }
    // 每次接受输入都同步标忙；目录请求即使随后抵达也不能误杀本轮。
    live.lastScreenStatus = 'working';
    if (!live.worker || live.worker.killed) {
      // 冷恢复只重连原目录，尚未证实后台空闲时不得兑现待切换目录。
      runtime.start(live, message);
      if (!live.worker || live.worker.killed) throw new Error('session_worker_unavailable');
      return;
    }
    if (runtime.send) await runtime.send(live, message);
    else live.worker.send(message);
  };
  if (!previous && !live.session.pendingWorkingDir) return send();
  const flight = (previous ?? Promise.resolve()).catch(() => undefined).then(send);
  inputFlights.set(live, flight);
  try { await flight; }
  finally { if (inputFlights.get(live) === flight) inputFlights.delete(live); }
}
