/** 直接 @ 的正文边界与按机器人持久化策略回归。 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({ dataDir: '' }));
vi.mock('../src/config.js', () => ({ config: { session: state } }));
vi.mock('../src/bot-registry.js', () => ({ getBot: () => ({ botOpenId: 'ou_bot' }) }));
import { isBotDirectlyMentioned } from '../src/im/lark/event-mentions.js';
import { requiresDirectGroupMention, setDirectGroupMention } from '../src/services/group-direct-mention-policy.js';

const mention = { key: '@_user_1', id: { open_id: 'ou_bot' } };
/** 构造正文和提及元数据，避免把引用内容误当作当前正文。 */
function message(type: string, content: unknown, mentions: unknown[] = []) {
  return { message_type: type, content: JSON.stringify(content), mentions };
}

beforeEach(() => { state.dataDir = mkdtempSync(join(tmpdir(), 'botmux-direct-mention-')); });
afterEach(() => { rmSync(state.dataDir, { recursive: true, force: true }); });

describe('当前消息直接 @', () => {
  it('提及紧接中文或标点也能识别', () => {
    for (const text of ['@_user_1，请处理', '@_user_1继续']) {
      expect(isBotDirectlyMentioned('app', message('text', { text }, [mention]))).toBe(true);
    }
  });
  it.each([
    mention,
    { ...mention, id: 'ou_bot', id_type: 'open_id' },
    { ...mention, id: 'app', id_type: 'app_id' },
    { ...mention, id: { app_id: 'app' } },
  ])('支持平台的提及身份形态 %j', m => {
    expect(isBotDirectlyMentioned('app', message('text', { text: '@_user_1 请处理' }, [m]))).toBe(true);
  });

  it.each([
    message('text', { text: '普通聊天' }),
    message('text', { text: '@雪球 请处理' }),
    message('text', { text: '引用里提到了你' }, [mention]),
    message('text', { text: '@_user_10' }, [mention]),
    message('text', { text: '@_all' }, [{ key: '@_all', id: { open_id: 'all' } }]),
    message('text', { text: '@_user_1 请处理' }, [{ ...mention, id: { open_id: 'ou_other' } }]),
    message('share_chat', { chat_id: 'oc_shared' }, [mention]),
    message('merge_forward', { messages: [{ text: '@_user_1', mentions: [mention] }] }, [mention]),
    message('interactive', { content: [[{ tag: 'at', user_id: 'ou_bot' }]] }, [mention]),
    message('post', { content: [[{ tag: 'quote', content: [[{ tag: 'at', user_id: 'ou_bot' }]] }]] }),
    { message_type: 'text', content: '{broken', mentions: [mention] },
  ])('普通消息、分享和嵌套 @ 不触发 %#', value => {
    expect(isBotDirectlyMentioned('app', value)).toBe(false);
  });

  it.each([
    { content: [[{ tag: 'at', user_id: 'ou_bot' }]] },
    { zh_cn: { content: [[{ tag: 'at', user_id: 'ou_bot' }]] } },
    { en_us: { content: [[{ tag: 'at', user_id: '@_user_1' }]] } },
  ])('富文本直接 @ 正常通过 %j', content => {
    expect(isBotDirectlyMentioned('app', message('post', content, [mention]))).toBe(true);
  });
});

describe('按机器人设置与即时回读', () => {
  it('未设置沿用旧行为，并发写入保留其它机器人，修改下一次读取生效', async () => {
    expect(requiresDirectGroupMention('app')).toBe(false);
    await Promise.all([setDirectGroupMention('app', true), setDirectGroupMention('other', false)]);
    expect(requiresDirectGroupMention('app')).toBe(true);
    expect(requiresDirectGroupMention('other')).toBe(false);
    expect(JSON.parse(readFileSync(join(state.dataDir, 'group-direct-mention-policy.json'), 'utf8')))
      .toEqual({ app: true, other: false });
    await setDirectGroupMention('app', false);
    expect(requiresDirectGroupMention('app')).toBe(false);
  });

  it.each(['{broken', '[]', '{"app":"false"}', 'null'])('损坏时收紧入口且拒绝覆盖 %s', async raw => {
    const path = join(state.dataDir, 'group-direct-mention-policy.json');
    writeFileSync(path, raw);
    expect(requiresDirectGroupMention('app')).toBe(true);
    await expect(setDirectGroupMention('app', false)).rejects.toThrow();
    expect(readFileSync(path, 'utf8')).toBe(raw);
  });
});
