/** 验证按追问折叠进度，不跨轮吞掉用户输入或最终回复。 */
import { expect, it } from 'vitest';
import { renderHistoryTurns } from '../src/services/conversation-history-turns.js';
import { escapeHistoryHtml } from '../src/services/conversation-history-page.js';
import type { HistoryMessage } from '../src/services/conversation-history-store.js';

it('每次追问之间只预览最后进度，前面进度保留在默认折叠区，最终回复可见', () => {
  const values: [HistoryMessage['kind'], string][] = [['user', '首问'], ['assistant_progress', '早期进度'],
    ['assistant_progress', '第一轮最后进度'], ['assistant_final', '第一轮结果'], ['user', '追问'],
    ['assistant_progress', '第二轮进度'], ['assistant_progress', '第二轮最后进度']];
  const messages = values.map(([kind, content], at) => ({ id: String(at), kind, content, at }));
  const html = renderHistoryTurns(messages, message => `<p>${message.content}</p>`, escapeHistoryHtml);
  const summaries = [...html.matchAll(/<summary>([\s\S]*?)<\/summary>/g)].map(match => match[1]);
  expect(summaries).toHaveLength(2);
  expect(summaries[0]).toContain('第一轮最后进度');
  expect(summaries[0]).not.toContain('早期进度');
  expect(summaries[1]).toContain('第二轮最后进度');
  expect(html).not.toMatch(/<details[^>]*\bopen(?:\s|=|>)/);
  expect(html.replace(/<details[\s\S]*?<\/details>/g, '')).toContain('<p>第一轮结果</p><p>追问</p>'.replace('</p><p>', '</p>\n<p>'));
  expect(html).toContain('早期进度');
});

it('连续追问和无进度轮次不生成空折叠，摘要转义正文 HTML', () => {
  const messages: HistoryMessage[] = [
    { id: 'u1', kind: 'user', content: '问题1', at: 1 }, { id: 'u2', kind: 'user', content: '问题2', at: 2 },
    { id: 'p1', kind: 'assistant_progress', content: '<img onerror=alert(1)>', at: 3 },
  ];
  const html = renderHistoryTurns(messages, message => escapeHistoryHtml(message.content), escapeHistoryHtml);
  expect((html.match(/<details/g) ?? []).length).toBe(1);
  expect(html).not.toContain('<img');
  expect(html).toContain('&lt;img');
});
