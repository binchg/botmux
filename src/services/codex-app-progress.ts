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
  // A progress card must end at a complete sentence. Commas, enumeration
  // separators, colons, semicolons and line breaks are clause/formatting
  // boundaries and used to produce bad cases such as "我" or "入口".
  if ('。！？!?…'.includes(ch)) return true;
  if (ch === '.') {
    const next = text[index + 1];
    return next === undefined || /\s/.test(next);
  }
  return false;
}

function extendSentenceEnd(text: string, end: number): number {
  let cursor = end;
  // Keep repeated ellipses and closing punctuation with the sentence instead
  // of starting the next progress card with a dangling quote/bracket.
  while (cursor < text.length && /[…”’」』）】》]/.test(text[cursor])) cursor++;
  return cursor;
}

function lastBoundaryEndAtOrBefore(text: string, limit: number): number {
  let last = -1;
  const end = Math.min(text.length, Math.max(0, limit));
  for (let i = 0; i < end; i++) {
    if (isNaturalBoundary(text, i)) last = i + 1;
  }
  return last;
}

function firstBoundaryEndAfter(text: string, start: number): number {
  for (let i = Math.max(0, start); i < text.length; i++) {
    if (isNaturalBoundary(text, i)) return i + 1;
  }
  return -1;
}

export interface CodexAppProgressChunk {
  content: string;
  consumedChars: number;
  sequence?: number;
}

interface ForwardedProgressState {
  lastRaw: string;
  pending: string;
  sequence: number;
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
      // `maxContentChars` is a soft card-size target, never a sentence cutter.
      // If the first sentence is long, keep scanning until its real ending.
      end = firstBoundaryEndAfter(text, limit);
      if (end < 0) end = force ? text.length : -1;
      if (end < 0) return null;
    }
  }

  end = extendSentenceEnd(text, end);
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

    const intervalReady = (this.lastSentAtMs === 0 && input.nowMs - input.startedAtMs >= this.initialFallbackMs)
      || (this.lastSentAtMs > 0 && elapsedMs >= this.minIntervalMs);
    const forceIntervalSnapshot = input.force || intervalReady;

    const chunk = selectCodexAppProgressChunk(
      fullContent.slice(this.emittedUntil),
      this.maxContentChars,
      // A timer may decide *when* to check, but must not turn an unfinished
      // clause into a card. Only item/completed may accept text without final
      // punctuation because app-server then guarantees semantic completion.
      input.force,
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

    const state = this.states.get(key) ?? { lastRaw: '', pending: '', sequence: 0 };
    this.states.set(key, state);

    if (normalized !== state.lastRaw) {
      const cumulative = !!state.lastRaw && normalized.startsWith(state.lastRaw);
      state.pending += cumulative ? normalized.slice(state.lastRaw.length) : normalized;
      state.lastRaw = normalized;
    }

    // Daemon-side validation intentionally remains strict even if an older
    // runner emits a partial forced chunk. Buffer it until the sentence-ending
    // fragment arrives, then post one coherent card.
    const chunk = selectCodexAppProgressChunk(state.pending, this.maxContentChars, false);
    if (!chunk) return null;
    state.pending = state.pending.slice(chunk.consumedChars);
    return { ...chunk, sequence: ++state.sequence };
  }
}

function progressTitleWidth(value: string): number {
  let width = 0;
  for (const ch of Array.from(value)) {
    width += /\p{Script=Han}/u.test(ch) ? 1 : 0.5;
  }
  return width;
}

export function codexAppProgressCardTitle(lastQuestion: string | undefined, maxWidth = 25): string {
  const normalized = (lastQuestion ?? '')
    .replace(/<user_message>\s*([\s\S]*?)\s*<\/user_message>/i, '$1')
    .replace(/\\([\[\]])/g, '$1')
    .replace(/\[(?:图片|文件)\s*\d+\]/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!normalized) return '进度更新';

  const limit = Math.max(1, maxWidth);
  if (progressTitleWidth(normalized) <= limit) return normalized;

  const ellipsis = '…';
  const contentLimit = limit - progressTitleWidth(ellipsis);
  let width = 0;
  const kept: string[] = [];
  for (const ch of Array.from(normalized)) {
    const next = /\p{Script=Han}/u.test(ch) ? 1 : 0.5;
    if (width + next > contentLimit) break;
    kept.push(ch);
    width += next;
  }
  // The ellipsis is part of the 25-Chinese-character visual budget. Keeping the latest user
  // question makes every progress card meaningful and stable within a turn.
  return kept.join('') + ellipsis;
}
