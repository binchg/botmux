import { statSync } from 'node:fs';
import { scanJsonlFromOffset, jsonlFrontierAnchor } from './jsonl-cursor.js';
import { publicCodexEvent, codexSyncEventKey, type CodexSyncEvent } from './codex-sync-events.js';
import { randomUUID } from 'node:crypto';

const cache = new Map<string, { offset: number; size: number; ino: number; mtime: number; truncated: boolean; anchor?: string; epoch: string; turnId?: string; seen: Set<string>; events: Array<CodexSyncEvent & { offset: number }> }>();
/** Shared tail cache: multiple IDE windows don't each reparse the same log. */
export function readCodexSyncEvents(path: string, cursor = 0) {
  const st = statSync(path);
  let s = cache.get(path);
  const changed = s && (s.size !== st.size || s.mtime !== st.mtimeMs);
  if (!s || s.ino !== st.ino || st.size < s.size || (changed && s.anchor !== undefined && jsonlFrontierAnchor(path, s.offset) !== s.anchor)) {
    s = { offset: 0, size: -1, ino: st.ino, mtime: -1, truncated: false, events: [], epoch: randomUUID(), seen: new Set() };
    if (cache.size >= 128) cache.delete(cache.keys().next().value!);
    cache.set(path, s);
  }
  if (s.size !== st.size || s.mtime !== st.mtimeMs) {
    const state = s;
    const scan = scanJsonlFromOffset(path, s.offset, { endOffset: st.size, onLine: (line, offset) => {
      try {
        const row = JSON.parse(line), p = row.payload ?? {};
        if (row.type === 'event_msg' && p.type === 'task_started') state.turnId = p.turn_id ?? p.root_turn_id;
        const event = publicCodexEvent(row, String(offset));
        if (event) {
          const key = codexSyncEventKey(row, event, state.turnId);
          if (!state.seen.has(key)) { state.seen.add(key); state.events.push({ ...event, id: key, offset }); }
        }
        if (state.events.length > 2000) { state.events.splice(0, 1000); state.truncated = true; }
      } catch { /* ignore incomplete/malformed records */ }
    } });
    if (!scan) throw new Error('transcript_unavailable');
    s.offset = scan.newOffset; s.size = st.size; s.mtime = st.mtimeMs;
    s.anchor = jsonlFrontierAnchor(path, s.offset);
  }
  const reset = cursor > s.offset || (cursor > 0 && cursor < (s.events[0]?.offset ?? 0));
  return { events: s.events.filter(e => reset || e.offset >= cursor), cursor: s.offset, reset, truncated: s.truncated, epoch: s.epoch };
}
