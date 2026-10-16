/** 会话历史的本地授权与可见消息存储；查看和渲染卡片不延长有效期。 */
import { mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes, createHash } from 'node:crypto';
import { config } from '../config.js';
import type { Session } from '../types.js';
import { scrubSecrets } from './insight/scrub.js';
import { atomicWriteFileSync } from '../utils/atomic-write.js';
import { terminalAccessEnabled } from './terminal-access.js';

export const HISTORY_TTL_MS = 24 * 60 * 60 * 1000;
export const HISTORY_TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;
const SESSION_RE = /^[A-Za-z0-9_-]{1,100}$/;

export interface HistoryMessage {
  id: string;
  kind: 'user' | 'assistant_final' | 'assistant_progress';
  content: string;
  at: number;
}

export interface ConversationHistory {
  version: 1;
  token: string;
  sessionId: string;
  title: string;
  expiresAt: number;
  source: Pick<Session, 'cliId' | 'cliSessionId' | 'workingDir'>;
  messages: HistoryMessage[];
}

/** 只保留用户正文，剔除桥接信封、启动上下文和内部引用元数据。 */
export function visibleHistoryText(text: string, kind: HistoryMessage['kind']): string {
  if (kind === 'user') {
    const wrapped = [...text.matchAll(/<user_message>\s*([\s\S]*?)\s*<\/user_message>/g)];
    if (wrapped.length) text = wrapped.map(item => item[1]).join('\n\n');
    else if (/^(?:# AGENTS\.md instructions|<environment_context>|<permissions instructions>|<botmux_reminder>)/.test(text.trim())) return '';
  }
  return scrubSecrets(text.replace(/<oai-mem-citation>[\s\S]*?<\/oai-mem-citation>/g, '').trim());
}

/** 原子保存私有数据，避免 daemon 重启读到半份授权或正文。 */
function save(path: string, value: unknown): void {
  const content = JSON.stringify(value);
  if (Buffer.byteLength(content) > 8 * 1024 * 1024) throw new Error('conversation_history_too_large');
  atomicWriteFileSync(path, content, { mode: 0o600 });
}

/** token 是唯一公开查询键；会话 ID、文件路径不能用于直接读取正文。 */
export function readConversationHistory(token: string, dataDir = config.session.dataDir): ConversationHistory | undefined {
  if (!HISTORY_TOKEN_RE.test(token)) return undefined;
  try {
    const value = JSON.parse(readFileSync(join(dataDir, 'conversation-history', `${token}.json`), 'utf8'));
    return value.version === 1 && value.token === token && SESSION_RE.test(value.sessionId)
      && Number.isFinite(value.expiresAt) && Array.isArray(value.messages) ? value : undefined;
  } catch { return undefined; }
}

/** 首次建立一天链接；之后只更新来源元数据，绝不因卡片刷新续期。 */
export function ensureConversationHistory(session: Session, dataDir = config.session.dataDir, now = Date.now()): ConversationHistory {
  if (!SESSION_RE.test(session.sessionId)) throw new Error('invalid_history_session');
  if (terminalAccessEnabled(dataDir, session.sessionId)) throw new Error('protected_session_history_disabled');
  const dir = join(dataDir, 'conversation-history');
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const index = join(dir, `session-${session.sessionId}.json`);
  let old: ConversationHistory | undefined;
  try { old = readConversationHistory(JSON.parse(readFileSync(index, 'utf8')).token, dataDir); } catch {}
  if (old && old.sessionId !== session.sessionId) throw new Error('history_session_mismatch');
  const source = { cliId: session.cliId, cliSessionId: session.cliSessionId, workingDir: session.workingDir };
  const value: ConversationHistory = old ?? {
    version: 1, token: randomBytes(32).toString('base64url'), sessionId: session.sessionId,
    title: session.title, expiresAt: now + HISTORY_TTL_MS, source, messages: [],
  };
  if (!old || JSON.stringify(old.source) !== JSON.stringify(source) || old.title !== session.title) {
    value.source = source;
    value.title = session.title;
    save(join(dir, `${value.token}.json`), value);
    if (!old) save(index, { token: value.token });
  }
  return value;
}

/** 保存全部可见输入与回复；仅新的输入续期，进度和最终回复不续期。 */
export function recordConversationHistory(
  session: Session,
  input: { kind: string; content: string; at: number; id?: string; turnId?: string },
  dataDir = config.session.dataDir,
): void {
  if (!['user', 'assistant_final', 'assistant_progress'].includes(input.kind)) return;
  if (terminalAccessEnabled(dataDir, session.sessionId)) return;
  const kind = input.kind as HistoryMessage['kind'];
  const content = visibleHistoryText(input.content, kind);
  if (!content || !Number.isFinite(input.at)) return;
  const value = ensureConversationHistory(session, dataDir, input.at);
  const id = input.id ?? createHash('sha256').update(`${input.kind}:${input.turnId ?? input.at}:${content}`).digest('hex');
  if (value.messages.some(message => message.id === id)) return;
  value.messages.push({ id, kind, content, at: input.at });
  if (input.kind === 'user') value.expiresAt = Math.max(value.expiresAt, input.at + HISTORY_TTL_MS);
  save(join(dataDir, 'conversation-history', `${value.token}.json`), value);
}
