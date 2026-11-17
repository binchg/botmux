import { statSync } from 'node:fs';
import { scanJsonlFromOffset, jsonlFrontierAnchor } from './jsonl-cursor.js';
import { normalizeCodexAppTimestampMs } from './codex-app-activity.js';

interface Turn { start?: number; end?: number; duration?: number }
interface Aggregate {
  offset: number; size: number; mtime: number; inode: number; created?: number;
  turns: Map<string, Turn>; active?: string; tools: Set<string>;
  input?: number; output?: number; cached?: number;
  totalRuntime: number; completed: number; unfinished: number;
  anchor?: string;
}
export interface CodexSessionStatistics {
  createdAtMs?: number; runningMs: number; turns: number; tools: number;
  inputTokens?: number; outputTokens?: number; cachedTokens?: number;
  incomplete: boolean;
}
const files = new Map<string, Aggregate>();
const numeric = (n: unknown) => typeof n === 'number' && Number.isFinite(n) && n >= 0 ? n : undefined;
const timestamp = (v: unknown): number | undefined => {
  if (v === undefined || v === null) return;
  if (typeof v === 'string' && !/^\d+(\.\d+)?$/.test(v)) { const n = Date.parse(v); return Number.isFinite(n) ? n : undefined; }
  const n = Number(v); return n > 0 && Number.isFinite(n) ? normalizeCodexAppTimestampMs(n) : undefined;
};
function setTurn(a: Aggregate, id: string, t: Turn): void {
  const old = a.turns.get(id);
  if (old?.duration !== undefined) { a.totalRuntime -= old.duration; a.completed--; }
  else if (old) a.unfinished--;
  a.turns.set(id, t);
  if (t.duration !== undefined) { a.totalRuntime += t.duration; a.completed++; }
  else a.unfinished++;
}
function fold(a: Aggregate, row: any): void {
  const p = row.payload ?? {}, at = timestamp(row.timestamp);
  if (row.type === 'session_meta') a.created = timestamp(p.timestamp) ?? at;
  if (row.type === 'response_item' && ['function_call', 'custom_tool_call'].includes(p.type) && p.call_id) a.tools.add(String(p.call_id));
  if (row.type !== 'event_msg') return;
  if (at !== undefined) a.created = Math.min(a.created ?? at, at);
  if (p.type === 'token_count' && p.info?.total_token_usage) {
    const u = p.info.total_token_usage;
    a.input = numeric(u.input_tokens); a.output = numeric(u.output_tokens); a.cached = numeric(u.cached_input_tokens);
  }
  if (p.type === 'task_started') {
    const id = p.turn_id ?? p.root_turn_id;
    if (typeof id !== 'string') return;
    const t = { ...a.turns.get(id) };
    t.start ??= timestamp(p.started_at) ?? at;
    setTurn(a, id, t); a.active = id;
  }
  if (p.type === 'task_complete' || p.type === 'turn_aborted') {
    const id = p.turn_id ?? p.root_turn_id ?? a.active;
    if (typeof id !== 'string') return;
    const t = { ...a.turns.get(id) };
    t.start ??= timestamp(p.started_at);
    t.end = timestamp(p.completed_at) ?? at;
    t.duration = numeric(p.duration_ms) ?? (t.start !== undefined && t.end !== undefined ? Math.max(0, t.end - t.start) : undefined);
    setTurn(a, id, t);
    if (a.active === id) a.active = undefined;
  }
}

/** Source log is the durable journal. One bounded-memory cold scan; afterwards
 * stat short-circuit + byte cursor read ONLY appended complete UTF-8 lines.
 * Restart reconstructs the same counters, never writes the source transcript. */
export function readCodexSessionStatistics(path: string, now = Date.now(), running = false): CodexSessionStatistics | undefined {
  try {
    const s = statSync(path);
    let a = files.get(path);
    const changed = a && (s.size !== a.size || s.mtimeMs !== a.mtime);
    if (!a || a.inode !== s.ino || s.size < a.size || (changed && a.anchor !== undefined && jsonlFrontierAnchor(path, a.offset) !== a.anchor)) {
      a = { offset: 0, size: -1, mtime: -1, inode: s.ino, turns: new Map(), tools: new Set(), totalRuntime: 0, completed: 0, unfinished: 0 };
      if (files.size >= 128) files.delete(files.keys().next().value!);
      files.set(path, a);
    }
    if (s.size !== a.size || s.mtimeMs !== a.mtime) {
      const target = a;
      const scan = scanJsonlFromOffset(path, a.offset, { endOffset: s.size, onLine: line => {
        try { fold(target, JSON.parse(line)); } catch { /* malformed records do not invent measurements */ }
      } });
      if (!scan) return;
      a.offset = scan.newOffset; a.size = s.size; a.mtime = s.mtimeMs;
      a.anchor = jsonlFrontierAnchor(path, a.offset);
    }
    const active = a.active ? a.turns.get(a.active) : undefined;
    const live = running && active?.duration === undefined && active?.start !== undefined;
    const runningMs = a.totalRuntime + (live ? Math.max(0, now - active!.start!) : 0);
    return { createdAtMs: a.created, runningMs, turns: a.completed, tools: a.tools.size,
      inputTokens: a.input, outputTokens: a.output, cachedTokens: a.cached, incomplete: a.unfinished > (live ? 1 : 0) };
  } catch { return; }
}

export function formatStatisticsDuration(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  const days = Math.floor(seconds / 86400), hours = Math.floor(seconds / 3600) % 24, minutes = Math.floor(seconds / 60) % 60;
  return [days ? `${days}天` : '', hours ? `${hours}时` : '', minutes ? `${minutes}分` : ''].filter(Boolean).join('') || '不足1分钟';
}

export function codexStatisticsText(stats: CodexSessionStatistics | undefined, createdAt?: string, now = Date.now(), en = false): string {
  const created = createdAt ? Date.parse(createdAt) : stats?.createdAtMs;
  const age = created !== undefined && Number.isFinite(created) ? formatStatisticsDuration(now - created) : '—';
  const number = (n?: number) => n === undefined ? '—' : n.toLocaleString('en-US');
  // Cached tokens are already included in input; never add them a second time.
  const total = stats?.inputTokens !== undefined && stats?.outputTokens !== undefined
    ? ((stats.inputTokens + stats.outputTokens) / 100_000_000).toFixed(2) : undefined;
  const rate = stats?.inputTokens && stats.cachedTokens !== undefined
    ? `${(Math.min(1, stats.cachedTokens / stats.inputTokens) * 100).toFixed(1)}%` : stats?.inputTokens === 0 && stats.cachedTokens === 0 ? '0.0%' : '—';
  if (en) return `Created ${age} ago · Running ${stats ? formatStatisticsDuration(stats.runningMs) : '—'}\nUsage ${total === undefined ? '—' : `${total} × 100M tokens`} · Cache ${rate} · Tools ${number(stats?.tools)}`;
  if (['0', '1'].includes(process.env.BOTMUX_BOT_INDEX ?? '0')) {
    const compactRate = rate === '—' ? rate : `${Math.round(Number.parseFloat(rate))}%`;
    return `至今 ${age} · 累计 ${stats ? formatStatisticsDuration(stats.runningMs) : '—'}\n耗 ${total === undefined ? '—' : `${total}亿`} · 缓存 ${compactRate}`;
  }
  return `⏱ 创建至今 ${age} · 累计运行 ${stats ? formatStatisticsDuration(stats.runningMs) : '—'}\n📊 消耗 ${total === undefined ? '—' : `${total}亿`} · 缓存率 ${rate} · 工具 ${number(stats?.tools)}次`;
}
