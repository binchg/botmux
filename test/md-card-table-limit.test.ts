import { expect, it } from 'vitest';
import { buildMarkdownCard } from '../src/im/lark/md-card.js';

it('跨图片分段限制同一张卡片的表格数，并保留后续表格数据', () => {
  const tables = Array.from({ length: 7 }, (_, index) => [
    `### 第 ${index + 1} 段`, '',
    '| 指标 | 主包 | 分包 |', '| --- | --- | --- |',
    `| 样本 ${index + 1} | **${index + 11}** | [${index + 21}](https://example.com) |`,
  ].join('\n'));
  const message = [
    ...tables.slice(0, 3),
    '![](img_v3_first) ![](img_v3_second)',
    ...tables.slice(3),
  ].join('\n\n');
  const card = JSON.parse(buildMarkdownCard(message, undefined, ''));
  const elements = card.body.elements;
  expect(elements.filter((item: { tag: string }) => item.tag === 'table')).toHaveLength(5);
  expect(elements.filter((item: { tag: string }) => item.tag === 'column_set')).toHaveLength(1);
  const markdown = elements.filter((item: { tag: string }) => item.tag === 'markdown')
    .map((item: { content: string }) => item.content).join('\n');
  expect(markdown).toContain('指标 样本 6 · 主包 **16** · 分包 [26](https://example.com)');
  expect(markdown).toContain('指标 样本 7 · 主包 **17** · 分包 [27](https://example.com)');
});
