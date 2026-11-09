import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import * as sessions from '../src/services/session-store.js';
import { dashboardEventBus } from '../src/core/dashboard-events.js';
import { applyStoppedSessionWorkingDir, requestSessionWorkingDir, resolveSessionWorkingDir,
  sendInputWithSessionWorkingDir, sessionWorkingDirStatus } from '../src/core/session-working-dir.js';
import type { DaemonSession } from '../src/core/types.js';

/** 验证持久目录状态、延后切换与输入串行化，不启动真实 AI 或覆盖用户目录。 */
let root: string, oldDir: string, target: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'botmux-cwd-'));
  oldDir = join(root, 'old'); target = join(root, 'new');
  mkdirSync(oldDir); mkdirSync(target);
  vi.spyOn(sessions, 'updateSession').mockImplementation(() => undefined);
  vi.spyOn(dashboardEventBus, 'publish').mockImplementation(() => undefined);
});
afterEach(() => { vi.restoreAllMocks(); rmSync(root, { recursive: true, force: true }); });

/** 最小运行态保留身份、历史与真实启动目录，供进程回调注入测试。 */
function live(status = 'idle'): DaemonSession {
  return { session: { sessionId: 'owned', larkAppId: 'bot', status: 'active', workingDir: oldDir,
    chatId: 'chat', rootMessageId: 'thread', title: 'history', cliId: 'codex-app' },
    workingDir: oldDir, hasHistory: true, lastScreenStatus: status,
    initConfig: { workingDir: oldDir }, worker: { killed: false, send: vi.fn() } } as unknown as DaemonSession;
}
const message = { type: 'message' as const, content: 'next input', turnId: 'turn-2' };

/** 模拟旧进程退出后再安装新 worker，严格验证只投递一次。 */
function runtime(ds: DaemonSession) {
  const send = vi.fn();
  return { delivered: send, stop: vi.fn(async () => { ds.worker = null; }),
    start: vi.fn((_live, input) => {
      ds.worker = { killed: false, send } as any; ds.initConfig = { workingDir: ds.workingDir } as any;
      // 模拟 init.prompt 的投递，不模拟启动后抢先发送第二条 IPC。
      send(input);
    }) };
}

describe('目录请求与状态', () => {
  it('只登记当前会话请求，不终止正在回复的 worker', () => {
    const ds = live('working'), other = live(); other.session.sessionId = 'other';
    requestSessionWorkingDir(ds.session, ds, { workingDir: target });
    expect(ds.workingDir).toBe(oldDir); expect(ds.session.workingDir).toBe(oldDir);
    expect(ds.worker!.send).not.toHaveBeenCalled(); expect(other.session.pendingWorkingDir).toBeUndefined();
    expect(sessionWorkingDirStatus(ds.session, ds)).toMatchObject({ workingDir: oldDir, actualWorkingDir: oldDir,
      pendingWorkingDir: target, status: 'pending_next_turn', globalConfigChanged: false });
    expect(sessions.updateSession).toHaveBeenCalledWith(ds.session);
  });
  it('取消请求不改变旧目录，同目录别名也不触发重启', () => {
    const ds = live(); requestSessionWorkingDir(ds.session, ds, { workingDir: target });
    requestSessionWorkingDir(ds.session, ds, { cancel: true });
    expect(ds.session.pendingWorkingDir).toBeUndefined(); expect(ds.workingDir).toBe(oldDir);
    const alias = join(root, 'alias'); symlinkSync(oldDir, alias);
    requestSessionWorkingDir(ds.session, ds, { workingDir: target });
    requestSessionWorkingDir(ds.session, ds, { workingDir: alias });
    expect(ds.session.pendingWorkingDir).toBeUndefined();
  });
  it('相对路径以会话目录为基准，不依赖 daemon 的启动目录', () => {
    expect(resolveSessionWorkingDir('../new', oldDir)).toBe(target);
    expect(() => resolveSessionWorkingDir('relative')).toThrow('absolute_working_dir_required');
  });
  it.each([null, [], {}, { cancel: false }, { workingDir: target, cancel: true }, { workingDir: '' },
    { workingDir: 1 }, { workingDir: '\0' }])('无效请求不落盘：%j', body => {
    const ds = live(); expect(() => requestSessionWorkingDir(ds.session, ds, body)).toThrow();
    expect(sessions.updateSession).not.toHaveBeenCalled();
  });
  it('缺失路径和普通文件都被拒绝，不创建目录', () => {
    const ds = live(); const file = join(root, 'file'); writeFileSync(file, 'synthetic');
    for (const path of [file, join(root, 'missing')]) expect(() => requestSessionWorkingDir(ds.session, ds, { workingDir: path })).toThrow();
    expect(sessions.updateSession).not.toHaveBeenCalled();
  });
  it('切换进行中禁止覆盖或撤销请求', () => {
    const ds = live(); ds.workingDirSwitchInFlight = true;
    for (const body of [{ workingDir: target }, { cancel: true }]) {
      expect(() => requestSessionWorkingDir(ds.session, ds, body)).toThrow('working_dir_switch_in_progress');
    }
  });
});

describe('安全输入与冷启动', () => {
  it('无请求时原样投递，不重启运行器', async () => {
    const ds = live(), rt = runtime(ds), old = ds.worker!;
    await sendInputWithSessionWorkingDir(ds, message, rt);
    expect(old.send).toHaveBeenCalledExactlyOnceWith(message); expect(rt.stop).not.toHaveBeenCalled();
  });
  it.each(['working', 'starting', 'analyzing', 'limited'])('状态 %s 保持旧运行器和待切换请求', async status => {
    const ds = live(status), rt = runtime(ds), old = ds.worker!;
    requestSessionWorkingDir(ds.session, ds, { workingDir: target });
    await sendInputWithSessionWorkingDir(ds, message, rt);
    expect(old.send).toHaveBeenCalledExactlyOnceWith(message); expect(rt.stop).not.toHaveBeenCalled();
    expect(ds.session.pendingWorkingDir).toBe(target);
  });
  it('仍有回复在途时不抢先终止进程', async () => {
    const ds = live(), rt = runtime(ds); ds.outboundReplies = new Set([Promise.resolve()]);
    requestSessionWorkingDir(ds.session, ds, { workingDir: target });
    await sendInputWithSessionWorkingDir(ds, message, rt); expect(rt.stop).not.toHaveBeenCalled();
  });
  it('空闲输入等旧 worker 退出，再启动新目录并保留身份及历史', async () => {
    const ds = live(), rt = runtime(ds), old = ds.worker!;
    requestSessionWorkingDir(ds.session, ds, { workingDir: target });
    let release!: () => void, started!: () => void;
    const stopping = new Promise<void>(resolve => { started = resolve; });
    rt.stop.mockImplementation(() => new Promise<void>(resolve => {
      release = () => { ds.worker = null; resolve(); }; started();
    }));
    const first = sendInputWithSessionWorkingDir(ds, message, rt);
    await stopping; expect(rt.start).not.toHaveBeenCalled(); expect(old.send).not.toHaveBeenCalled();
    const second = sendInputWithSessionWorkingDir(ds, { ...message, content: 'follow-up' }, rt);
    release(); await Promise.all([first, second]);
    expect(rt.stop).toHaveBeenCalledTimes(1); expect(rt.start).toHaveBeenCalledTimes(1);
    expect(rt.delivered.mock.calls.map(call => call[0].content)).toEqual(['next input', 'follow-up']);
    expect(ds.session).toMatchObject({ sessionId: 'owned', rootMessageId: 'thread', title: 'history', workingDir: target });
    expect(ds.hasHistory).toBe(true); expect(ds.session.pendingWorkingDir).toBeUndefined();
    expect(sessionWorkingDirStatus(ds.session, ds).actualWorkingDir).toBe(target);
  });
  it('持久请求可恢复，但仅缺少 worker 不能直接提交目录', () => {
    const ds = live(); requestSessionWorkingDir(ds.session, ds, { workingDir: target });
    ds.session = JSON.parse(JSON.stringify(ds.session)); ds.worker = null;
    expect(() => applyStoppedSessionWorkingDir(ds)).toThrow('working_dir_switch_not_safely_stopped');
    expect(ds.workingDir).toBe(oldDir); expect(ds.session.pendingWorkingDir).toBe(target);
    ds.workingDirSwitchInFlight = true;
    expect(applyStoppedSessionWorkingDir(ds)).toBe(true); expect(ds.workingDir).toBe(target);
    expect(ds.initConfig).toBeUndefined(); expect(ds.session.pendingWorkingDir).toBeUndefined();
  });
  it('目标在下轮前消失时保持 blocked，不停旧进程也不回退 HOME', async () => {
    const ds = live(), rt = runtime(ds); requestSessionWorkingDir(ds.session, ds, { workingDir: target });
    rmSync(target, { recursive: true });
    await expect(sendInputWithSessionWorkingDir(ds, message, rt)).rejects.toThrow();
    expect(rt.stop).not.toHaveBeenCalled(); expect(ds.workingDir).toBe(oldDir);
    expect(sessionWorkingDirStatus(ds.session, ds).status).toBe('blocked');
    expect(ds.session.pendingWorkingDir).toBe(target);
  });
  it('无请求时已接受的输入也立即标忙，随后设置目录不能误杀该轮', async () => {
    const ds = live(), rt = runtime(ds), old = ds.worker!;
    await sendInputWithSessionWorkingDir(ds, message, rt);
    expect(ds.lastScreenStatus).toBe('working');
    requestSessionWorkingDir(ds.session, ds, { workingDir: target });
    await sendInputWithSessionWorkingDir(ds, { ...message, content: 'follow-up' }, rt);
    expect(rt.stop).not.toHaveBeenCalled(); expect(old.send).toHaveBeenCalledTimes(2);
    expect(ds.session.pendingWorkingDir).toBe(target);
  });
  it('冷恢复输入交给原目录初始化，不推断后台空闲或兑现待切换请求', async () => {
    const ds = live(), rt = runtime(ds); ds.worker = null;
    requestSessionWorkingDir(ds.session, ds, { workingDir: target });
    await sendInputWithSessionWorkingDir(ds, message, rt);
    expect(rt.stop).not.toHaveBeenCalled(); expect(rt.start).toHaveBeenCalledExactlyOnceWith(ds, message);
    expect(ds.workingDir).toBe(oldDir); expect(ds.session.pendingWorkingDir).toBe(target);
    expect(rt.delivered).toHaveBeenCalledExactlyOnceWith(message);
  });
  it('退出失败不启动新 worker，保留可重试的目录请求', async () => {
    const ds = live(), rt = runtime(ds); requestSessionWorkingDir(ds.session, ds, { workingDir: target });
    rt.stop.mockRejectedValue(new Error('exit_failed'));
    await expect(sendInputWithSessionWorkingDir(ds, message, rt)).rejects.toThrow('exit_failed');
    expect(rt.start).not.toHaveBeenCalled(); expect(ds.session.pendingWorkingDir).toBe(target);
    expect(ds.session.pendingWorkingDirError).toBe('exit_failed'); expect(ds.workingDirSwitchInFlight).toBeUndefined();
    ds.worker = null;
    await expect(sendInputWithSessionWorkingDir(ds, message, rt)).rejects.toThrow('exit_failed');
    expect(rt.start).not.toHaveBeenCalled();
  });
});
