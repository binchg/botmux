/** 卡片补齐必须隔离机器人、绕过正在发出的卡片，并限制单批请求数。 */
import { beforeEach, expect, it, vi } from 'vitest';
const f = vi.hoisted(() => ({ sessions: [] as any[], prefs: {} as any, patch: vi.fn(), needs: vi.fn(() => true), statsNeeds: vi.fn(() => false) }));
vi.mock('../src/config.js', () => ({ config: { session: { dataDir: '/data' } } }));
vi.mock('../src/bot-registry.js', () => ({ getBot: () => ({ config: { cliId: 'codex-app', ...f.prefs } }) }));
vi.mock('../src/i18n/index.js', () => ({ localeForBot: () => 'zh' }));
vi.mock('../src/im/lark/card-builder.js', () => ({ buildStreamingCard: () => '{}', getCliDisplayName: () => 'Codex App' }));
vi.mock('../src/core/worker-pool.js', () => ({ listActiveSessions: () => f.sessions, scheduleCardPatch: f.patch,
  cardUsageLimit: () => undefined, writableTerminalLinkFor: () => undefined, CARD_POSTING_SENTINEL: '__posting__' }));
vi.mock('../src/core/terminal-url.js', () => ({ buildTerminalUrl: () => 'http://terminal' }));
vi.mock('../src/services/session-model-card-status.js', () => ({ sessionModelCardNeedsRefresh: f.needs }));
vi.mock('../src/services/session-card-statistics.js', () => ({ sessionCardStatisticsNeedsRefresh: f.statsNeeds }));
vi.mock('../src/services/session-card-task-context.js', () => ({ sessionCardTaskContextNeedsRefresh: () => false }));
import { refreshSessionModelCards } from '../src/services/session-model-card-refresh.js';

/** 模拟已发出的普通会话卡，不包含实际用户输入或飞书凭据。 */
const live = (id: string, extra: any = {}) => ({ larkAppId: 'selected', workerPort: 9000,
  session: { sessionId: id, status: 'active', cliId: 'codex-app', rootMessageId: 'root' },
  streamCardId: 'card-' + id, streamCardNonce: 'nonce-' + id, ...extra });
beforeEach(() => { f.sessions = []; f.prefs = {}; f.patch.mockClear(); f.needs.mockReset().mockReturnValue(true); f.statsNeeds.mockReset().mockReturnValue(false); });

it('模型不变时仍可补齐刚出现的真实统计', () => {
  f.sessions = [live('statistics')]; f.needs.mockReturnValue(false); f.statsNeeds.mockReturnValue(true);
  expect(refreshSessionModelCards('selected')).toBe(1);
});

it('每批最多补三张，未变化时不发 PATCH', () => {
  f.sessions = Array.from({ length: 5 }, (_, i) => live(String(i)));
  expect(refreshSessionModelCards('selected')).toBe(3);
  expect(f.patch).toHaveBeenCalledTimes(3);
  f.needs.mockReturnValue(false); f.patch.mockClear();
  expect(refreshSessionModelCards('selected')).toBe(0);
  expect(f.patch).not.toHaveBeenCalled();
});

it('不触碰其它机器人、关闭会话、发卡中、在途 PATCH 或下一轮待发卡', () => {
  f.sessions = [live('other', { larkAppId: 'other' }), live('posting', { streamCardId: '__posting__' }),
    live('inflight', { cardPatchInFlight: true }), live('queued', { pendingCardJson: '{}' }),
    live('next', { streamCardPending: true }), live('closed', { session: { sessionId: 'closed', status: 'closed' } })];
  expect(refreshSessionModelCards('selected')).toBe(0);
  expect(f.patch).not.toHaveBeenCalled();
});

it('保留卡片禁用和私有模式；显式强制卡仍可补齐', () => {
  f.prefs = { disableStreamingCard: true, privateCard: true };
  f.sessions = [live('disabled')];
  expect(refreshSessionModelCards('selected')).toBe(0);
  f.sessions = [live('forced', { streamingCardForced: true })];
  expect(refreshSessionModelCards('selected')).toBe(1);
});
