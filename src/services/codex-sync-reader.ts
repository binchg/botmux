import { statSync } from 'node:fs';
import { scanJsonlFromOffset } from './jsonl-cursor.js';
import { publicCodexEvent, type CodexSyncEvent } from './codex-sync-events.js';

const cache = new Map<string, { offset: number; size: number; ino: number; mtime: number; truncated: boolean; events: Array<CodexSyncEvent & { offset: number }> }>();
/** Shared tail cache: multiple IDE windows don't each reparse the same log. */
export function readCodexSyncEvents(path: string, cursor = 0) {
  const st = statSync(path);
  let s = cache.get(path);
  if (!s || s.ino !== st.ino || st.size < s.size) {
    s = { offset: 0, size: -1, ino: st.ino, mtime: -1, truncated: false, events: [] };
    if (cache.size >= 128) cache.delete(cache.keys().next().value!);
    cache.set(path, s);
  }
  if (s.size !== st.size || s.mtime !== st.mtimeMs) {
    const state = s;
    const scan = scanJsonlFromOffset(path, s.offset, { endOffset: st.size, onLine: (line, offset) => {
      try {
        const event = publicCodexEvent(JSON.parse(line), String(offset));
        if (event) state.events.push({ ...event, offset });
        if (state.events.length > 2000) { state.events.splice(0, 1000); state.truncated = true; }
      } catch { /* ignore incomplete/malformed records */ }
    } });
    if (!scan) throw new Error('transcript_unavailable');
    s.offset = scan.newOffset; s.size = st.size; s.mtime = st.mtimeMs;
  }
  const reset = cursor > s.offset || (cursor > 0 && cursor < (s.events[0]?.offset ?? 0));
  return { events: s.events.filter(e => reset || e.offset >= cursor), cursor: s.offset, reset, truncated: s.truncated };
}
