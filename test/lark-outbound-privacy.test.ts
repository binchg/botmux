/** 用真实 SDK 传输拦截器回归隐私标题、审核拒绝与单次失败提示。 */
import { describe, expect, it } from 'vitest';
import { defaultHttpInstance } from '@larksuiteoapi/node-sdk';
import { installLarkOutboundPrivacy, privateCardContent } from '../src/im/lark/outbound-privacy.js';
import { buildSessionCard } from '../src/im/lark/card-builder.js';
import { buildTitledMarkdownCard } from '../src/im/lark/md-card.js';
import { codexAppProgressCardTitle } from '../src/services/codex-app-progress.js';

installLarkOutboundPrivacy();

/** 仅替换网络适配器；请求序列化、SDK 解包与隐私处理均执行真实代码。 */
async function request(content: string, failures: number[] = [], options: Record<string, any> = {}) {
  const calls: any[] = [];
  const result = defaultHttpInstance.request({
    method: 'POST', url: 'https://open.feishu.cn/open-apis/im/v1/messages/parent/reply',
    data: { msg_type: 'interactive', content, reply_in_thread: true, uuid: 'same-turn' },
    ...options,
    adapter: async (config: any) => {
      calls.push({ data: JSON.parse(config.data), url: config.url, headers: config.headers });
      const code = failures[calls.length - 1];
      if (code) throw Object.assign(new Error('request rejected'), {
        config, response: { status: 400, data: { code, msg: 'audit rejected' } },
      });
      const data = options.businessReject && calls.length === 1
        ? { code: 230028, msg: 'audit rejected' } : { code: 0, data: { message_id: 'delivered' } };
      return { data, status: 200,
        statusText: 'OK', headers: {}, config };
    },
  });
  return { result: await result.catch(error => error), calls };
}

describe('出站标题隐私', () => {
  it.each(['test.person@example.invalid', 'test.person@exa…', '13800138000', '身份证尾号 1234'])(
    '清除自动标题中的个人资料：%s', async (privateValue) => {
      const original = JSON.stringify({ header: { title: { tag: 'plain_text', content: `任务 ${privateValue}` } },
        elements: [{ tag: 'img', img_key: 'qr-image' }], actions: [{ url: 'https://example.invalid/ok' }] });
      const { calls } = await request(original);
      const card = JSON.parse(calls[0].data.content);
      expect(card.header.title.content).toBe('任务进度（个人资料已隐藏）');
      expect(card.elements).toEqual([{ tag: 'img', img_key: 'qr-image' }]);
      expect(card.actions).toEqual([{ url: 'https://example.invalid/ok' }]);
      expect(JSON.parse(original).header.title.content).toContain(privateValue);
    },
  );

  it('真实会话卡片及截断后的阶段标题均不泄露邮箱', async () => {
    const prompt = '继续，\napple 库存 自动下单 promax\ntest.person@example.invalid 邮箱';
    const cards = [
      buildSessionCard('session', 'root', 'https://example.invalid/terminal', prompt, 'codex'),
      buildTitledMarkdownCard({ title: codexAppProgressCardTitle(prompt), md: '资料已保存。' }),
    ];
    for (const content of cards) {
      const { calls } = await request(content);
      expect(JSON.parse(calls[0].data.content).header.title.content).not.toContain('@');
    }
  });

  it('正常卡片、正文和无关请求保持不变', async () => {
    const original = '{"header":{"title":{"content":"普通任务"}},"elements":[]}';
    expect(privateCardContent(original)).toBe(original);
    const { calls } = await request(original, [], { url: 'https://example.invalid/upload' });
    expect(calls[0].data.content).toBe(original);
    expect(privateCardContent('invalid JSON')).toBe('invalid JSON');
  });
});

describe('审核拒绝的可见结果', () => {
  it('400 / 230028 后只补发固定说明，保留线程和幂等键', async () => {
    const sensitive = JSON.stringify({ elements: [{ content: 'test.person@example.invalid' }] });
    const { result, calls } = await request(sensitive, [230028], { headers: { 'Content-Length': '999' } });
    expect(result).toMatchObject({ code: 0, data: { message_id: 'delivered' } });
    expect(calls).toHaveLength(2);
    expect(calls[1].data).toMatchObject({ reply_in_thread: true, uuid: 'same-turn', msg_type: 'interactive' });
    expect(calls[1].data.content).not.toContain('test.person');
    expect(calls[1].data.content).toContain('原回复未送达');
    expect(calls[1].headers['Content-Length']).toBeUndefined();
    expect(calls[1].url).toBe(calls[0].url);
  });

  it('失败说明也被拒时停止，不形成重发循环', async () => {
    const { result, calls } = await request('{}', [230028, 230028]);
    expect(result).toBeInstanceOf(Error);
    expect(calls).toHaveLength(2);
  });

  it('HTTP 200 携带业务审核拒绝时同样补发说明', async () => {
    const { result, calls } = await request('{}', [], { businessReject: true });
    expect(result).toMatchObject({ code: 0 });
    expect(calls).toHaveLength(2);
    expect(calls[1].data.content).toContain('原回复未送达');
  });

  it('权限、撤回等其它错误不伪装为隐私提示', async () => {
    const { result, calls } = await request('{}', [230011]);
    expect(result).toBeInstanceOf(Error);
    expect(calls).toHaveLength(1);
  });

  it('PATCH 和普通文本拒绝均使用兼容格式', async () => {
    const patch = await request('{}', [230028], { method: 'PATCH',
      url: 'https://open.feishu.cn/open-apis/im/v1/messages/card', data: { content: '{}' } });
    expect(patch.calls[1].data.msg_type).toBeUndefined();
    expect(JSON.parse(patch.calls[1].data.content).header.title.content).toBe('回复未送达');
    const text = await request('', [230028], { data: { msg_type: 'text', content: '{"text":"private"}' } });
    expect(JSON.parse(text.calls[1].data.content).text).toContain('原回复未送达');
  });

  it('重复安装不会注册重复的补发链路', async () => {
    installLarkOutboundPrivacy();
    const { calls } = await request('{}', [230028]);
    expect(calls).toHaveLength(2);
  });
});
