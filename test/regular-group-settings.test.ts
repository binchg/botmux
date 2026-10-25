/** 配置持久化、旧策略兼容以及机器人和群之间的隔离回归。 */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({ dataDir: '', bot: {} as any }));
vi.mock('../src/config.js', () => ({ config: { session: state } }));
vi.mock('../src/bot-registry.js', () => ({ getBot: () => ({ config: state.bot }) }));
import { regularGroupOverrides, regularGroupSettings, setRegularGroupSetting } from '../src/services/regular-group-settings.js';
import { ownerContinuationEnabled } from '../src/im/lark/regular-group-continuation.js';
import { readGroupCardSnapshot, saveGroupCardSnapshot } from '../src/services/regular-group-card-snapshots.js';

beforeEach(() => {
  state.dataDir = mkdtempSync(join(tmpdir(), 'botmux-group-settings-'));
  state.bot = {};
});
afterEach(() => rmSync(state.dataDir, { recursive: true, force: true }));

describe('普通群独立设置', () => {
  it('原卡快照跨读取保留回调参数，并按机器人和消息隔离', () => {
    const card = { elements: [{ tag: 'button', value: { action: 'close', session_id: 's' } }] };
    saveGroupCardSnapshot('app', 'message', card);
    expect(readGroupCardSnapshot('app', 'message')).toEqual(card);
    expect(readGroupCardSnapshot('other', 'message')).toBeUndefined();
    expect(readGroupCardSnapshot('app', 'other')).toBeUndefined();
    saveGroupCardSnapshot('app', 'message', { ...card, header: 'updated' });
    expect(readGroupCardSnapshot('app', 'message').header).toBe('updated');
  });
  it('未设置时沿用全局默认与旧的新话题策略', () => {
    expect(regularGroupSettings('app', 'chat')).toEqual({ sync: false, reuse: true });
    state.bot = { regularGroupFinalToChat: true, regularGroupOwnerContinuation: false, regularGroupReplyMode: 'new-topic' };
    expect(regularGroupSettings('app', 'chat')).toEqual({ sync: true, reuse: false });
    state.bot.regularGroupReplyMode = 'chat';
    expect(regularGroupSettings('app', 'chat').reuse).toBe(true);
    expect(ownerContinuationEnabled('app', 'chat')).toBe(false);
  });
  it('并发修改不同字段保留双方结果，重复回调幂等且其它机器人和群不变', async () => {
    await Promise.all([
      setRegularGroupSetting('app', 'chat', 'sync', true),
      setRegularGroupSetting('app', 'chat', 'reuse', false),
    ]);
    await setRegularGroupSetting('app', 'chat', 'reuse', false);
    expect(regularGroupSettings('app', 'chat')).toEqual({ sync: true, reuse: false });
    expect(ownerContinuationEnabled('app', 'chat')).toBe(true);
    expect(regularGroupSettings('other', 'chat')).toEqual({ sync: false, reuse: true });
    expect(regularGroupSettings('app', 'other')).toEqual({ sync: false, reuse: true });
    const entries = JSON.parse(readFileSync(join(state.dataDir, 'regular-group-settings.json'), 'utf8'));
    expect(entries[JSON.stringify(['app', 'chat'])]).toEqual(regularGroupOverrides('app', 'chat'));
  });
});
