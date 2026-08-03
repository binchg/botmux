/**
 * Codex App 会话标题生成器：在本地分配每日序号，并从 Botmux 首轮标题提取短摘要。
 * 该链路不调用模型，也不向用户 Prompt 注入标题指令。
 */
import {
  closeSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

const COUNTER_FILE = 'codex-app-title-sequence.json';
const LOCK_FILE = 'codex-app-title-sequence.lock';
const LOCK_STALE_MS = 30_000;
const LOCK_RETRY_MS = 10;
const LOCK_RETRY_LIMIT = 300;
const SUMMARY_MAX_CHARS = 24;
const lockWaitBuffer = new Int32Array(new SharedArrayBuffer(4));

interface CounterState {
  day: string;
  next: number;
}

interface DateParts {
  day: string;
  monthDay: string;
}

/** 按运行机器本地时区生成计数日期与标题中的月日。 */
function localDateParts(now: Date): DateParts {
  const year = String(now.getFullYear()).padStart(4, '0');
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  return { day: `${year}-${month}-${day}`, monthDay: `${month}${day}` };
}

/** 把首轮任务文本压缩成适合侧边栏展示的本地短标题。 */
export function summarizeCodexAppThreadTitle(rawTitle: string): string {
  const userMessage = /<user_message>\s*([\s\S]*?)\s*<\/user_message>/i.exec(rawTitle)?.[1] ?? rawTitle;
  const normalized = userMessage
    .replace(/<sender\b[^>]*>[\s\S]*?<\/sender>/gi, ' ')
    .replace(/<attachments\b[^>]*>[\s\S]*?<\/attachments>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/^\s*@\S+\s+/, '')
    .replace(/\s+/g, ' ')
    .trim();
  const firstClause = normalized.split(/[，,。！？!?；;]/, 1)[0]?.trim() || normalized;
  const shortened = Array.from(firstClause).slice(0, SUMMARY_MAX_CHARS).join('').trim();
  return shortened || '新会话';
}

/** 组合 `MMDDNN 中文摘要`，序号至少两位。 */
export function formatCodexAppThreadTitle(rawTitle: string, sequence: number, now = new Date()): string {
  const { monthDay } = localDateParts(now);
  const serial = String(Math.max(0, Math.trunc(sequence))).padStart(2, '0');
  return `${monthDay}${serial} ${summarizeCodexAppThreadTitle(rawTitle)}`;
}

/** 短暂等待同机其它 Botmux daemon 释放原子计数锁。 */
function waitForLock(): void {
  try { Atomics.wait(lockWaitBuffer, 0, 0, LOCK_RETRY_MS); } catch { /* 旧运行时无 SharedArrayBuffer 时直接重试 */ }
}

/** 获取跨 daemon 的独占锁；陈旧锁可在 30 秒后自动回收。 */
function acquireCounterLock(lockPath: string): number {
  for (let attempt = 0; attempt < LOCK_RETRY_LIMIT; attempt += 1) {
    try {
      return openSync(lockPath, 'wx', 0o600);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      try {
        if (Date.now() - statSync(lockPath).mtimeMs > LOCK_STALE_MS) unlinkSync(lockPath);
      } catch { /* 锁可能刚被其它进程释放 */ }
      waitForLock();
    }
  }
  throw new Error('Codex App 标题序号锁等待超时');
}

/** 读取计数状态；空文件或旧格式按当日首个会话处理。 */
function readCounterState(path: string): CounterState | undefined {
  try {
    const value = JSON.parse(readFileSync(path, 'utf8')) as Partial<CounterState>;
    if (typeof value.day === 'string' && Number.isInteger(value.next) && Number(value.next) > 0) {
      return { day: value.day, next: Number(value.next) };
    }
  } catch { /* 首次运行或损坏状态由下一次原子写覆盖 */ }
  return undefined;
}

/**
 * 原子分配一个当天序号并返回完整标题。
 * 调用方应把结果持久化到 Session，确保 worker 重启复用同一个标题。
 */
export function allocateCodexAppThreadTitle(rawTitle: string, dataDir: string, now = new Date()): string {
  mkdirSync(dataDir, { recursive: true });
  const statePath = join(dataDir, COUNTER_FILE);
  const lockPath = join(dataDir, LOCK_FILE);
  const lockFd = acquireCounterLock(lockPath);
  try {
    const { day } = localDateParts(now);
    const state = readCounterState(statePath);
    const sequence = state?.day === day ? state.next : 1;
    const tmpPath = `${statePath}.${process.pid}.${randomUUID()}.tmp`;
    writeFileSync(tmpPath, `${JSON.stringify({ day, next: sequence + 1 }, null, 2)}\n`, { mode: 0o600 });
    renameSync(tmpPath, statePath);
    return formatCodexAppThreadTitle(rawTitle, sequence, now);
  } finally {
    closeSync(lockFd);
    try { unlinkSync(lockPath); } catch { /* 锁已被外部清理时无需重复失败 */ }
  }
}
