/** 持久队列的断网恢复、幂等、收据和不确定结果边界。 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LarkReplyOutbox } from '../src/services/lark-reply-outbox.js';

const folders: string[] = [];
afterEach(() => { for (const folder of folders.splice(0)) rmSync(folder, { recursive: true, force: true }); });
/** 每个测试独立磁盘目录与可控时钟，不启动真实网络或定时任务。 */
function setup(send = vi.fn().mockResolvedValue({ code: 0, data: { message_id: 'receipt' } })) {
  const folder = mkdtempSync(join(tmpdir(), 'lark-replies-'));
  folders.push(folder);
  let now = 100000;
  const queue = new LarkReplyOutbox(folder, send, () => now);
  const request: any = { method: 'POST', url: 'https://open.feishu.cn/open-apis/im/v1/messages/root/reply',
    data: { msg_type: 'text', content: '{"text":"资料已隐藏"}', reply_in_thread: true },
    headers: { Authorization: 'secret-token', Cookie: 'private-cookie' } };
  return { queue, folder, send, request, advance: (ms: number) => { now += ms; }, now: () => now };
}

describe('独立回复补发队列', () => {
  it('断网保存后重建实例能恢复，文件中不含请求凭据', async () => {
    const { queue, folder, send, request, advance, now } = setup();
    queue.prepare(request);
    queue.failed(request, { code: 'ECONNREFUSED' });
    const path = join(folder, readdirSync(folder)[0]);
    const stored = readFileSync(path, 'utf8');
    expect(stored).not.toContain('secret-token');
    expect(stored).not.toContain('private-cookie');
    expect(statSync(path).mode & 0o777).toBe(0o600);
    const resumed = new LarkReplyOutbox(folder, send, now);
    await resumed.drain();
    expect(send).not.toHaveBeenCalled();
    advance(60000);
    await resumed.drain();
    expect(send).toHaveBeenCalledOnce();
    expect(send.mock.calls[0][0].data.uuid).toBe(request.data.uuid);
    expect(send.mock.calls[0][0].data.reply_in_thread).toBe(true);
    expect(resumed.status().pending).toBe(0);
    expect(readdirSync(folder)).toHaveLength(0);
  });

  it('没有实际收据仍然保留，失败不会抛出或取消其它后台工作', async () => {
    const { queue, send, request, advance } = setup(vi.fn().mockResolvedValue({ code: 0 }));
    queue.prepare(request);
    queue.failed(request, { code: 'ECONNREFUSED' });
    advance(60000);
    await expect(queue.drain()).resolves.toBeUndefined();
    expect(send).toHaveBeenCalledOnce();
    expect(queue.status().pending).toBe(1);
    await queue.drain();
    expect(send).toHaveBeenCalledOnce();
  });

  it('原发送方重试复用同一 UUID，成功回执会清除补发记录', () => {
    const { queue, request } = setup();
    queue.prepare(request);
    queue.failed(request, { code: 'ECONNREFUSED' });
    const retry = { ...request, data: { ...request.data, uuid: undefined } };
    queue.prepare(retry);
    expect(retry.data.uuid).toBe(request.data.uuid);
    queue.accepted(retry, { code: 0, data: { message_id: 'real-receipt' } });
    expect(queue.status().pending).toBe(0);
  });

  it('动态卡片只补发最新快照，终态回执清除旧更新', async () => {
    const { queue, request, advance, send } = setup();
    request.method = 'PATCH';
    request.url = 'https://open.feishu.cn/open-apis/im/v1/messages/card';
    request.data = { content: '{"text":"old"}' };
    queue.failed(request, { code: 'ECONNREFUSED' });
    request.data = { content: '{"text":"final"}' };
    queue.failed(request, { code: 'ECONNREFUSED' });
    expect(queue.status().pending).toBe(1);
    advance(120000);
    await queue.drain();
    expect(send.mock.calls[0][0].data.content).toContain('final');
  });

  it('单一 waiter 防止并发补发同一条记录', async () => {
    let resolve!: (value: any) => void;
    const { queue, request, advance, send } = setup(vi.fn(() => new Promise(done => { resolve = done; })));
    queue.failed(request, { code: 'ECONNREFUSED' });
    advance(60000);
    const first = queue.drain();
    await queue.drain();
    expect(send).toHaveBeenCalledOnce();
    resolve({ code: 0, data: { message_id: 'receipt' } });
    await first;
  });

  it('网络超时结果不明超过去重窗口后保存待核实，不盲目重复', async () => {
    const { queue, request, advance, send } = setup();
    queue.failed(request, { code: 'ETIMEDOUT' });
    advance(50 * 60000);
    await queue.drain();
    expect(send).not.toHaveBeenCalled();
    expect(queue.status().uncertain).toBe(1);
  });

  it('被撤回的目标不改投其它会话，记录保留待处理', async () => {
    const { queue, request, advance, send } = setup();
    queue.failed(request, { response: { data: { code: 230011 } } });
    advance(600000);
    await queue.drain();
    expect(send).not.toHaveBeenCalled();
    expect(queue.status().blocked).toBe(1);
  });
});
