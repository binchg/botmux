import { describe, expect, it } from 'vitest';
import {
  BITS_MR_DETAIL_BASE_URL,
  enrichOutboundMarkdownLinks,
} from '../src/services/outbound-link-enrichment.js';

const link = (label: string, id: string) => `[${label}](${BITS_MR_DETAIL_BASE_URL}/${id})`;

describe('enrichOutboundMarkdownLinks', () => {
  it('linkifies the production BITS readback wording', () => {
    expect(enrichOutboundMarkdownLinks(
      'BITS 已创建并回读：8377427，Optimize、source 指向本次分支、target=alpha。',
    )).toBe(
      `${link('BITS 已创建并回读：8377427', '8377427')}，Optimize、source 指向本次分支、target=alpha。`,
    );
  });

  it('supports compact BITS MR forms and multiple references', () => {
    expect(enrichOutboundMarkdownLinks('BITS-8377427；BITS MR：8377428')).toBe(
      `${link('BITS-8377427', '8377427')}；${link('BITS MR：8377428', '8377428')}`,
    );
  });

  it('renders the complete references from a delivery summary as clickable labels', () => {
    const markdown = [
      '两条 URL 都已落地并绑定同一 final SHA 6084cdce：',
      '- 合入 merge_alpha：BITS 8386078',
      '- 指向 base_alpha 复测：BITS 8386087',
    ].join('\n');
    expect(enrichOutboundMarkdownLinks(markdown)).toBe([
      '两条 URL 都已落地并绑定同一 final SHA 6084cdce：',
      `- 合入 merge_alpha：${link('BITS 8386078', '8386078')}`,
      `- 指向 base_alpha 复测：${link('BITS 8386087', '8386087')}`,
    ].join('\n'));
  });

  it('is idempotent and preserves existing Markdown links and raw URLs', () => {
    const markdown = `BITS MR：[8377427](${BITS_MR_DETAIL_BASE_URL}/8377427)\nBITS URL：https://bits.bytedance.net/bytebus/devops/code/detail/8377428`;
    expect(enrichOutboundMarkdownLinks(markdown)).toBe(markdown);
    expect(enrichOutboundMarkdownLinks(enrichOutboundMarkdownLinks(markdown))).toBe(markdown);
  });

  it('does not rewrite inline code, fenced code or indented code', () => {
    const markdown = [
      '`BITS 8377427`',
      '```text',
      'BITS 已创建：8377428',
      '```',
      '    BITS 8377429',
    ].join('\n');
    expect(enrichOutboundMarkdownLinks(markdown)).toBe(markdown);
  });

  it('does not guess from unrelated ticket numbers without BITS context', () => {
    const markdown = 'Meego 7356167104，commit 8377427，版本 8377428。';
    expect(enrichOutboundMarkdownLinks(markdown)).toBe(markdown);
  });
});
