// 验证额度换算、飞书 /status 权限和 Codex RPC 失败回退。
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { registerBot } from '../src/bot-registry.js';
import { handleCommand, SESSIONLESS_DAEMON_COMMANDS } from '../src/core/command-handler.js';
import { parseCodexQuota, readCodexQuota } from '../src/services/codex-quota.js';

const rpc = vi.hoisted(() => ({ initialize: vi.fn(), request: vi.fn(), close: vi.fn() }));
vi.mock('../src/services/app-runner-client.js', () => ({
  AppServerClient: class { initialize = rpc.initialize; request = rpc.request; close = rpc.close; },
}));

const appId = 'cli_quota_test';
const owner = 'ou_quota_owner';

/** 执行真实命令处理器并截获回复，测试过程不连接飞书。 */
async function status(senderId = owner): Promise<string> {
  const sessionReply = vi.fn(async (_rootId: string, _content: string) => 'om_replied');
  await handleCommand('/status', 'om_root', {
    messageId: 'om_status', senderId, senderType: 'user', content: '/status', msgType: 'text', createTime: '0',
  }, { sessionReply, activeSessions: new Map(), getActiveCount: () => 0, lastRepoScan: new Map() }, appId);
  return sessionReply.mock.calls[0][1];
}

beforeEach(() => {
  vi.resetAllMocks();
  registerBot({
    larkAppId: appId, larkAppSecret: 'test', cliId: 'codex-app', cliPathOverride: '/test/codex',
    workingDir: '/test/project', allowedUsers: [owner], locale: 'zh',
  });
});

describe('Codex 订阅剩余额度', () => {
  it('使用 Codex 桶并保留 0% 和 100%', () => {
    expect(parseCodexQuota({
      rateLimits: { limitId: 'other', primary: { usedPercent: 33 } },
      rateLimitsByLimitId: { codex: {
        primary: { usedPercent: 100, windowDurationMins: 300 },
        secondary: { usedPercent: 0, windowDurationMins: 10080 },
      } },
    })).toEqual([
      { window: 'primary', remainingPercent: 0, durationMinutes: 300 },
      { window: 'secondary', remainingPercent: 100, durationMinutes: 10080 },
    ]);
  });

  it('兼容旧响应并忽略其他额度桶与缺失窗口', () => {
    expect(parseCodexQuota({ rateLimits: { limitId: 'other', primary: { usedPercent: 0 } } })).toEqual([]);
    expect(parseCodexQuota({ rateLimits: {
      primary: { usedPercent: -1 }, secondary: { usedPercent: 65, windowDurationMins: 10080 },
    } })).toEqual([{ window: 'secondary', remainingPercent: 35, durationMinutes: 10080 }]);
  });

  it('从无会话的话题读取额度并显示真实窗口', async () => {
    rpc.request.mockResolvedValue({ rateLimits: { primary: { usedPercent: 65, windowDurationMins: 10080 } } });
    expect(SESSIONLESS_DAEMON_COMMANDS.has('/status')).toBe(true);
    expect(await status()).toContain('Codex 剩余额度 · 7 天 35%');
    expect(rpc.request).toHaveBeenCalledExactlyOnceWith('account/rateLimits/read', undefined);
    expect(rpc.close).toHaveBeenCalledOnce();
  });

  it('只向本机器人操作人查询额度，查询失败时仍返回状态', async () => {
    rpc.request.mockRejectedValue(new Error('private RPC error'));
    expect(await status('ou_peer')).not.toContain('剩余额度');
    expect(rpc.request).not.toHaveBeenCalled();
    const reply = await status();
    expect(reply).toContain('没有活跃的会话');
    expect(reply).toContain('Codex 剩余额度暂不可用');
    expect(reply).not.toContain('private RPC error');
    expect(rpc.close).toHaveBeenCalledOnce();
  });

  it('握手超时后关闭临时进程', async () => {
    rpc.initialize.mockImplementation(() => new Promise(() => {}));
    await expect(readCodexQuota({ codexBin: '/test/codex', cwd: '/test/project', timeoutMs: 5 }))
      .rejects.toThrow('Codex quota read timed out');
    expect(rpc.request).not.toHaveBeenCalled();
    expect(rpc.close).toHaveBeenCalledOnce();
  });
});
