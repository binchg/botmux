import { describe, it, expect, vi } from 'vitest';
import { formatMathForLark, mathToText } from '../src/services/outbound-math.js';
import { resolveOutboundLocalImages } from '../src/services/outbound-local-images.js';
import { buildMarkdownCard } from '../src/im/lark/md-card.js';

describe('copyable mathematical rich text', () => {
  it('renders all delimiters as text, with display math in copyable code blocks', () => {
    for (const source of [String.raw`源 $M_B$`, String.raw`源 \(M_B\)`]) {
      expect(formatMathForLark(source)).toBe('源 ` M_B `');
    }
    expect(formatMathForLark('$$\n\\sum_i x_i\n$$')).toBe('```text\n∑_i x_i\n```');
    expect(formatMathForLark(String.raw`\[\frac{a+b}{c}\]`)).toBe('```text\n(a + b)/(c)\n```');
    expect(formatMathForLark(String.raw`结果 $$x_i$$。`)).toBe('结果 ` x_i `。');
  });
  it('preserves fraction grouping, bounds, roots, greek letters, and matrix rows', () => {
    expect(mathToText(String.raw`\frac{a+b}{c+d}`)).toBe('(a + b)/(c + d)');
    expect(mathToText(String.raw`\sum_{j\in B}^{N} a_j x_j`)).toBe('∑_(j ∈ B)^N a_j x_j');
    expect(mathToText(String.raw`\sqrt{x+1}+\alpha`)).toBe('√(x + 1) + α');
    expect(mathToText(String.raw`\begin{pmatrix}a&b\\c&d\end{pmatrix}`)).toContain('[a, b; c, d]');
    expect(mathToText(String.raw`\frac{x}{y}^2`)).toBe('((x)/(y))^2');
    expect(mathToText(String.raw`{a+b}^2`)).toBe('(a + b)^2');
    expect(mathToText(String.raw`\mathbf{J}`)).toBe('𝐉');
    expect(mathToText(String.raw`L_T^{direct}`)).toBe('L_T^(direct)');
    expect(mathToText(String.raw`Z_{ij}`)).toBe('Z_(ij)');
  });
  it('protects fenced and indented code, variable-length inline code, currency and escaped dollars', () => {
    for (const source of ['`$x_i$`', '`` `$x$` ``', '```tex\n$x_i$\n```', '~~~tex\n\\[x\\]\n~~~', '    $x_i$', '$20 and $30', String.raw`\$20`, '$x_i', 'hello `world`']) {
      expect(formatMathForLark(source)).toBe(source);
    }
    expect(formatMathForLark('`$code$`\n\n$x_i$')).toBe('`$code$`\n\n` x_i `');
    for (const source of ['[download](./$a$/file)', 'https://example.com/$a$/file', '[link](https://example.com/$a$)']) expect(formatMathForLark(source)).toBe(source);
  });
  it('preserves surrounding prose, bold, links, lists and native tables', () => {
    const source = '**源** $M_B$ [文档](https://example.com)\n\n- 目标 $x_i$\n\n| 项 | 值 |\n|---|---|\n| 聚合 | $x_i$ |';
    const text = formatMathForLark(source);
    expect(text).toContain('**源** ` M_B ` [文档](https://example.com)');
    expect(text).toContain('- 目标 ` x_i `');
    const card = JSON.parse(buildMarkdownCard(text));
    expect(card.body.elements.some((e: any) => e.tag === 'table')).toBe(true);
    expect(JSON.stringify(card)).not.toContain('img_v');
  });
  it('keeps invalid TeX readable and copyable rather than discarding it', () => {
    expect(formatMathForLark(String.raw`结果 $\notARealCommand{x}$。`)).toBe('结果 ` \\notARealCommand{x} `。');
    const dangerous = formatMathForLark(String.raw`$\text{<script>alert(1)</script>}$`);
    expect(dangerous).toContain('` <script>alert(1)</script> `');
    expect(formatMathForLark(dangerous)).toBe(dangerous);
    expect(formatMathForLark(String.raw`$\hat{x}$`)).toBe('` \\hat{x} `');
    expect(formatMathForLark(String.raw`$\underbrace{x}_{\text{source}}$`)).toBe('` \\underbrace{x}_{\\text{source}} `');
  });
  it('does not upload formula images and still supports explicit user images', async () => {
    const upload = vi.fn();
    const result = await resolveOutboundLocalImages('源 $M_B$，权重 $\\alpha_i$。', { roots: [], upload });
    expect(result.content).toContain('` M_B `');
    expect(result.content).toContain('α_i');
    expect(result.imageKeys).toEqual([]);
    expect(result.discovered).toBe(0);
    expect(upload).not.toHaveBeenCalled();
  });
});
