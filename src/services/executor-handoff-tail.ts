/** 从绑定的本机线程尾部读取接续消息，避免跨进程序列化整个长会话。 */
import { closeSync, fstatSync, openSync, readSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { codexSessionsRoot } from './codex-paths.js';
import { findCodexRolloutBySessionId } from './codex-transcript.js';
import { findTraexRolloutBySessionId } from './traex-transcript.js';
import { visibleHistoryText, HISTORY_TOKEN_RE } from './conversation-history-store.js';
import { executorHandoff } from './session-executor-handoff.js';
import { modelExecutorEnv, type ModelExecutor } from './model-executor.js';

const maxTail = 4 * 1024 * 1024;

/** 只解析末尾的完整记录，取最后的可见用户及助手文本。 */
export function rolloutHandoff(path: string): string | undefined {
  const fd = openSync(path, 'r');
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile()) return;
    const start = Math.max(stat.size - maxTail, 0);
    const data = Buffer.alloc(stat.size - start);
    const lines = data.subarray(0, readSync(fd, data, 0, data.length, start)).toString('utf8').split('\n');
    if (start) lines.shift();
    const recent: any[] = [];
    const seen = new Set<string>();
    for (let i = lines.length - 1; i >= 0 && recent.length < 24; i--) {
      let row: any;
      try { row = JSON.parse(lines[i]); } catch { continue; }
      const p = row.payload;
      const messages = row.type === 'response_item' ? [p]
        : row.type === 'history_mutation' && Array.isArray(p?.items) ? p.items : [];
      for (let j = messages.length - 1; j >= 0 && recent.length < 24; j--) {
        const item = messages[j];
        if (item?.type !== 'message' || item.channel === 'analysis' || !['user', 'assistant'].includes(item.role)) continue;
        if (item.role === 'assistant' && !['final_answer', 'commentary', 'final'].includes(item.phase ?? item.channel)) continue;
        if (item.id && seen.has(item.id)) continue;
        const body = Array.isArray(item.content) ? item.content
          .filter((part: any) => ['text', 'input_text', 'output_text'].includes(part?.type) && typeof part.text === 'string')
          .map((part: any) => part.text).join('\n') : '';
        const text = visibleHistoryText(body, item.role === 'user' ? 'user' : 'assistant_final');
        if (!text) continue;
        if (item.id) seen.add(item.id);
        recent.push(item.role === 'user' ? { type: 'userMessage', content: [{ type: 'text', text }] }
          : { type: 'agentMessage', text });
      }
    }
    if (recent.length) return executorHandoff({ turns: [{ items: recent.reverse() }] });
  } finally { closeSync(fd); }
}

/** 其次使用同一 Botmux 会话的可见消息，不读取其它话题或私密终端历史。 */
export function localExecutorHandoff(executor: ModelExecutor, threadId: string, dataDir: string, sessionId: string): string | undefined {
  try {
    const home = executor === 'ark' || executor === 'gateway' ? modelExecutorEnv(executor).CODEX_HOME : undefined;
    const path = executor === 'traex' ? findTraexRolloutBySessionId(threadId)
      : findCodexRolloutBySessionId(threadId, home ? join(home, 'sessions') : codexSessionsRoot());
    const tail = path && rolloutHandoff(path);
    if (tail) return tail;
  } catch { /* 原始记录不可用时继续使用同一话题的可见消息。 */ }
  if (!/^[A-Za-z0-9_-]{1,100}$/.test(sessionId)) return;
  try {
    const dir = join(dataDir, 'conversation-history');
    const { token } = JSON.parse(readFileSync(join(dir, `session-${sessionId}.json`), 'utf8'));
    if (typeof token !== 'string' || !HISTORY_TOKEN_RE.test(token)) return;
    const history = JSON.parse(readFileSync(join(dir, `${token}.json`), 'utf8'));
    if (history.sessionId !== sessionId || history.token !== token || !Array.isArray(history.messages)) return;
    const items = history.messages.slice(-24).flatMap((message: any) => {
      if (typeof message?.content !== 'string') return [];
      if (message.kind === 'user') return [{ type: 'userMessage', content: [{ type: 'text', text: message.content }] }];
      if (['assistant_final', 'assistant_progress'].includes(message.kind)) return [{ type: 'agentMessage', text: message.content }];
      return [];
    });
    if (items.length) return executorHandoff({ turns: [{ items }] });
  } catch { /* 无可用本地快照时留给原生线程读取。 */ }
}
