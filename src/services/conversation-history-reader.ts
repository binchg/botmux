/** 为已有会话补读用户输入和最终回复；不读取工具输出、推理或开发者上下文。 */
import { statSync } from 'node:fs';
import { config } from '../config.js';
import { historyLineage } from './conversation-history-lineage.js';
import { resolveSessionTranscriptPath } from './transcript-resolver.js';
import { visibleHistoryText, type ConversationHistory, type HistoryMessage } from './conversation-history-store.js';
import { readCachedHistoryTranscript } from './conversation-history-transcript-cache.js';

/** 提取文本块，明确拒绝 tool_result 等复合内容。 */
function textBlocks(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.filter(block => ['text', 'input_text', 'output_text'].includes(block?.type))
    .map(block => typeof block.text === 'string' ? block.text : '').join('\n');
}

/** 按原始记录类型挑选可公开的会话正文；返回空值的内部记录不会进入网页。 */
export function parseHistoryRecord(record: any, sourceKind: string): HistoryMessage | undefined {
  let kind: HistoryMessage['kind'];
  let text: string;
  if (sourceKind === 'codex' || sourceKind === 'traex') {
    const message = record?.payload;
    if (record?.type !== 'response_item' || message?.type !== 'message') return;
    if (message.channel === 'analysis') return;
    if (message.role === 'user') kind = 'user';
    else if (message.role === 'assistant' && (message.phase === 'final_answer' || message.channel === 'final')) kind = 'assistant_final';
    else if (message.role === 'assistant' && (message.phase === 'commentary' || message.channel === 'commentary')) kind = 'assistant_progress';
    else return;
    text = textBlocks(message.content);
  } else if (sourceKind === 'claude') {
    if (record?.type === 'user' && record.message?.role === 'user') kind = 'user';
    else if (record?.type === 'assistant' && record.message?.role === 'assistant'
      && record.message.stop_reason === 'end_turn') kind = 'assistant_final';
    else return;
    text = textBlocks(record.message.content);
  } else return;
  const content = visibleHistoryText(text, kind);
  const at = Date.parse(record.timestamp);
  if (!content || !Number.isFinite(at)) return;
  return { id: String(record.uuid ?? `${at}:${kind}`), kind, content, at };
}

/** 每次重验关联关系、私密保护和文件身份，使页面缓存不会越过来源变化。 */
export function historySources(history: ConversationHistory, dataDir: string) {
  const sessions = historyLineage(history, dataDir);
  const sources = new Map<string, { path: string; kind: string; signature: string }>();
  let unavailableSources = 0;
  for (const session of sessions) {
    const cliId = session.cliId === 'codex-app' ? 'codex' : session.cliId;
    const source = resolveSessionTranscriptPath({ ...session, cliId, cwd: session.workingDir, fresh: true });
    if (!source || !['codex', 'claude', 'traex'].includes(source.kind)) { unavailableSources++; continue; }
    try {
      const stat = statSync(source.path);
      sources.set(source.path, { ...source, signature: `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}` });
    } catch { unavailableSources++; }
  }
  return { sources: [...sources.values()], unavailableSources };
}

/** 复用历史文件的可见正文缓存，只有追加部分重新解析，保持原来的去重语义。 */
export async function readHistoryBundle(history: ConversationHistory, dataDir = config.session.dataDir,
  snapshot = historySources(history, dataDir)) {
  const old: HistoryMessage[] = [];
  let bytes = 0;
  for (const source of snapshot.sources) {
    const messages = await readCachedHistoryTranscript(source.path, source.kind, parseHistoryRecord);
    bytes += messages.reduce((sum, item) => sum + Buffer.byteLength(item.content), 0);
    if (bytes > 8 * 1024 * 1024) throw new Error('conversation_history_too_large');
    old.push(...messages);
  }
  // 两路只按正文出现次数去重，保留用户重复追问及尚未写入 transcript 的新消息。
  const remaining = new Map<string, number>();
  const key = (message: HistoryMessage) => `${message.kind}:${message.content}`;
  for (const message of old) remaining.set(key(message), (remaining.get(key(message)) ?? 0) + 1);
  for (const message of history.messages) {
    const count = remaining.get(key(message)) ?? 0;
    if (count) remaining.set(key(message), count - 1);
    else old.push(message);
  }
  return { messages: old.sort((a, b) => a.at - b.at), sourceCount: snapshot.sources.length,
    unavailableSources: snapshot.unavailableSources };
}

/** 兼容只需消息数组的内部调用。 */
export async function readHistoryMessages(history: ConversationHistory, dataDir = config.session.dataDir): Promise<HistoryMessage[]> {
  return (await readHistoryBundle(history, dataDir)).messages;
}
