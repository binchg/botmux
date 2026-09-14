/** 使用真实 SDK 请求链验证脱敏、断网、降级及持久补发的组合行为。 */
import { afterEach, describe, expect, it } from 'vitest';
import { defaultHttpInstance } from '@larksuiteoapi/node-sdk';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LarkReplyOutbox } from '../src/services/lark-reply-outbox.js';
import { installLarkOutboundPrivacy } from '../src/im/lark/outbound-privacy.js';

const folders: string[] = [];
afterEach(() => { for (const folder of folders.splice(0)) rmSync(folder, { recursive: true, force: true }); });

/** 每例使用独立 HTTP 实例、真实磁盘队列和注入的网络终态。 */
function fixture(failures: any[] = []) {
  const folder = mkdtempSync(join(tmpdir(), 'lark-delivery-'));
  folders.push(folder);
  const packets: any[] = [];
  const http = defaultHttpInstance.create();
  http.interceptors.response.use(response => response.data);
  let now = 100000;
  http.defaults.adapter = async (config: any) => {
    packets.push({ ...config, data: JSON.parse(config.data) });
    const failure = failures.shift();
    if (failure) throw Object.assign(new Error('simulated transport failure'), failure, { config });
    return { data: { code: 0, data: { message_id: 'real-receipt' } }, status: 200, statusText: 'OK', headers: {}, config };
  };
  const queue = new LarkReplyOutbox(folder, request => http.request({ ...request,
    headers: { Authorization: 'Bearer refreshed-token' } }), () => now);
  installLarkOutboundPrivacy(http, queue);
  const send = (text = '结果：test.person@example.invalid，13800138000') => http.request({
    method: 'POST', url: 'https://open.feishu.cn/open-apis/im/v1/messages/root/reply',
    data: { msg_type: 'interactive', content: JSON.stringify({
      header: { title: { tag: 'plain_text', content: '结果' } },
      elements: [{ tag: 'markdown', content: text }],
    }), reply_in_thread: true }, headers: { Authorization: 'Bearer original-token' },
  });
  return { queue, folder, packets, send, advance: (ms: number) => { now += ms; } };
}

describe('实际发送链路组合回归', () => {
  it('发送前完成正文脱敏，正常消息以真实回执完成', async () => {
    const { send, packets, queue } = fixture();
    expect(await send()).toMatchObject({ code: 0, data: { message_id: 'real-receipt' } });
    expect(packets[0].data.content).not.toContain('test.person');
    expect(packets[0].data.content).not.toContain('13800138000');
    expect(packets[0].timeout).toBe(10000);
    expect(queue.status().pending).toBe(0);
  });

  it('断网后返回失败并持久化，其它回复继续；恢复时使用新凭据和原 UUID', async () => {
    const { send, packets, queue, folder, advance } = fixture([{ code: 'ECONNREFUSED' }]);
    await expect(send()).rejects.toThrow();
    expect(queue.status().pending).toBe(1);
    const stored = readFileSync(join(folder, readdirSync(folder)[0]), 'utf8');
    expect(stored).not.toContain('original-token');
    expect(stored).not.toContain('test.person');
    expect(await send('下一条任务进度')).toMatchObject({ code: 0 });
    advance(60000);
    await queue.drain();
    expect(packets).toHaveLength(3);
    expect(packets[2].data.uuid).toBe(packets[0].data.uuid);
    expect(packets[2].headers.Authorization).toBe('Bearer refreshed-token');
    expect(queue.status().pending).toBe(0);
  });

  it('格式失败降为文本，内容审核失败只发说明；网络再失败只保存该说明', async () => {
    const { send, packets, queue, folder, advance } = fixture([
      { response: { status: 400, data: { code: 230099, msg: 'invalid card schema' } } },
      { response: { status: 400, data: { code: 230028, msg: 'audit rejected' } } },
      { code: 'ECONNREFUSED' },
    ]);
    await expect(send()).rejects.toThrow();
    expect(packets).toHaveLength(3);
    expect(packets[1].data.msg_type).toBe('text');
    expect(packets[1].data.content).toContain('结果：');
    expect(packets[2].data.content).toContain('原回复未送达');
    const stored = readFileSync(join(folder, readdirSync(folder)[0]), 'utf8');
    expect(stored).toContain('原回复未送达');
    expect(stored).not.toContain('结果：');
    advance(60000);
    await queue.drain();
    expect(packets).toHaveLength(4);
    expect(packets[3].data.content).toContain('原回复未送达');
    expect(queue.status().pending).toBe(0);
  });
});
