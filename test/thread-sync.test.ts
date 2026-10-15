import { describe, expect, it, vi } from 'vitest';
import { canonicalThreadMessage, repairThreadReply, syncedMessageKey } from '../src/im/lark/thread-sync.js';

const original = { message_id: 'om_source', chat_id: 'oc_group', root_id: 'om_root', thread_id: 'omt_topic',
  sync_to_chat_info: { type: 2, related_message_id: 'om_mirror' } };
const mirror = { message_id: 'om_mirror', chat_id: 'oc_group',
  sync_to_chat_info: { type: 1, related_message_id: 'om_source', thread_id: 'omt_topic' } };
const read = async (id: string) => ({ items: [id === 'om_mirror' ? mirror : original] });

describe('普通群同步副本', () => {
  it('群副本先到或话题原消息先到都归为同一个身份和根消息', async () => {
    const a = await canonicalThreadMessage({ ...mirror, sync_to_chat_info: undefined, content: 'same' }, read);
    const b = await canonicalThreadMessage({ ...original, sync_to_chat_info: undefined }, read);
    expect(a.message_id).toBe('om_source');
    expect(a.root_id).toBe('om_root');
    expect(a.thread_id).toBe('omt_topic');
    expect(a.content).toBe('same');
    expect(syncedMessageKey(a)).toBe(syncedMessageKey(b));
  });

  it('正文相同但无关联的消息仍是两个独立输入', async () => {
    for (const id of ['om_a', 'om_b']) {
      const result = await canonicalThreadMessage({ message_id: id }, async () => ({ items: [] }));
      expect(result.message_id).toBe(id);
      expect(syncedMessageKey(result)).toBeUndefined();
    }
  });

  it('普通查询失败保留消息；关联回读失败仍锚定原消息，不在副本建话题', async () => {
    const fail = vi.fn().mockRejectedValue(new Error('offline'));
    expect(await canonicalThreadMessage({ message_id: 'om_plain' }, fail)).toEqual({ message_id: 'om_plain' });
    const result = await canonicalThreadMessage(mirror, fail);
    expect(result.root_id).toBe('om_source');
    expect(result.thread_id).toBe('omt_topic');
  });

  it('拒绝跨群关联，不能把正文转到其它会话', async () => {
    await expect(canonicalThreadMessage(mirror, async () => ({ items: [{ ...original, chat_id: 'oc_other' }] })))
      .rejects.toThrow('different chat');
  });

  it('补发修复仅更正话题目标，保留正文、UUID 和队列身份', async () => {
    const request = { url: '/open-apis/im/v1/messages/om_mirror/reply',
      data: { reply_in_thread: true, uuid: 'stable-id', content: 'result' }, __botmuxOutboxId: 'queue-id' };
    await repairThreadReply(request, read);
    expect(request).toEqual({ ...request, url: '/open-apis/im/v1/messages/om_root/reply' });
    expect(request.data).toEqual({ reply_in_thread: true, uuid: 'stable-id', content: 'result' });
    expect(request.__botmuxOutboxId).toBe('queue-id');
    const plain = { url: '/open-apis/im/v1/messages/om_mirror/reply', data: { reply_in_thread: false } };
    await repairThreadReply(plain, read);
    expect(plain.url).toContain('om_mirror');
  });
});
