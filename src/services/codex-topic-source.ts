import { openSync, readSync, closeSync } from 'node:fs';

export interface CodexTopicSource {
  meta?: Record<string, any>;
  firstUserMessage?: string;
  firstUserOffset?: number;
}
/** Read source metadata and the actual first user event, preserving its text.
 * Environment/instruction response_items and assistant/hook summaries are not
 * user input. Stop after the first real prompt; never read the entire archive. */
export function readCodexTopicSource(path: string): CodexTopicSource {
  const result: CodexTopicSource = {};
  const fd = openSync(path, 'r'), chunk = Buffer.alloc(64 * 1024);
  let carry = Buffer.alloc(0), total = 0, consumed = 0;
  try {
    while (total < 16 * 1024 * 1024) {
      const count = readSync(fd, chunk, 0, chunk.length, null);
      if (!count) break;
      total += count;
      carry = Buffer.concat([carry, chunk.subarray(0, count)]);
      let end: number;
      while ((end = carry.indexOf(10)) >= 0) {
        const lineOffset = consumed; consumed += end + 1;
        const line = carry.subarray(0, end).toString('utf8'); carry = carry.subarray(end + 1);
        let row: any;
        try { row = JSON.parse(line); } catch { continue; }
        if (!result.meta && row.type === 'session_meta') result.meta = row.payload;
        if (row.type === 'event_msg' && row.payload?.type === 'user_message' && typeof row.payload.message === 'string' && row.payload.message.trim()) {
          result.firstUserMessage = row.payload.message;
          result.firstUserOffset = lineOffset;
          return result;
        }
      }
    }
    return result;
  } finally { closeSync(fd); }
}
export function isCodexSubagent(meta: Record<string, any> | undefined): boolean {
  return !!meta && ((typeof meta.source === 'object' && meta.source !== null && 'subagent' in meta.source)
    || meta.source === 'subagent' || !!meta.agent_path || !!meta.agent_role);
}
export function isCodexFork(meta: Record<string, any> | undefined): boolean {
  return typeof meta?.forked_from_id === 'string' && !!meta.forked_from_id;
}
