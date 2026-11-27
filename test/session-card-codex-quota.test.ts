// 验证即时卡异步补齐额度、读取限频与机器人的授权边界。
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const f = vi.hoisted(() => ({
  session: {} as any,
  bot: {} as any,
  enabled: true,
  allSessions: false,
  grants: {} as Record<string, string>,
  read: vi.fn(),
  readOriginal: vi.fn(),
}));
vi.mock('../src/config.js', () => ({ config: { daemon: { workingDir: '/bot/cwd' }, session: { dataDir: '/data' } } }));
vi.mock('../src/bot-registry.js', () => ({ getBot: () => f.bot }));
vi.mock('../src/services/session-store.js', () => ({ getSession: () => f.session }));
vi.mock('../src/services/transcript-resolver.js', () => ({ resolveSessionTranscriptPath: () => null }));
vi.mock('../src/services/session-card-customization.js', () => ({
  readSessionCardCustomization: () => ({ codexQuota: f.enabled, codexQuotaAllSessions: f.allSessions, codexQuotaSessionOwners: f.grants }),
}));
vi.mock('../src/services/codex-quota.js', async importOriginal => ({
  ...await importOriginal<typeof import('../src/services/codex-quota.js')>(), readCodexQuota: f.read,
}));
vi.mock('../src/services/codex-original-daemon.js', () => ({ readOriginalCodexQuota: f.readOriginal }));

import { sessionModelCardElements } from '../src/im/lark/session-model-card.js';
import { nativeSessionCardQuota, sessionCardCodexQuota, sessionCardCodexQuotaNeedsRefresh } from '../src/services/session-card-codex-quota.js';

let scenario = 0;
beforeEach(() => {
  vi.stubEnv('BOTMUX_BOT_INDEX', '2');
  f.session = { sessionId: 's', larkAppId: `selected-${++scenario}`, cliId: 'codex-app', status: 'active', ownerOpenId: 'ou_owner' };
  f.bot = { config: { cliId: 'codex-app', cliPathOverride: '/bin/codex' }, resolvedAllowedUsers: ['ou_owner'] };
  f.enabled = true;
  f.grants = {};
  f.allSessions = false;
  f.read.mockReset();
  f.readOriginal.mockReset();
});
afterEach(() => vi.unstubAllEnvs());

/** 等待已排队的额度查询与其微任务更新快照。 */
const settleRead = () => new Promise<void>(resolve => setImmediate(resolve));

it('首张即时卡不等网络，后台读到真实窗口后只补刷一次', async () => {
  const resetsAtMs = Date.now() + (6 * 24 + 3.5) * 3_600_000;
  f.read.mockResolvedValue([{ window: 'secondary', remainingPercent: 34, durationMinutes: 10080, resetsAtMs }]);
  expect(JSON.stringify(sessionModelCardElements('s', 'codex-app', 'zh', 'card-a'))).not.toContain('额度');
  expect(f.read).not.toHaveBeenCalled();
  expect(sessionCardCodexQuotaNeedsRefresh('/data', 's', 'zh', 'card-a')).toBe(false);
  await settleRead();
  expect(f.read).toHaveBeenCalledOnce();
  expect(sessionCardCodexQuotaNeedsRefresh('/data', 's', 'zh', 'card-a')).toBe(true);
  const rows = sessionModelCardElements('s', 'codex-app', 'zh', 'card-a');
  expect(rows).toHaveLength(4);
  expect(rows.map(row => row.text.content)).toEqual([
    expect.stringMatching(/^📁 /), '额度34% 6天3时刷新', expect.stringMatching(/^创建/), expect.any(String),
  ]);
  expect(rows.every(row => row.text.lines === undefined && !row.text.content.includes('\n'))).toBe(true);
  expect(sessionCardCodexQuotaNeedsRefresh('/data', 's', 'zh', 'card-a')).toBe(false);
  expect(JSON.stringify(sessionModelCardElements('s', 'codex-app', 'zh'))).not.toContain('额度');
});

it('同一机器人多卡共享查询，限频内复用结果，查询失败后清除旧额度', async () => {
  f.read.mockResolvedValueOnce([{ window: 'primary', remainingPercent: 0, durationMinutes: 300 }])
    .mockRejectedValueOnce(new Error('timeout'));
  const a = (now: number) => sessionCardCodexQuota('/data', 's', 'zh', 'card-a', now);
  const needs = (now: number) => sessionCardCodexQuotaNeedsRefresh('/data', 's', 'zh', 'card-a', now);
  expect(a(0)).toBeUndefined();
  expect(sessionCardCodexQuota('/data', 's', 'zh', 'card-b', 0)).toBeUndefined();
  await settleRead();
  expect(a(1)).toBe('额度0%');
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

it('机器人开启全会话展示后覆盖普通成员和无所有者会话', async () => {
  f.allSessions = true;
  f.session.ownerOpenId = 'ou_guest';
  f.read.mockResolvedValue([{ window: 'primary', remainingPercent: 42, durationMinutes: 300 }]);
  const label = () => sessionCardCodexQuota('/data', 's', 'zh', 'card-a');
  expect(label()).toBe('Codex 剩余额度 · 读取中');
  await settleRead();
  expect(label()).toContain('42%');
  delete f.session.ownerOpenId;
  expect(label()).toContain('42%');
  f.session.adoptedFrom = { source: 'tmux' };
  expect(label()).toBeUndefined();
  expect(f.read).toHaveBeenCalledOnce();
});

it('外部会话按实际库共享缓存，库与库之间不复用额度', async () => {
  f.allSessions = true;
  f.readOriginal.mockResolvedValueOnce([{ window: 'primary', remainingPercent: 63, durationMinutes: 10080 }])
    .mockResolvedValueOnce(undefined);
  f.read.mockResolvedValue([{ window: 'secondary', remainingPercent: 24, durationMinutes: 300 }]);
  const q = (home: string, thread = 't') =>
    nativeSessionCardQuota('/data', f.session.larkAppId, thread, 'ou_guest', home, '/bin/codex', '/workspace', 'zh');
  expect(q('/native')).toEqual({ label: 'Codex 剩余额度 · 读取中', pending: true });
  expect(q('/native', 't2')?.pending).toBe(true);
  await settleRead();
  expect(q('/native', 't2')?.label).toContain('63%');
  expect(q('/isolated')?.pending).toBe(true);
  await settleRead();
  expect(q('/isolated')?.label).toContain('24%');
  expect(f.readOriginal.mock.calls).toEqual([['/native'], ['/isolated']]);
  expect(f.read).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ env: expect.objectContaining({ CODEX_HOME: '/isolated' }) }));
});
