import { describe, it, expect, vi } from 'vitest';
import { readFileSync, copyFileSync } from 'node:fs';
import { mathBlocks, renderMathBlockImages } from '../src/services/outbound-math.js';

describe('outbound mathematical rich text', () => {
  it('recognizes all four math delimiters, lists, tables and display equations', () => {
    for (const source of [String.raw`源 $M_B$`, String.raw`源 \(M_B\)`, String.raw`$$\sum_i x_i$$`, String.raw`\[\frac{a}{b}\]`, '- 源 $M_B$', '| 项 | 值 |\n|---|---|\n| 聚合 | $x_i$ |']) {
      const blocks = mathBlocks(source);
      expect(blocks).toHaveLength(1);
      expect(blocks[0].html).toContain('class="katex');
    }
    expect(mathBlocks('$$\n\\sum_i x_i\n$$')[0].html).toContain('katex-display');
  });
  it('leaves code, currency, escaped dollars, and incomplete or invalid TeX intact', () => {
    for (const source of ['`$x_i$`', '```tex\n$x_i$\n```', '    $x_i$', '$20 and $30', String.raw`\$20`, '$x_i', String.raw`$\notARealCommand{x}$`]) {
      expect(mathBlocks(source)).toEqual([]);
    }
    expect(mathBlocks('before\n\n`$code$`\n\n$x_i$')).toHaveLength(1);
  });
  it('escapes model HTML and never enables trusted KaTeX commands', () => {
    const html = mathBlocks('<script>alert(1)</script> $x_i$')[0].html;
    expect(html).toContain('&lt;script&gt;');
    expect(html).not.toContain('<script>');
  });
  it('preserves ordinary text without launching or uploading', async () => {
    const upload = vi.fn();
    expect(await renderMathBlockImages('hello `world`', upload)).toBe('hello `world`');
    expect(upload).not.toHaveBeenCalled();
  });
  it('renders a real high-resolution PNG and falls back on failed uploads', async () => {
    const source = '# Source cluster attention 聚合\n\n源簇将 RWG 系数聚合为 $M_B=\\sum_i x_i f_i$。\n\n[文档](https://example.com)';
    const upload = vi.fn(async (path: string) => {
      const bytes = readFileSync(path);
      expect(bytes.subarray(1, 4).toString()).toBe('PNG');
      expect(bytes.readUInt32BE(16)).toBeGreaterThan(1000);
      if (process.env.BOTMUX_MATH_PREVIEW) copyFileSync(path, process.env.BOTMUX_MATH_PREVIEW);
      return 'img_v3_math_test';
    });
    const rendered = await renderMathBlockImages(source, upload);
    expect(upload).toHaveBeenCalledOnce();
    expect(rendered).toContain('![公式排版](img_v3_math_test)');
    expect(rendered).toContain('[文档](https://example.com)');
    expect(rendered).toContain('# Source cluster attention 聚合');
    expect(await renderMathBlockImages(source, async () => { throw new Error('offline'); })).toBe(source);
  }, 30000);
});
