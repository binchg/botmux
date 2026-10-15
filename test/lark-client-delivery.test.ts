/** SDK 鉴权失败也必须保存回复，同时保持原输入和业务调用契约。 */
import { describe, expect, it, vi } from 'vitest';
import { protectLarkClientDelivery } from '../src/services/lark-client-delivery.js';

describe('SDK 发送前失败保护', () => {
  it('真实发送入口修复群副本锚点，队列与 SDK 使用相同目标及 UUID', async () => {
    const reply = vi.fn().mockResolvedValue({ code: 0, data: { message_id: 'om_delivered' } });
    const get = vi.fn(async ({ path }: any) => ({ code: 0, data: { items: [path.message_id === 'om_mirror'
      ? { message_id: 'om_mirror', chat_id: 'oc_one', sync_to_chat_info: { type: 1, related_message_id: 'om_source' } }
      : { message_id: 'om_source', chat_id: 'oc_one', root_id: 'om_root' }] } }));
    const client = { im: { v1: { message: { reply, get } } } };
    const queue = { prepare: vi.fn(), failed: vi.fn(), accepted: vi.fn() };
    protectLarkClientDelivery(client, queue as any);
    await client.im.v1.message.reply({ path: { message_id: 'om_mirror' },
      data: { msg_type: 'text', content: '{"text":"结果"}', reply_in_thread: true, uuid: 'stable' } });
    expect(reply.mock.calls[0][0].path.message_id).toBe('om_root');
    expect(reply.mock.calls[0][0].data.uuid).toBe('stable');
    expect(queue.prepare.mock.calls[0][0].url).toContain('/om_root/reply');
    expect(queue.failed).not.toHaveBeenCalled();
  });

  it('鉴权失败保存脱敏内容，原输入不变，并保留失败终态', async () => {
    const failure = Object.assign(new Error('token lookup failed'), { config: { url: '/auth/token' } });
    const client = { im: { v1: { message: { reply: vi.fn().mockRejectedValue(failure) } } } };
    const queue = { prepare: vi.fn(), failed: vi.fn(), accepted: vi.fn() };
    protectLarkClientDelivery(client, queue as any);
    const input = { path: { message_id: 'parent' }, data: { msg_type: 'text', content: '{"text":"test.person@example.invalid"}' } };
    await expect(client.im.v1.message.reply(input)).rejects.toBe(failure);
    expect(queue.failed.mock.calls[0][0].data.content).not.toContain('test.person');
    expect(queue.failed.mock.calls[0][1].__botmuxNotSent).toBe(true);
    expect(input.data.content).toContain('test.person');
    expect(queue.accepted).not.toHaveBeenCalled();
  });

  it('HTTP 层已保存固定提示时，不用原卡片二次覆盖', async () => {
    const failure = Object.assign(new Error('queued'), { __botmuxQueued: true });
    const client = { im: { v1: { message: { create: vi.fn().mockRejectedValue(failure) } } } };
    const queue = { prepare: vi.fn(), failed: vi.fn(), accepted: vi.fn() };
    protectLarkClientDelivery(client, queue as any);
    await expect(client.im.v1.message.create({ data: { msg_type: 'text', content: '{"text":"result"}' } })).rejects.toBe(failure);
    expect(queue.failed).not.toHaveBeenCalled();
  });
});
