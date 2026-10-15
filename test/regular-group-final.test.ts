import { beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ config: { regularGroupFinalToChat: true },
  mode: vi.fn(async () => 'group'), reply: vi.fn(async () => 'om_thread'), send: vi.fn(async () => 'om_chat') }));
vi.mock('../src/bot-registry.js', () => ({ getBot: () => ({ config: mocks.config }) }));
vi.mock('../src/im/lark/client.js', () => ({ getChatMode: mocks.mode, replyMessage: mocks.reply, sendMessage: mocks.send }));
import { deliverRegularGroupFinal } from '../src/services/regular-group-final.js';
import type { DaemonSession } from '../src/core/types.js';

function session(): DaemonSession {
  return { scope: 'chat', chatId: 'oc_group', larkAppId: 'app',
    session: { sessionId: 's', replyTargetsByTurn: { t: 'om_root' } } } as unknown as DaemonSession;
}

describe('最终结果双位置交付', () => {
  beforeEach(() => { vi.clearAllMocks(); mocks.config.regularGroupFinalToChat = true; mocks.mode.mockResolvedValue('group'); });
  it('先在话题回复，再向群同步，且各自使用不同 UUID', async () => {
    expect(await deliverRegularGroupFinal(session(), 't', 'card')).toBe(true);
    expect(mocks.reply.mock.calls[0].slice(0, 5)).toEqual(['app', 'om_root', 'card', 'interactive', true]);
    expect(mocks.send.mock.calls[0].slice(0, 4)).toEqual(['app', 'oc_group', 'card', 'interactive']);
    expect(mocks.reply.mock.invocationCallOrder[0]).toBeLessThan(mocks.send.mock.invocationCallOrder[0]);
    expect(mocks.reply.mock.calls[0][5]).not.toBe(mocks.send.mock.calls[0][4]);
  });
  it('群同步失败重试复用两边 UUID，避免重复话题结果', async () => {
    mocks.send.mockRejectedValueOnce(new Error('retry'));
    const ds = session();
    await expect(deliverRegularGroupFinal(ds, 't', 'card')).rejects.toThrow('retry');
    await deliverRegularGroupFinal(ds, 't', 'card');
    expect(mocks.reply.mock.calls[0][5]).toBe(mocks.reply.mock.calls[1][5]);
    expect(mocks.send.mock.calls[0][4]).toBe(mocks.send.mock.calls[1][4]);
    expect(ds.outboundReplies?.size).toBe(0);
  });
  it('话题投递失败不得先广播结果', async () => {
    mocks.reply.mockRejectedValueOnce(new Error('blocked'));
    await expect(deliverRegularGroupFinal(session(), 't', 'card')).rejects.toThrow('blocked');
    expect(mocks.send).not.toHaveBeenCalled();
  });
  it('关闭配置、私聊或未知轮次沿用既有路径', async () => {
    mocks.config.regularGroupFinalToChat = false;
    expect(await deliverRegularGroupFinal(session(), 't', 'card')).toBe(false);
    mocks.config.regularGroupFinalToChat = true;
    mocks.mode.mockResolvedValue('p2p');
    expect(await deliverRegularGroupFinal(session(), 't', 'card')).toBe(false);
    expect(await deliverRegularGroupFinal(session(), 'unknown', 'card')).toBe(false);
    expect(mocks.reply).not.toHaveBeenCalled();
    expect(mocks.send).not.toHaveBeenCalled();
  });
});
