/** 只沿同一机器人、群和明确话题引用恢复旧会话，不把整个群历史拼进页面。 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Session } from '../types.js';
import type { ConversationHistory } from './conversation-history-store.js';
import { terminalAccessEnabled } from './terminal-access.js';

/** 保留跨会话继续的完整输入和回复；无明确引用的邻近会话不会匹配。 */
export function historyLineage(history: ConversationHistory, dataDir: string): Session[] {
  const sessions: Session[] = [];
  for (const file of readdirSync(dataDir).filter(name => /^sessions(?:-.+)?\.json$/.test(name))) {
    const values = JSON.parse(readFileSync(join(dataDir, file), 'utf8'));
    sessions.push(...Object.values(values) as Session[]);
  }
  const current = sessions.find(item => item.sessionId === history.sessionId);
  if (!current) return [{ ...history.source, sessionId: history.sessionId } as Session];
  const roots = new Set([current.rootMessageId, ...Object.keys(current.replyThreadAliases ?? {})].filter(Boolean));
  const candidates = sessions.filter(item => item.sessionId === current.sessionId || (
    !!current.larkAppId && item.larkAppId === current.larkAppId && item.chatId === current.chatId
    && item.ownerOpenId === current.ownerOpenId && Date.parse(item.createdAt) <= Date.parse(current.createdAt)
    && [item.rootMessageId, ...Object.keys(item.replyThreadAliases ?? {})].some(root => roots.has(root))
  ));
  const unique = [...new Map(candidates.map(item => [item.sessionId, item])).values()];
  if (unique.length > 32) throw new Error('conversation_history_lineage_too_large');
  return unique.filter(item => !terminalAccessEnabled(dataDir, item.sessionId))
    .sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt));
}
