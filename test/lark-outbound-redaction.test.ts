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

  it.each([
    'ohos/release/6.7.6.33@6c0d8af6',
    'release/6.7.6@6c0d8af68fde1619f51ab2965cdbb4c7889be4c9',
    'refs/heads/ohos/release/6.7.6.33@6C0D8AF6',
    'refs/tags/v6.7.6@6c0d8af6',
  ])('版本分支与提交号不是邮箱：%s', (reference) => {
    const url = `https://code.byted.org/reading/demo/tree/${reference}`;
    const text = `分支 \`${reference}\`，来源 [${reference}](${url})`;
    expect(redactOutboundText(text)).toBe(text);
    const card = JSON.stringify({ elements: [{ tag: 'markdown', content: text }],
      actions: [{ tag: 'button', url }] });
    expect(redactOutboundContent(card)).toBe(card);
  });

  it.each([
    '6.7.6.33@example.invalid',
    '6.7.6.33@6c0d8af6',
    'ohos/release/6.7.6.33@6c0d8af6.example.invalid',
    'ohos/release/test.person@example.invalid',
    'ohos/release/6.7.6.33@6c0d8a',
    'ohos/release/6.7.6.33@6c0d8af6z',
    `ohos/release/6.7.6.33@${'a'.repeat(41)}`,
    'test.person@exa…',
  ])('仅技术格式例外，真实或不确定的邮箱仍隐藏：%s', (text) => {
    expect(redactOutboundText(text)).toContain('［邮箱已隐藏］');
    expect(redactOutboundText(text)).not.toContain('@');
  });

  it('同条消息里的技术引用不会放过旁边的邮箱或敏感字段', () => {
    const reference = 'ohos/release/6.7.6.33@6c0d8af6';
    const safe = redactOutboundText(`${reference} 联系 test.person@example.invalid`);
    expect(safe).toBe(`${reference} 联系 ［邮箱已隐藏］`);
    expect(redactOutboundText(`[联系](mailto:${reference})`)).not.toContain('mailto:');
    expect(redactOutboundText(`https://example.invalid/?email=${reference}`)).not.toContain('http');
    expect(JSON.parse(redactOutboundContent(JSON.stringify({ email: reference }))).email)
      .toBe('［个人资料已隐藏］');
  });

  it.each([
    '@bytedance-dev/xgit@latest', '@bytedance-dev/xbytecli@0.3.11',
    '@scope/tool', '@scope/tool@next', '@scope/tool@0.4.42-beta.1',
    '@scope/tool@^1.2.3', '@scope/tool@~1.2', '@scope/tool@1.2.3+build.4',
  ])('scoped npm 包引用不是邮箱：%s', (reference) => {
    const command = `npm i -g ${reference} --registry=https://bnpm.byted.org`;
    const text = `1. ${command}\n2. xgit init\n\n\`\`\`bash\n${command}\n\`\`\``;
    expect(redactOutboundText(text)).toBe(text);
    const url = `https://www.npmjs.com/package/${reference}`;
    const card = JSON.stringify({ elements: [{ tag: 'markdown', content: text }],
      actions: [{ tag: 'button', url }] });
    expect(redactOutboundContent(card)).toBe(card);
  });

  it.each([
    '@scope/test.person@example.invalid', '@scope/tool@latest.example.invalid',
    '@scope/tool@latest…', '@scope/tool@exa…', 'xgit@latest',
  ])('不确定的邮箱或截断引用不因 npm 例外泄露：%s', (text) => {
    expect(redactOutboundText(text)).toContain('［邮箱已隐藏］');
  });

  it('npm 命令旁的邮箱、邮件链接、敏感参数和结构化字段仍被隐藏', () => {
    const reference = '@bytedance-dev/xgit@latest';
    expect(redactOutboundText(`${reference} 联系 test.person@example.invalid`))
      .toBe(`${reference} 联系 ［邮箱已隐藏］`);
    expect(redactOutboundText(`\`\`\`bash\nnpm i ${reference}\n# test.person@example.invalid\n\`\`\``))
      .not.toContain('test.person');
    expect(redactOutboundText(`[联系](mailto:${reference})`)).not.toContain('mailto:');
    expect(redactOutboundText(`https://example.invalid/?email=${reference}`)).not.toContain('http');
    expect(JSON.parse(redactOutboundContent(JSON.stringify({ email: reference }))).email)
      .toBe('［个人资料已隐藏］');
  });
});
