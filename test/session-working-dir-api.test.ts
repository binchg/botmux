import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { config } from '../src/config.js';
import * as sessions from '../src/services/session-store.js';
import * as workers from '../src/core/worker-pool.js';
import { registerSessionWorkingDirApi } from '../src/core/session-working-dir-api.js';
import { startIpcServer, type IpcServerHandle } from '../src/core/dashboard-ipc-server.js';

/** 真实 loopback API 验证：路径、机器人边界与持久存储一致，但不启动 AI 进程。 */
let dir: string, target: string, previous: string, server: IpcServerHandle;
beforeEach(async () => {
  previous = config.session.dataDir; dir = mkdtempSync(join(tmpdir(), 'botmux-cwd-api-'));
  target = join(dir, 'target'); mkdirSync(target); config.session.dataDir = dir;
  sessions.init('cwd-test'); workers.setActiveSessionsRegistry(new Map()); registerSessionWorkingDirApi('cwd-test');
  server = await startIpcServer({ port: 0, host: '127.0.0.1' });
});
afterEach(async () => {
  await server?.close(); vi.restoreAllMocks(); workers.setActiveSessionsRegistry(new Map());
  config.session.dataDir = previous; sessions.init(); rmSync(dir, { recursive: true, force: true });
});

/** 创建隔离会话，路径和身份都由本测试显式指定。 */
function session() {
  const s = sessions.createSession('chat', 'root', 'synthetic');
  Object.assign(s, { larkAppId: 'cwd-test', cliId: 'codex-app', workingDir: dir });
  sessions.updateSession(s); return s;
}
/** 向实际路由发请求，保留 HTTP 状态与状态机结果。 */
async function request(id: string, body?: unknown) {
  const response = await fetch(`http://127.0.0.1:${server.port}/api/sessions/${id}/working-dir`, body === undefined
    ? {} : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  return { code: response.status, body: await response.json() };
}

it('当前轮只登记指定会话请求，实际目录和其它会话均不变', async () => {
  const a = session(), b = session(), send = vi.fn();
  vi.spyOn(workers, 'findActiveBySessionId').mockImplementation(id => id === a.sessionId
    ? { session: a, workingDir: dir, initConfig: { workingDir: dir }, worker: { send, killed: false } } as any : undefined);
  const result = await request(a.sessionId, { workingDir: target });
  expect(result.code).toBe(200); expect(result.body).toMatchObject({ ok: true, actualWorkingDir: dir,
    workingDir: dir, pendingWorkingDir: target, status: 'pending_next_turn', globalConfigChanged: false });
  expect(send).not.toHaveBeenCalled(); expect(sessions.getSession(b.sessionId)?.pendingWorkingDir).toBeUndefined();
  expect((await request(a.sessionId)).body.pendingWorkingDir).toBe(target);
  const stored = JSON.parse(readFileSync(join(dir, 'sessions-cwd-test.json'), 'utf8'));
  expect((Object.values(stored) as any[]).find(item => item.sessionId === a.sessionId).pendingWorkingDir).toBe(target);
});

it('缺少 daemon worker 不意味着后台空闲，设置只登记请求而不销毁旧 CLI', async () => {
  const a = session(), ds = { session: a, workingDir: dir, worker: null } as any;
  vi.spyOn(workers, 'findActiveBySessionId').mockReturnValue(ds);
  const kill = vi.spyOn(workers, 'killWorker').mockImplementation(() => undefined);
  const result = await request(a.sessionId, { workingDir: target });
  expect(result.body).toMatchObject({ workingDir: dir, pendingWorkingDir: target, actualWorkingDir: null, status: 'pending_next_turn' });
  expect(kill).not.toHaveBeenCalled(); expect(a.workingDir).toBe(dir);
});

it('撤销待生效请求保留实际目录和话题', async () => {
  const a = session(); await request(a.sessionId, { workingDir: target });
  expect((await request(a.sessionId, { cancel: true })).body.pendingWorkingDir).toBeNull();
  expect(a.workingDir).toBe(dir); expect(a.rootMessageId).toBe('root');
});

it.each(['foreign', 'closed', 'adopted', 'stored-adopted', 'sandbox'])('拒绝 %s，不更改会话目录', async kind => {
  const a = session(); if (kind === 'foreign') a.larkAppId = 'another';
  if (kind === 'closed') a.status = 'closed'; if (kind === 'sandbox') a.sandbox = true;
  if (kind === 'stored-adopted') a.adoptedFrom = { cwd: dir } as any;
  sessions.updateSession(a);
  if (kind === 'adopted') vi.spyOn(workers, 'findActiveBySessionId').mockReturnValue({ session: a, adoptedFrom: {} } as any);
  const result = await request(a.sessionId, { workingDir: target });
  expect(result.code).toBe(409); expect(a.pendingWorkingDir).toBeUndefined(); expect(a.workingDir).toBe(dir);
});

it.each([{}, null, [], { workingDir: '' }, { workingDir: '../missing' }, { workingDir: target, extra: true }])('无效请求 %j 不落盘', async body => {
  const a = session(); const result = await request(a.sessionId, body);
  expect(result.code).toBe(409); expect(a.pendingWorkingDir).toBeUndefined();
});

it('目录切换进行中拒绝撤销，未知会话不能被创建或复活', async () => {
  const a = session(); vi.spyOn(workers, 'findActiveBySessionId').mockReturnValue({ session: a, workingDirSwitchInFlight: true } as any);
  expect((await request(a.sessionId, { cancel: true })).code).toBe(409);
  vi.mocked(workers.findActiveBySessionId).mockReturnValue(undefined);
  expect((await request('missing', { workingDir: target })).code).toBe(409);
  expect(sessions.getSession('missing')).toBeUndefined();
});
