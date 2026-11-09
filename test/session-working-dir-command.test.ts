import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  parseWorkingDirCommand, runSessionWorkingDirCommand, WORKING_DIR_COMMAND_HELP,
} from '../src/cli/session-working-dir-command.js';

const invalidArgs = [
  ['status', '/tmp/project'], ['/tmp/project'], ['set'], ['set', '/one', '/two'],
  ['set', ''], ['set', '   '], ['cancel', '/tmp/project'], ['status', 'status'], ['unknown'],
  ['--unknown'], ['--'], ['--json=true'], ['--session-id=id'], ['-x'],
  ['--session-id'], ['--session-id', ''], ['--session-id', '   '],
  ['--session-id', '--json'], ['--session-id', '-h'],
  ['--session-id', 'one', '--session-id', 'two'], ['--json', '--json'], ['--help', '-h'],
  ['--help', '--unknown'], ['--help', '--session-id'], ['status', '/tmp', '--help'],
];

function jsonResponse(result: unknown, status = 200): Response {
  return new Response(JSON.stringify(result), { status, headers: { 'content-type': 'application/json' } });
}

const context = { sessionId: 'session/中文 ?#', ipcPort: 7788 };
const url = `http://127.0.0.1:7788/api/sessions/${encodeURIComponent(context.sessionId)}/working-dir`;
const statusResult = {
  ok: true, sessionId: context.sessionId, actualWorkingDir: '/running', workingDir: '/configured',
  pendingWorkingDir: '/next', status: 'pending', appliesTo: 'next_safe_input', globalConfigChanged: false,
};

describe('cwd 参数解析', () => {
  it.each([
    { args: [], expected: { action: 'status' } },
    { args: ['status'], expected: { action: 'status' } },
    { args: ['--json'], expected: { action: 'status' } },
    { args: ['status', '--json'], expected: { action: 'status' } },
    { args: ['set', '/tmp/项目 with spaces'], expected: { action: 'set', body: { workingDir: '/tmp/项目 with spaces' } } },
    { args: ['set', '../relative'], expected: { action: 'set', body: { workingDir: '../relative' } } },
    { args: ['cancel'], expected: { action: 'cancel', body: { cancel: true } } },
    { args: ['--session-id', 'target', '--json', 'set', '/new'], expected: { action: 'set', sessionId: 'target', body: { workingDir: '/new' } } },
    { args: ['cancel', '--session-id', 'target', '--json'], expected: { action: 'cancel', sessionId: 'target', body: { cancel: true } } },
    { args: ['--help'], expected: { action: 'help' } },
    { args: ['set', '--help'], expected: { action: 'help' } },
    { args: ['help'], expected: { action: 'help' } },
  ])('接受 $args 并移除输出、会话选项', ({ args, expected }) => {
    expect(parseWorkingDirCommand(args)).toEqual(expected);
  });

  it.each(invalidArgs.map(args => ({ args })))('拒绝 $args', ({ args }) => {
    expect(() => parseWorkingDirCommand(args)).toThrow();
  });

  it('不修改调用方参数数组', () => {
    const args = ['set', '/new', '--session-id', 'target', '--json'];
    parseWorkingDirCommand(args);
    expect(args).toEqual(['set', '/new', '--session-id', 'target', '--json']);
  });
});

describe('cwd 注入上下文与 HTTP 请求', () => {
  const fetchMock = vi.fn<typeof fetch>();
  const logMock = vi.fn();
  const errorMock = vi.fn();
  const signal = new AbortController().signal;

  beforeEach(() => {
    fetchMock.mockReset().mockResolvedValue(jsonResponse(statusResult));
    logMock.mockReset();
    errorMock.mockReset();
    vi.stubGlobal('fetch', fetchMock);
    vi.spyOn(console, 'log').mockImplementation(logMock);
    vi.spyOn(console, 'error').mockImplementation(errorMock);
    vi.spyOn(AbortSignal, 'timeout').mockReturnValue(signal);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it.each([[], ['status'], ['status', '--json'], ['--session-id', context.sessionId, '--json']])(
    '以 GET 查询状态，保留后端实际目录与待切换目录：%j', async (...args) => {
      expect(await runSessionWorkingDirCommand(args, context)).toBe(0);
      expect(fetchMock).toHaveBeenCalledExactlyOnceWith(url, { method: 'GET', signal });
      expect(AbortSignal.timeout).toHaveBeenCalledWith(30_000);
      expect(logMock).toHaveBeenCalledExactlyOnceWith(JSON.stringify(statusResult, null, 2));
      expect(errorMock).not.toHaveBeenCalled();
    },
  );

  it('set 只提交一个路径，不把待生效状态伪装成已切换', async () => {
    const path = '/tmp/中文 项目';
    const result = { ...statusResult, pendingWorkingDir: path };
    fetchMock.mockResolvedValue(jsonResponse(result));
    expect(await runSessionWorkingDirCommand(['set', path, '--session-id', context.sessionId, '--json'], context)).toBe(0);
    expect(fetchMock).toHaveBeenCalledExactlyOnceWith(url, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ workingDir: path }), signal,
    });
    expect(AbortSignal.timeout).toHaveBeenCalledWith(30_000);
    expect(JSON.parse(logMock.mock.calls[0][0])).toEqual(result);
    expect(errorMock).not.toHaveBeenCalled();
  });

  it('cancel 使用同一端点且只提交 cancel 标记', async () => {
    const result = { ...statusResult, pendingWorkingDir: null, status: 'cancelled', appliesTo: 'none' };
    fetchMock.mockResolvedValue(jsonResponse(result));
    expect(await runSessionWorkingDirCommand(['--json', 'cancel', '--session-id', context.sessionId], context)).toBe(0);
    expect(fetchMock).toHaveBeenCalledExactlyOnceWith(url, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"cancel":true}', signal,
    });
    expect(JSON.parse(logMock.mock.calls[0][0])).toEqual(result);
  });

  it('只使用入口注入的目标会话和 daemon，不自行发现或覆盖上下文', async () => {
    expect(await runSessionWorkingDirCommand(['status', '--session-id', 'validated-target'], context)).toBe(0);
    expect(fetchMock.mock.calls[0][0]).toBe(url);
  });

  it.each([
    { status: 400, result: { ok: false, error: 'working_dir_not_found' }, message: 'working_dir_not_found' },
    { status: 403, result: { ok: false, error: 'session_forbidden' }, message: 'session_forbidden' },
    { status: 503, result: {}, message: 'HTTP 503' },
    { status: 409, result: { ok: true }, message: 'HTTP 409' },
    { status: 200, result: { ok: false, error: 'working_dir_unavailable' }, message: 'working_dir_unavailable' },
    { status: 200, result: null, message: 'invalid_working_dir_response' },
    { status: 200, result: { status: 'pending' }, message: 'invalid_working_dir_response' },
  ])('报告 HTTP $status 或后端失败，不打印成功 JSON', async ({ status, result, message }) => {
    fetchMock.mockResolvedValue(jsonResponse(result, status));
    expect(await runSessionWorkingDirCommand(['set', '/new'], context)).toBe(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(errorMock).toHaveBeenCalledExactlyOnceWith(message);
    expect(logMock).not.toHaveBeenCalled();
  });

  it.each([
    { status: 502, message: 'HTTP 502' },
    { status: 200, message: 'invalid_working_dir_response' },
  ])('处理非 JSON 的 HTTP $status 响应', async ({ status, message }) => {
    fetchMock.mockResolvedValue(new Response('非 JSON 响应', { status }));
    expect(await runSessionWorkingDirCommand(['status'], context)).toBe(1);
    expect(errorMock).toHaveBeenCalledExactlyOnceWith(message);
    expect(logMock).not.toHaveBeenCalled();
  });

  it.each([
    { error: new Error('network_timeout'), message: 'network_timeout' },
    { error: 'unexpected_failure', message: 'working_dir_command_failed' },
  ])('捕获网络异常并返回失败码', async ({ error, message }) => {
    fetchMock.mockRejectedValue(error);
    expect(await runSessionWorkingDirCommand(['cancel'], context)).toBe(1);
    expect(errorMock).toHaveBeenCalledExactlyOnceWith(message);
    expect(logMock).not.toHaveBeenCalled();
  });

  it.each([[], ['set', '/new'], ['cancel'], ['status', '--session-id', 'target']])(
    '没有注入上下文时不发请求：%j', async (...args) => {
      expect(await runSessionWorkingDirCommand(args)).toBe(1);
      expect(errorMock).toHaveBeenCalledExactlyOnceWith('current_session_or_daemon_not_found');
      expect(fetchMock).not.toHaveBeenCalled();
      expect(AbortSignal.timeout).not.toHaveBeenCalled();
      expect(logMock).not.toHaveBeenCalled();
    },
  );

  it.each(invalidArgs.map(args => ({ args })))('非法参数 $args 即使有上下文也不发请求', async ({ args }) => {
    expect(await runSessionWorkingDirCommand(args, context)).toBe(1);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(AbortSignal.timeout).not.toHaveBeenCalled();
    expect(errorMock).toHaveBeenCalledTimes(1);
    expect(logMock).not.toHaveBeenCalled();
  });

  it.each([['--help'], ['-h'], ['help'], ['set', '--help'], ['cancel', '--help', '--session-id', 'target', '--json']])(
    '帮助无需上下文且不发请求：%j', async (...args) => {
      expect(await runSessionWorkingDirCommand(args)).toBe(0);
      expect(logMock).toHaveBeenCalledExactlyOnceWith(WORKING_DIR_COMMAND_HELP);
      expect(fetchMock).not.toHaveBeenCalled();
      expect(AbortSignal.timeout).not.toHaveBeenCalled();
      expect(errorMock).not.toHaveBeenCalled();
    },
  );

  it('帮助明确说明下一安全输入生效且不改全局配置', () => {
    expect(WORKING_DIR_COMMAND_HELP).toContain('下一次安全输入');
    expect(WORKING_DIR_COMMAND_HELP).toContain('不终止当前 worker');
    expect(WORKING_DIR_COMMAND_HELP).toContain('globalConfigChanged: false');
    expect(WORKING_DIR_COMMAND_HELP).toContain('actualWorkingDir');
    expect(WORKING_DIR_COMMAND_HELP).toContain('pendingWorkingDir');
  });
});
