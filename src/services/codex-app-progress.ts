export interface CodexAppProgressSnapshot {
  turnId?: string;
  content: string;
  startedAtMs: number;
  updatedAtMs: number;
}

export interface CodexAppProgressInput {
  turnId?: string;
  text: string;
  startedAtMs: number;
  nowMs: number;
  force?: boolean;
}

export interface CodexAppProgressOptions {
  minInitialChars?: number;
  initialFallbackMs?: number;
  minIntervalMs?: number;
  minDeltaChars?: number;
  maxContentChars?: number;
}

const DEFAULT_MIN_INITIAL_CHARS = 1;
const DEFAULT_INITIAL_FALLBACK_MS = 1_000;
const DEFAULT_MIN_INTERVAL_MS = 3_000;
const DEFAULT_MIN_DELTA_CHARS = 0;
const DEFAULT_MAX_CONTENT_CHARS = 240;

function normalizeRawProgressText(raw: string, trim = true): string {
  const normalized = raw
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n');
  return trim ? normalized.trim() : normalized;
}

function isNaturalBoundary(text: string, index: number): boolean {
  const ch = text[index];
  if (ch === '\n') return true;
  if ('。！？!?；;，,、：:'.includes(ch)) return true;
  if (ch === '.') {
    const next = text[index + 1];
    return next === undefined || /\s/.test(next);
  }
  return false;
}

function lastBoundaryEndAtOrBefore(text: string, limit: number): number {
  let last = -1;
  const end = Math.min(text.length, Math.max(0, limit));
  for (let i = 0; i < end; i++) {
    if (isNaturalBoundary(text, i)) last = i + 1;
  }
  return last;
}

function hardSplitEnd(text: string, limit: number): number {
  const capped = Math.min(text.length, Math.max(1, limit));
  for (let i = capped; i > Math.max(0, capped - 40); i--) {
    if (/\s/.test(text[i - 1] ?? '')) return i;
  }
  return capped;
}

export interface CodexAppProgressChunk {
  content: string;
  consumedChars: number;
}

interface ForwardedProgressState {
  emittedPrefix: string;
}

export function selectCodexAppProgressChunk(
  raw: string,
  maxContentChars = DEFAULT_MAX_CONTENT_CHARS,
  force = false,
): CodexAppProgressChunk | null {
  const normalized = normalizeRawProgressText(raw, false);
  if (!normalized.trim()) return null;

  const leading = normalized.length - normalized.trimStart().length;
  const text = normalized.slice(leading);
  if (!text) return null;

  const limit = Math.max(1, maxContentChars);
  let end = -1;
  if (text.length <= limit) {
    end = force ? text.length : lastBoundaryEndAtOrBefore(text, text.length);
    if (end < 0) return null;
  } else {
    end = lastBoundaryEndAtOrBefore(text, limit);
    if (end < 0) {
      end = hardSplitEnd(text, limit);
    }
  }

  const content = text.slice(0, end).trim();
  if (!content) return null;
  return { content, consumedChars: leading + end };
}

export function normalizeCodexAppProgressText(raw: string, maxContentChars = DEFAULT_MAX_CONTENT_CHARS): string {
  const normalized = normalizeRawProgressText(raw);
  if (normalized.length <= maxContentChars) return normalized;
  return selectCodexAppProgressChunk(normalized, maxContentChars, true)?.content
    ?? normalized.slice(0, maxContentChars).trim();
}

export class CodexAppProgressThrottler {
  private lastSentAtMs = 0;
  private emittedUntil = 0;
  private emittedPrefix = '';
  private readonly minInitialChars: number;
  private readonly initialFallbackMs: number;
  private readonly minIntervalMs: number;
  private readonly minDeltaChars: number;
  private readonly maxContentChars: number;

  constructor(options: CodexAppProgressOptions = {}) {
    this.minInitialChars = options.minInitialChars ?? DEFAULT_MIN_INITIAL_CHARS;
    this.initialFallbackMs = options.initialFallbackMs ?? DEFAULT_INITIAL_FALLBACK_MS;
    this.minIntervalMs = options.minIntervalMs ?? DEFAULT_MIN_INTERVAL_MS;
    this.minDeltaChars = options.minDeltaChars ?? DEFAULT_MIN_DELTA_CHARS;
    this.maxContentChars = options.maxContentChars ?? DEFAULT_MAX_CONTENT_CHARS;
  }

  maybeSnapshot(input: CodexAppProgressInput): CodexAppProgressSnapshot | null {
    const fullContent = normalizeCodexAppProgressText(input.text, Number.MAX_SAFE_INTEGER);
    if (!fullContent) return null;

    if (
      this.emittedUntil > fullContent.length ||
      (this.emittedPrefix && !fullContent.startsWith(this.emittedPrefix))
    ) {
      this.lastSentAtMs = 0;
      this.emittedUntil = 0;
      this.emittedPrefix = '';
    }

    const elapsedMs = input.nowMs - this.lastSentAtMs;
    if (this.lastSentAtMs > 0 && elapsedMs < this.minIntervalMs) return null;

    const forceIntervalSnapshot = input.force
      || (this.lastSentAtMs === 0 && input.nowMs - input.startedAtMs >= this.initialFallbackMs)
      || (this.lastSentAtMs > 0 && elapsedMs >= this.minIntervalMs);

    const chunk = selectCodexAppProgressChunk(
      fullContent.slice(this.emittedUntil),
      this.maxContentChars,
      forceIntervalSnapshot,
    );
    if (!chunk) return null;
    if (this.lastSentAtMs === 0 && chunk.content.length < this.minInitialChars) return null;
    if (this.lastSentAtMs > 0 && !forceIntervalSnapshot && chunk.content.length < this.minDeltaChars) return null;
    if (this.lastSentAtMs > 0 && input.force && chunk.content.length < Math.ceil(this.minDeltaChars / 2)) return null;

    this.lastSentAtMs = input.nowMs;
    this.emittedUntil += chunk.consumedChars;
    this.emittedPrefix = fullContent.slice(0, this.emittedUntil);
    return {
      turnId: input.turnId,
      content: chunk.content,
      startedAtMs: input.startedAtMs,
      updatedAtMs: input.nowMs,
    };
  }
}

export class CodexAppProgressForwarder {
  private readonly maxContentChars: number;
  private readonly states = new Map<string, ForwardedProgressState>();

  constructor(options: Pick<CodexAppProgressOptions, 'maxContentChars'> = {}) {
    this.maxContentChars = options.maxContentChars ?? DEFAULT_MAX_CONTENT_CHARS;
  }

  next(turnId: string | undefined, raw: string): CodexAppProgressChunk | null {
    const key = turnId || '__default__';
    const normalized = normalizeRawProgressText(raw);
    if (!normalized) return null;

    const state = this.states.get(key) ?? { emittedPrefix: '' };
    this.states.set(key, state);

    if (state.emittedPrefix && state.emittedPrefix === normalized) return null;
    if (state.emittedPrefix && state.emittedPrefix.startsWith(normalized)) return null;

    const cumulative = !!state.emittedPrefix && normalized.startsWith(state.emittedPrefix);
    const source = cumulative ? normalized.slice(state.emittedPrefix.length) : normalized;
    const chunk = selectCodexAppProgressChunk(source, this.maxContentChars, true);
    if (!chunk) return null;

    if (cumulative) {
      state.emittedPrefix += source.slice(0, chunk.consumedChars);
    } else {
      state.emittedPrefix += normalized.slice(0, chunk.consumedChars);
    }
    return chunk;
  }
}
