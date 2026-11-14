import { describe, it, expect, vi } from 'vitest';
import { formatMathForLark, mathToText } from '../src/services/outbound-math.js';
import { resolveOutboundLocalImages } from '../src/services/outbound-local-images.js';
import { buildMarkdownCard } from '../src/im/lark/md-card.js';

describe('copyable mathematical rich text', () => {
  it('renders all delimiters as text, with display math in copyable code blocks', () => {
    for (const source of [String.raw`源 $M_B$`, String.raw`源 \(M_B\)`]) {
      expect(formatMathForLark(source)).toBe('源 ` M_B `');
    }
    expect(formatMathForLark('$$\n\\sum_i x_i\n$$')).toBe('```text\n∑ᵢ xᵢ\n```');
    expect(formatMathForLark(String.raw`\[\frac{a+b}{c}\]`)).toBe('```text\n(a + b)/(c)\n```');
    expect(formatMathForLark(String.raw`结果 $$x_i$$。`)).toBe('结果 ` xᵢ `。');
  });
  it('preserves fraction grouping, bounds, roots, greek letters, and matrix rows', () => {
    expect(mathToText(String.raw`\frac{a+b}{c+d}`)).toBe('(a + b)/(c + d)');
    expect(mathToText(String.raw`\sum_{j\in B}^{N} a_j x_j`)).toBe('∑_(j ∈ B)^N aⱼ xⱼ');
    expect(mathToText(String.raw`\sqrt{x+1}+\alpha`)).toBe('√(x + 1) + α');
    expect(mathToText(String.raw`\begin{pmatrix}a&b\\c&d\end{pmatrix}`)).toContain('[a, b; c, d]');
    expect(mathToText(String.raw`\frac{x}{y}^2`)).toBe('((x)/(y))²');
    expect(mathToText(String.raw`{a+b}^2`)).toBe('(a + b)²');
    expect(mathToText(String.raw`\mathbf{J}`)).toBe('𝐉');
    expect(mathToText(String.raw`L_T^{direct}`)).toBe('L_Tᵈⁱʳᵉᶜᵗ');
    expect(mathToText(String.raw`Z_{ij}`)).toBe('Zᵢⱼ');
  });
  it('protects fenced and indented code, variable-length inline code, currency and escaped dollars', () => {
    for (const source of ['`$x_i$`', '`` `$x$` ``', '```tex\n$x_i$\n```', '~~~tex\n\\[x\\]\n~~~', '    $x_i$', '$20 and $30', String.raw`\$20`, '$x_i', 'hello `world`']) {
      expect(formatMathForLark(source)).toBe(source);
    }
    expect(formatMathForLark('`$code$`\n\n$x_i$')).toBe('`$code$`\n\n` xᵢ `');
    for (const source of ['[download](./$a$/file)', 'https://example.com/$a$/file', '[link](https://example.com/$a$)']) expect(formatMathForLark(source)).toBe(source);
  });
  it('preserves surrounding prose, bold, links, lists and native tables', () => {
    const source = '**源** $M_B$ [文档](https://example.com)\n\n- 目标 $x_i$\n\n| 项 | 值 |\n|---|---|\n| 聚合 | $x_i$ |';
    const text = formatMathForLark(source);
    expect(text).toContain('**源** ` M_B ` [文档](https://example.com)');
    expect(text).toContain('- 目标 ` xᵢ `');
    const card = JSON.parse(buildMarkdownCard(text));
    expect(card.body.elements.some((e: any) => e.tag === 'table')).toBe(true);
    expect(JSON.stringify(card)).not.toContain('img_v');
  });
  it('keeps invalid TeX readable and copyable rather than discarding it', () => {
    expect(formatMathForLark(String.raw`结果 $\notARealCommand{x}$。`)).toBe('结果 ` \\notARealCommand{x} `。');
    const dangerous = formatMathForLark(String.raw`$\text{<script>alert(1)</script>}$`);
    expect(dangerous).toContain('` <script>alert(1)</script> `');
    expect(formatMathForLark(dangerous)).toBe(dangerous);
    expect(formatMathForLark(String.raw`$\hat{x}$`)).toBe('` x̂ `');
    expect(formatMathForLark(String.raw`$\underbrace{x}_{\text{source}}$`)).toBe('` [x]（source） `');
  });
  it('does not upload formula images and still supports explicit user images', async () => {
    const upload = vi.fn();
    const result = await resolveOutboundLocalImages('源 $M_B$，权重 $\\alpha_i$。', { roots: [], upload });
    expect(result.content).toContain('` M_B `');
    expect(result.content).toContain('αᵢ');
    expect(result.imageKeys).toEqual([]);
    expect(result.discovered).toBe(0);
    expect(upload).not.toHaveBeenCalled();
  });
});


describe('readable math without losing annotations', () => {
  it('uses complete Unicode scripts and preserves unsupported indices as a unit', () => {
    expect(mathToText(String.raw`x_{ij}^2 + y_{Bq}`)).toBe('xᵢⱼ² + y_(Bq)');
    expect(mathToText(String.raw`x^{qz}`)).toBe('x^(qz)');
  });
  it('retains both labels and the terms they annotate in the real L2L formula', () => {
    const tex = String.raw`L_C=\underbrace{V_{C\leftarrow P}L_P}_{\text{父簇传下来的远处影响}}+\underbrace{\sum_{S\in I(C)}K_{C\leftarrow S}M_S}_{\text{本层补充的影响}}`;
    const text = mathToText(tex);
    expect(text).toBe('L_C = [V_(C ← P) L_P]（父簇传下来的远处影响） + [∑_(S ∈ I ( C )) K_(C ← S) M_S]（本层补充的影响）');
    expect(text).not.toContain('underbrace');
  });
  it('renders single-symbol accents but retains complex accents as source', () => {
    expect(mathToText(String.raw`\hat{x}+\bar{y}+\vec{a}`)).toBe('x̂ + ȳ + a⃗');
    expect(formatMathForLark(String.raw`$\widehat{xy}$`)).toBe('` \\widehat{xy} `');
    expect(mathToText(String.raw`\overbrace{x+y}^{\text{total}}`)).toBe('[x + y]（total）');
  });
});
