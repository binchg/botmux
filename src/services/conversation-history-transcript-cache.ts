/** 按文件身份和完整行偏移缓存可见正文；巨大工具记录在解析前丢弃，追加只读增量。 */
import { createReadStream, statSync } from 'node:fs';
import type { HistoryMessage } from './conversation-history-store.js';

interface Entry {
  identity: string; size: number; mtime: number; offset: number;
  messages: HistoryMessage[]; bytes: number;
}
const entries = new Map<string, Entry>();
const LIMIT = 8 * 1024 * 1024;

/** 只排除已能确定为内部类型的记录；不识别的前缀仍交给完整 JSON 校验。 */
function invisible(prefix: string, kind: string): boolean {
  if (kind !== 'codex' && kind !== 'traex') return false;
  const header = prefix.match(/^\s*\{\s*"timestamp"\s*:\s*"[^"\\]*"\s*,\s*(?:"ordinal"\s*:\s*\d+\s*,\s*)?"type"\s*:\s*"([^"\\]+)"\s*,\s*"payload"\s*:\s*\{\s*"type"\s*:\s*"([^"\\]+)"/);
  return !!header && (header[1] !== 'response_item' || header[2] !== 'message');
}

/** 原文件被替换、缩短或原地改写时重建；未落盘完整行留给下次读取。 */
export async function readCachedHistoryTranscript(
  path: string, kind: string, parse: (record: unknown, kind: string) => HistoryMessage | undefined,
): Promise<HistoryMessage[]> {
  const stat = statSync(path);
  const identity = `${stat.dev}:${stat.ino}:${stat.birthtimeMs}`;
  const key = `${kind}:${path}`;
  const old = entries.get(key);
  if (old && old.identity === identity && old.size === stat.size && old.mtime === stat.mtimeMs) return old.messages;
  const reusable = old && old.identity === identity && stat.size > old.size;
  const entry: Entry = reusable ? { ...old, messages: [...old.messages] }
    : { identity, size: 0, mtime: 0, offset: 0, messages: [], bytes: 0 };
  let parts: Buffer[] = [];
  let length = 0;
  let skip = false;
  let prefix = '';
  let position = entry.offset;
  if (stat.size > position) {
    const stream = createReadStream(path, { start: position, end: stat.size - 1, highWaterMark: 256 * 1024 });
    try {
      for await (const chunk of stream as AsyncIterable<Buffer>) {
        let start = 0;
        while (start < chunk.length) {
          const newline = chunk.indexOf(10, start);
          const end = newline < 0 ? chunk.length : newline;
          const piece = chunk.subarray(start, end);
          if (!skip) {
            parts.push(piece); length += piece.length;
            if (prefix.length < 512) prefix += piece.subarray(0, 512 - prefix.length).toString('utf8');
            // 常规日志的类型位于首块；超长内部行不做反复字符串拼接或 JSON.parse。
            if (invisible(prefix, kind)) {
              skip = true; parts = [];
            } else if (length > LIMIT) throw new Error('conversation_history_line_too_large');
          }
          position += piece.length + (newline < 0 ? 0 : 1);
          if (newline < 0) break;
          if (!skip && length) {
            let record: unknown;
            try { record = JSON.parse(Buffer.concat(parts, length).toString('utf8')); } catch {}
            const message = record ? parse(record, kind) : undefined;
            if (message) {
              entry.bytes += Buffer.byteLength(message.content);
              if (entry.bytes > LIMIT) throw new Error('conversation_history_too_large');
              entry.messages.push(message);
            }
          }
          entry.offset = position;
          parts = []; length = 0; skip = false; prefix = '';
          start = end + 1;
        }
      }
    } finally { stream.destroy(); }
  }
  entry.size = stat.size; entry.mtime = stat.mtimeMs;
  entries.delete(key); entries.set(key, entry);
  // 缓存只在进程内保留脱敏正文，数量与总正文大小均有界。
  let bytes = [...entries.values()].reduce((sum, item) => sum + item.bytes, 0);
  while (entries.size > 32 || bytes > 32 * 1024 * 1024) {
    const first = entries.keys().next().value!;
    bytes -= entries.get(first)!.bytes; entries.delete(first);
  }
  return entry.messages;
}
