// 验证即时卡异步补齐额度、读取限频与机器人的授权边界。
import { beforeEach, expect, it, vi } from 'vitest';

const f = vi.hoisted(() => ({
  session: {} as any,
  bot: {} as any,
  enabled: true,
  grants: {} as Record<string, string>,
  read: vi.fn(),
}));
vi.mock('../src/config.js', () => ({ config: { daemon: { workingDir: '/bot/cwd' }, session: { dataDir: '/data' } } }));
vi.mock('../src/bot-registry.js', () => ({ getBot: () => f.bot }));
vi.mock('../src/services/session-store.js', () => ({ getSession: () => f.session }));
vi.mock('../src/services/session-card-customization.js', () => ({
  readSessionCardCustomization: () => ({ codexQuota: f.enabled, codexQuotaSessionOwners: f.grants }),
}));
vi.mock('../src/services/codex-quota.js', async importOriginal => ({
  ...await importOriginal<typeof import('../src/services/codex-quota.js')>(), readCodexQuota: f.read,
}));

import { sessionModelCardElements } from '../src/im/lark/session-model-card.js';
import { sessionCardCodexQuota, sessionCardCodexQuotaNeedsRefresh } from '../src/services/session-card-codex-quota.js';

let scenario = 0;
beforeEach(() => {
  f.session = { sessionId: 's', larkAppId: `selected-${++scenario}`, cliId: 'codex-app', status: 'active', ownerOpenId: 'ou_owner' };
  f.bot = { config: { cliId: 'codex-app', cliPathOverride: '/bin/codex' }, resolvedAllowedUsers: ['ou_owner'] };
  f.enabled = true;
  f.grants = {};
  f.read.mockReset();
});

/** 等待已排队的额度查询与其微任务更新快照。 */
const settleRead = () => new Promise<void>(resolve => setImmediate(resolve));

it('首张即时卡不等网络，后台读到真实窗口后只补刷一次', async () => {
  f.read.mockResolvedValue([{ window: 'secondary', remainingPercent: 34, durationMinutes: 10080 }]);
  expect(JSON.stringify(sessionModelCardElements('s', 'codex-app', 'zh', 'card-a'))).not.toContain('剩余额度');
  expect(f.read).not.toHaveBeenCalled();
  expect(sessionCardCodexQuotaNeedsRefresh('/data', 's', 'zh', 'card-a')).toBe(false);
  await settleRead();
  expect(f.read).toHaveBeenCalledOnce();
  expect(sessionCardCodexQuotaNeedsRefresh('/data', 's', 'zh', 'card-a')).toBe(true);
  expect(JSON.stringify(sessionModelCardElements('s', 'codex-app', 'zh', 'card-a'))).toContain('Codex 剩余额度 · 7 天 34%');
  expect(sessionCardCodexQuotaNeedsRefresh('/data', 's', 'zh', 'card-a')).toBe(false);
  expect(JSON.stringify(sessionModelCardElements('s', 'codex-app', 'zh'))).not.toContain('剩余额度');
});

it('同一机器人多卡共享查询，限频内复用结果，查询失败后清除旧额度', async () => {
  f.read.mockResolvedValueOnce([{ window: 'primary', remainingPercent: 0, durationMinutes: 300 }])
    .mockRejectedValueOnce(new Error('timeout'));
  const a = (now: number) => sessionCardCodexQuota('/data', 's', 'zh', 'card-a', now);
  const needs = (now: number) => sessionCardCodexQuotaNeedsRefresh('/data', 's', 'zh', 'card-a', now);
  expect(a(0)).toBeUndefined();
  expect(sessionCardCodexQuota('/data', 's', 'zh', 'card-b', 0)).toBeUndefined();
  await settleRead();
  expect(a(1)).toBe('Codex 剩余额度 · 5 小时 0%');
  expect(needs(59_999)).toBe(false);
  expect(f.read).toHaveBeenCalledOnce();
  expect(needs(60_000)).toBe(false);
  await settleRead();
  expect(f.read).toHaveBeenCalledTimes(2);
  expect(needs(60_001)).toBe(true);
  expect(a(60_001)).toBeUndefined();
  expect(needs(60_002)).toBe(false);
});

it('未开启、由其他成员发起或接管的会话不查询机器人额度', async () => {
  const label = () => sessionCardCodexQuota('/data', 's', 'zh', 'card-a');
  f.enabled = false;
  expect(label()).toBeUndefined();
  f.enabled = true;
  f.session.ownerOpenId = 'ou_guest';
  expect(label()).toBeUndefined();
  f.session.ownerOpenId = 'ou_owner';
  f.session.adoptedFrom = { source: 'tmux' };
  expect(label()).toBeUndefined();
  await settleRead();
  expect(f.read).not.toHaveBeenCalled();
});

it('精确的会话所有者授权仅允许本会话显示额度', async () => {
  f.session.ownerOpenId = 'ou_guest';
  f.grants.s = 'ou_guest';
  f.read.mockResolvedValue([{ window: 'primary', remainingPercent: 42, durationMinutes: 300 }]);
  const label = () => sessionCardCodexQuota('/data', 's', 'zh', 'card-a');
  expect(label()).toBeUndefined();
  await settleRead();
  expect(label()).toContain('42%');
  f.session.sessionId = 'other';
  expect(label()).toBeUndefined();
  f.session.sessionId = 's';
  f.session.ownerOpenId = 'ou_other_guest';
  expect(label()).toBeUndefined();
  expect(f.read).toHaveBeenCalledOnce();
});
