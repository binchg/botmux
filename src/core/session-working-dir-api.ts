import { ipcRoute, jsonRes, readJsonBody } from './dashboard-ipc-server.js';
import { findActiveBySessionId } from './worker-pool.js';
import * as sessions from '../services/session-store.js';
import { requestSessionWorkingDir, sessionWorkingDirStatus } from './session-working-dir.js';
import type { Session } from '../types.js';
import type { DaemonSession } from './types.js';

/** 会话自助目录接口；采用现有 loopback IPC 信任模型，不允许跨机器人或接管外部进程。 */
export function assertSessionWorkingDirScope(
  session: Session | undefined,
  appId: string,
  live?: DaemonSession,
): asserts session is Session {
  if (!session || session.larkAppId !== appId) throw new Error('session_not_found');
  if (session.status !== 'active') throw new Error('session_not_active');
  if (session.adoptedFrom || live?.adoptedFrom || live?.initConfig?.adoptMode) throw new Error('adopt_working_dir_switch_unsupported');
  if (session.sandbox) throw new Error('sandbox_working_dir_switch_unsupported');
}

let registered = false;
let workingDirApiAppId = '';

/** 每个 daemon 注册一次路由；测试或初始化重入只刷新机器人身份。 */
export function registerSessionWorkingDirApi(appId: string): void {
  workingDirApiAppId = appId;
  if (registered) return;
  registered = true;
  const scope = (id: string) => {
    const live = findActiveBySessionId(id);
    const session = live?.session ?? sessions.getSession(id);
    assertSessionWorkingDirScope(session, workingDirApiAppId, live);
    return { session, live };
  };
  ipcRoute('GET', '/api/sessions/:sessionId/working-dir', (_req, res, params) => {
    try {
      const { session, live } = scope(params.sessionId);
      jsonRes(res, 200, { ok: true, ...sessionWorkingDirStatus(session, live) });
    } catch (error) {
      jsonRes(res, 409, { ok: false, error: error instanceof Error ? error.message : String(error) });
    }
  });
  ipcRoute('POST', '/api/sessions/:sessionId/working-dir', async (req, res, params) => {
    try {
      const body = await readJsonBody(req);
      // 请求体读取期间可能关闭/迁移会话，所有写入前重新验证目标身份。
      const { session, live } = scope(params.sessionId);
      requestSessionWorkingDir(session, live, body);
      jsonRes(res, 200, { ok: true, ...sessionWorkingDirStatus(session, live) });
    } catch (error) {
      jsonRes(res, 409, { ok: false, error: error instanceof Error ? error.message : String(error) });
    }
  });
}
