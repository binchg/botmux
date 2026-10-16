/** 用独立合成会话验证从首问恢复、可见进度以及跨话题隔离。 */
import { afterEach, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Session } from '../src/types.js';
import { ensureConversationHistory, recordConversationHistory } from '../src/services/conversation-history-store.js';
import { readHistoryBundle } from '../src/services/conversation-history-reader.js';
import * as resolver from '../src/services/transcript-resolver.js';
import { issueTerminalEntry } from '../src/services/terminal-access.js';
import { renderConversationHistory } from '../src/services/conversation-history-page.js';

const directories: string[] = [];
afterEach(() => { vi.restoreAllMocks(); directories.splice(0).forEach(dir => rmSync(dir, { recursive: true, force: true })); });

it('跨重建会话恢复首问和所有阶段回复，不混入同群无引用会话、别的机器人或受保护会话', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'history-lineage-')); directories.push(dir);
  const base = { chatId: 'chat', larkAppId: 'bot', ownerOpenId: 'owner', status: 'closed', cliId: 'codex-app',
    createdAt: '2026-10-14T00:00:00Z', rootMessageId: 'original', title: '合成测试' } as Session;
  const first = { ...base, sessionId: 'first', replyThreadAliases: { shared: { createdAt: '', lastUsedAt: '' } } };
  const current = { ...base, sessionId: 'current', rootMessageId: 'new-root', createdAt: '2026-10-16T00:00:00Z',
    replyThreadAliases: first.replyThreadAliases };
  const unrelated = { ...base, sessionId: 'unrelated', rootMessageId: 'unrelated' };
  const otherBot = { ...first, sessionId: 'other-bot', larkAppId: 'other' };
  const protectedSession = { ...first, sessionId: 'protected' };
  writeFileSync(join(dir, 'sessions-bot.json'), JSON.stringify([first, current, unrelated, otherBot, protectedSession]));
  issueTerminalEntry(dir, 'protected');
  const row = (text: string, role: string, index: number, phase?: string) => JSON.stringify({
    type: 'response_item', timestamp: new Date(Date.parse('2026-10-14T00:00:00Z') + index * 1000).toISOString(),
    payload: { type: 'message', role, phase, content: [{ type: 'input_text', text }] },
  });
  writeFileSync(join(dir, 'first.jsonl'), [row('最初完整的问题', 'user', 0),
    ...Array.from({ length: 150 }, (_, i) => row(`可见阶段回复${i}`, 'assistant', i + 1, 'commentary')),
    row('隐藏推理', 'assistant', 152, 'analysis'), row('开发者规则', 'developer', 153),
    row('第一段结论', 'assistant', 154, 'final_answer')].join('\n') + '\n');
  writeFileSync(join(dir, 'current.jsonl'), row('继续追问', 'user', 155) + '\n');
  const spy = vi.spyOn(resolver, 'resolveSessionTranscriptPath').mockImplementation(query => ({
    path: join(dir, `${query.sessionId}.jsonl`), kind: 'codex',
  }));
  const grant = ensureConversationHistory(current, dir);
  recordConversationHistory(current, { kind: 'user', content: '继续追问', at: Date.now() }, dir);
  const result = await readHistoryBundle(ensureConversationHistory(current, dir), dir);
  expect(result.sourceCount).toBe(2);
  expect(result.messages).toHaveLength(153);
  expect(result.messages[0].content).toBe('最初完整的问题');
  expect(result.messages.filter(item => item.kind === 'assistant_progress')).toHaveLength(150);
  expect(spy.mock.calls.map(([query]) => query.sessionId)).toEqual(['first', 'current']);
  const html = renderConversationHistory(grant, result.messages, result).html;
  expect(html).toContain('2 条输入 · 151 条回复 · 2 段关联会话');
  expect(html).toContain('阶段回复');
  expect(html).not.toContain('隐藏推理');
  expect(html).not.toContain('开发者规则');
});

it('找不到旧原始记录时明确标记不全，保留已持久化新消息', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'history-unavailable-')); directories.push(dir);
  const session = { sessionId: 'missing', rootMessageId: 'root', title: '合成测试' } as Session;
  vi.spyOn(resolver, 'resolveSessionTranscriptPath').mockReturnValue(null);
  recordConversationHistory(session, { kind: 'user', content: '已保存追问', at: Date.now() }, dir);
  const grant = ensureConversationHistory(session, dir);
  const result = await readHistoryBundle(grant, dir);
  expect(result.unavailableSources).toBe(1);
  expect(result.messages[0].content).toBe('已保存追问');
  expect(renderConversationHistory(grant, result.messages, result).html).toContain('原始记录暂不可读');
});
