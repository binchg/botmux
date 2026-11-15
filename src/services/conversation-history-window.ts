import { createHash } from 'node:crypto';
import type { HistoryMessage } from './conversation-history-store.js';

export const HISTORY_PAGE_SIZE = 40;
export const historyCursor = (message: HistoryMessage): string => createHash('sha256')
  .update(JSON.stringify([message.id, message.kind, message.at, message.content])).digest('base64url').slice(0, 22);

/** Stable cursors survive appends; the browser never downloads an entire transcript. */
export function historyWindow(messages: HistoryMessage[], query: { before?: string; after?: string; around?: string } = {}) {
  const { before, after, around } = query;
  const cursor = before ?? after ?? around;
  const index = cursor ? messages.findIndex(message => historyCursor(message) === cursor) : -1;
  if (cursor && index < 0) throw new Error('history_cursor_not_found');
  let start = Math.max(0, messages.length - HISTORY_PAGE_SIZE), end = messages.length;
  if (before) { end = index; start = Math.max(0, end - HISTORY_PAGE_SIZE); }
  if (after) { start = index + 1; end = Math.min(messages.length, start + HISTORY_PAGE_SIZE); }
  if (around) { start = Math.max(0, index - Math.floor(HISTORY_PAGE_SIZE / 2)); end = Math.min(messages.length, start + HISTORY_PAGE_SIZE); }
  return { messages: messages.slice(start, end), start, end, total: messages.length,
    hasOlder: start > 0, hasNewer: end < messages.length };
}
