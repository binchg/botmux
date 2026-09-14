/** 回归脱敏后的文本、富文本链接、卡片按钮和安全的技术链接。 */
import { describe, expect, it } from 'vitest';
import { redactOutboundContent, redactOutboundText } from '../src/im/lark/outbound-redaction.js';

describe('出站正文自动脱敏', () => {
  it('邮箱、手机号、证件尾号和明确标注的姓名均从原文副本移除', () => {
    const original = '联系 test.person@example.invalid，+86 138 0013 8000，1234 身份证尾号，姓 a 名 a，姓名：张三';
    const text = redactOutboundText(original);
    for (const value of ['test.person', 'example.invalid', '138', '1234', '姓 a', '张三']) expect(text).not.toContain(value);
    expect(original).toContain('test.person@example.invalid');
    expect(redactOutboundText(text)).toBe(text);
  });

  it('Markdown 邮件和编码链接不会在隐藏的 href 中留下资料', () => {
    const text = redactOutboundText('[联系](mailto:test%2Eperson%40example.invalid) https://example.invalid/?email=test%2540example.invalid');
    expect(text).not.toContain('mailto:');
    expect(text).not.toContain('test');
    expect(text).not.toContain('http');
  });

  it('正文、表格、凭据字段和敏感按钮均被处理，二维码与安全链接保留', () => {
    const content = JSON.stringify({ header: { title: { content: '结果' } },
      elements: [{ tag: 'markdown', content: '邮箱 test.person@example.invalid' }, { tag: 'img', img_key: 'qr-image' },
        { tag: 'action', actions: [{ tag: 'button', url: 'mailto:test.person@example.invalid' }] }],
      details: { email: 'private', password: 'hidden-secret' },
      safe: '[BITS 123](https://bits.bytedance.net/x/123)' });
    const safe = redactOutboundContent(content);
    for (const value of ['test.person', 'hidden-secret', 'mailto:']) expect(safe).not.toContain(value);
    expect(safe).toContain('qr-image');
    expect(safe).toContain('https://bits.bytedance.net/x/123');
    expect(JSON.parse(safe).elements).toHaveLength(2);
  });

  it('普通编号、时间、UUID 和源码链接保持原样', () => {
    const text = 'BITS 230028，日期 2026-09-18，de39b1dcf646169aa8de5aab0164483d95e6088b https://github.com/example/repo';
    expect(redactOutboundText(text)).toBe(text);
  });
});
