/** 覆盖普通群用户补发、手动同步、身份漂移与重复推送；不以正文相同作为去重依据。 */
import { describe, expect, it, vi } from 'vitest';
import { mirrorThreadUserMessage, type MirrorInput, type MirrorPort, type MirrorSource } from '../src/im/lark/thread-user-mirror.js';

const source: MirrorSource = { message_id: 'om_user', chat_id: 'oc_group', root_id: 'om_root',
  thread_id: 'omt_thread', chat_type: 'group', sender: { id: 'ou_user', id_type: 'open_id', sender_type: 'user' } };
const input: MirrorInput = { enabled: true, ownsSession: true, senderType: 'user', senderOpenId: 'ou_user', message: source };

/** 使用可观察端口验证真正外部写入次数及准确消息身份。 */
function portFor(detail: MirrorSource | undefined = source): MirrorPort {
  const claims = new Set<string>();
  return { chatMode: vi.fn().mockResolvedValue('group'), read: vi.fn().mockResolvedValue(detail),
    claim: vi.fn((key: string) => { if (claims.has(key)) return false; claims.add(key); return true; }),
    forward: vi.fn().mockResolvedValue('om_forwarded'), record: vi.fn() };
}

describe('普通群用户话题消息自动补发', () => {
  it('只将已核验的原消息交给发送端，准确原群和去重键保持不变', async () => {
    const port = portFor();
    expect(await mirrorThreadUserMessage(input, port)).toBe('sent');
    expect(port.forward).toHaveBeenCalledWith('om_user', 'oc_group', expect.stringMatching(/^[0-9a-f]{32}$/), source);
    expect(port.record).toHaveBeenCalledWith(expect.any(String), 'sent', 'om_forwarded');
  });

  it.each([
    { enabled: false }, { ownsSession: false }, { senderType: 'app' }, { senderType: 'bot' },
    { message: { ...source, chat_type: 'p2p' } }, { message: { ...source, thread_id: undefined } },
    { message: { ...source, root_id: source.message_id } },
  ])('未授权、非会话追加和机器人消息均不触发平台查询或补发：%j', async override => {
    const port = portFor();
    expect(await mirrorThreadUserMessage({ ...input, ...override }, port)).toBe('ineligible');
    expect(port.read).not.toHaveBeenCalled();
    expect(port.forward).not.toHaveBeenCalled();
  });

  it.each(['topic', 'p2p', 'unknown'])('仅确认普通群才发送，群类型为 %s 时关闭', async mode => {
    const port = portFor();
    vi.mocked(port.chatMode).mockResolvedValue(mode);
    expect(await mirrorThreadUserMessage(input, port)).toBe('not-regular-group');
    expect(port.forward).not.toHaveBeenCalled();
  });

  it.each([1, 2])('手动同步的原消息或群副本先到均不补发，类型 %i', async type => {
    const port = portFor();
    const message = { ...source, sync_to_chat_info: { type, related_message_id: 'om_paired' } };
    expect(await mirrorThreadUserMessage({ ...input, message }, port)).toBe('ineligible');
    expect(port.forward).not.toHaveBeenCalled();
  });

  it('事件未带关联信息时，发送前回读发现手动群副本也跳过', async () => {
    const port = portFor({ ...source, sync_to_chat_info: { type: 2, related_message_id: 'om_paired' } });
    expect(await mirrorThreadUserMessage(input, port)).toBe('already-synced');
    expect(port.claim).not.toHaveBeenCalled();
  });

  it.each([
    undefined, { ...source, chat_id: 'oc_other' }, { ...source, thread_id: 'omt_other' },
    { ...source, deleted: true }, { ...source, sender: { ...source.sender, id: 'ou_other' } },
    { ...source, sender: { ...source.sender, sender_type: 'app' } },
  ])('回读缺失、身份漂移或机器人转发回声不会再次转发：%j', async detail => {
    const port = portFor();
    vi.mocked(port.read).mockResolvedValue(detail);
    expect(await mirrorThreadUserMessage(input, port)).toBe('unverified');
    expect(port.forward).not.toHaveBeenCalled();
  });

  it('并发重推仅转发一次，第二条相同正文但不同身份的消息仍会转发', async () => {
    const port = portFor();
    const results = await Promise.all([mirrorThreadUserMessage(input, port), mirrorThreadUserMessage(input, port)]);
    expect(results.sort()).toEqual(['duplicate', 'sent']);
    expect(port.forward).toHaveBeenCalledTimes(1);
    const second = { ...source, message_id: 'om_second' };
    vi.mocked(port.read).mockResolvedValue(second);
    expect(await mirrorThreadUserMessage({ ...input, message: second }, port)).toBe('sent');
    expect(port.forward).toHaveBeenCalledTimes(2);
  });

  it('网络结果不明后保留认领，重推不会形成重复副本或死循环', async () => {
    const port = portFor();
    vi.mocked(port.forward).mockRejectedValue(new Error('timeout'));
    await expect(mirrorThreadUserMessage(input, port)).rejects.toThrow('timeout');
    expect(await mirrorThreadUserMessage(input, port)).toBe('duplicate');
    expect(port.forward).toHaveBeenCalledTimes(1);
    expect(port.record).toHaveBeenCalledWith(expect.any(String), 'failed');
  });

  it('持久认领失败时不发送，避免重启后丢失去重状态', async () => {
    const port = portFor();
    vi.mocked(port.claim).mockImplementation(() => { throw new Error('disk full'); });
    await expect(mirrorThreadUserMessage(input, port)).rejects.toThrow('disk full');
    expect(port.forward).not.toHaveBeenCalled();
  });
});
