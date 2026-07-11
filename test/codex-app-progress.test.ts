import { describe, expect, it } from 'vitest';
import {
  CodexAppProgressForwarder,
  CodexAppProgressThrottler,
  codexAppProgressCardTitle,
  normalizeCodexAppProgressText,
  selectCodexAppProgressChunk,
} from '../src/services/codex-app-progress.js';

describe('Codex App progress throttling', () => {
  it('waits for a complete sentence boundary before the first progress card', () => {
    const throttler = new CodexAppProgressThrottler();

    expect(throttler.maybeSnapshot({
      text: '   ',
      startedAtMs: 100,
      nowMs: 200,
    })).toBeNull();

    expect(throttler.maybeSnapshot({
      turnId: 'turn-1',
      text: '我',
      startedAtMs: 100,
      nowMs: 201,
    })).toBeNull();

    expect(throttler.maybeSnapshot({
      turnId: 'turn-1',
      text: '我先看下，马上处理',
      startedAtMs: 100,
      nowMs: 202,
    })).toBeNull();

    expect(throttler.maybeSnapshot({
      turnId: 'turn-1',
      text: '我先看下，马上处理。',
      startedAtMs: 100,
      nowMs: 203,
    })).toMatchObject({
      turnId: 'turn-1',
      content: '我先看下，马上处理。',
      startedAtMs: 100,
      updatedAtMs: 203,
    });
  });

  it('emits incremental progress every interval regardless of added length', () => {
    const throttler = new CodexAppProgressThrottler({
      minInitialChars: 5,
      minIntervalMs: 1_000,
      minDeltaChars: 0,
    });

    expect(throttler.maybeSnapshot({ text: 'hello.', startedAtMs: 0, nowMs: 10 })?.content).toBe('hello.');
    expect(throttler.maybeSnapshot({
      text: 'hello. ok.',
      startedAtMs: 0,
      nowMs: 30,
    })).toBeNull();
    expect(throttler.maybeSnapshot({
      text: 'hello. ok.',
      startedAtMs: 0,
      nowMs: 1_020,
    })?.content).toBe('ok.');
  });

  it('falls back within one second, then limits live progress to every three seconds', () => {
    const throttler = new CodexAppProgressThrottler();

    expect(throttler.maybeSnapshot({
      text: 'first item.',
      startedAtMs: 0,
      nowMs: 10,
    })?.content).toBe('first item.');
    expect(throttler.maybeSnapshot({
      text: 'first item. second item.',
      startedAtMs: 0,
      nowMs: 2_999,
    })).toBeNull();
    expect(throttler.maybeSnapshot({
      text: 'first item. second item.',
      startedAtMs: 0,
      nowMs: 3_010,
    })?.content).toBe('second item.');
  });

  it('does not force an unfinished sentence after the initial fallback interval', () => {
    const throttler = new CodexAppProgressThrottler();

    expect(throttler.maybeSnapshot({
      text: 'checking repository state',
      startedAtMs: 100,
      nowMs: 999,
    })).toBeNull();
    expect(throttler.maybeSnapshot({
      text: 'checking repository state',
      startedAtMs: 100,
      nowMs: 1_100,
    })).toBeNull();
    expect(throttler.maybeSnapshot({
      text: 'checking repository state.',
      startedAtMs: 100,
      nowMs: 1_101,
    })?.content).toBe('checking repository state.');
  });

  it('does not let forced completed-stage snapshots bypass the interval', () => {
    const throttler = new CodexAppProgressThrottler({
      minInitialChars: 5,
      minIntervalMs: 10_000,
      minDeltaChars: 0,
    });

    expect(throttler.maybeSnapshot({ text: 'hello world.', startedAtMs: 0, nowMs: 10 })).not.toBeNull();
    expect(throttler.maybeSnapshot({
      text: 'hello world. completed non-final item.',
      startedAtMs: 0,
      nowMs: 20,
      force: true,
    })).toBeNull();
    expect(throttler.maybeSnapshot({
      text: 'hello world. completed.',
      startedAtMs: 0,
      nowMs: 10_020,
      force: true,
    })?.content).toBe('completed.');
  });

  it('normalizes and keeps a complete long sentence beyond the soft limit', () => {
    const text = normalizeCodexAppProgressText(`first,\r\n\r\n\r\nsecond sentence. ${'x'.repeat(30)}`, 20);
    expect(text).toBe('first,\n\nsecond sentence.');
  });

  it('does not split clauses at commas and emits the complete sentence', () => {
    const throttler = new CodexAppProgressThrottler({
      minIntervalMs: 1_000,
      maxContentChars: 5,
    });

    expect(throttler.maybeSnapshot({
      text: '第一句，第二句，第三句。',
      startedAtMs: 0,
      nowMs: 1,
    })?.content).toBe('第一句，第二句，第三句。');
    expect(throttler.maybeSnapshot({
      text: '第一句，第二句，第三句。',
      startedAtMs: 0,
      nowMs: 1_010,
    })).toBeNull();
  });

  it('does not treat headings, newlines, or semicolons as a finished sentence', () => {
    expect(selectCodexAppProgressChunk('入口\n我正在检查；尚未完成', 240)).toBeNull();
    expect(selectCodexAppProgressChunk('入口\n我正在检查；已经完成。', 240)?.content)
      .toBe('入口\n我正在检查；已经完成。');
  });

  it('keeps a closing quote attached to the complete sentence', () => {
    expect(selectCodexAppProgressChunk('他说“已经完成。”下一句。', 6)?.content)
      .toBe('他说“已经完成。”');
  });

  it('returns chunk length metadata including skipped leading whitespace', () => {
    expect(selectCodexAppProgressChunk('\n\n下一句。', 20)).toEqual({
      content: '下一句。',
      consumedChars: 6,
    });
  });

  it('keeps a long sentence intact instead of hard-splitting at the soft card limit', () => {
    const chunk = selectCodexAppProgressChunk('abcdefghij klmnopqrstuvwxyz。', 10);
    expect(chunk?.content).toBe('abcdefghij klmnopqrstuvwxyz。');
  });

  it('forwards legacy cumulative progress as incremental chunks', () => {
    const forwarder = new CodexAppProgressForwarder({ maxContentChars: 5 });

    expect(forwarder.next('turn-1', '第一句。第二句。')?.content).toBe('第一句。');
    expect(forwarder.next('turn-1', '第一句。第二句。第三句。')?.content).toBe('第二句。');
    expect(forwarder.next('turn-1', '第一句。第二句。第三句。')?.content).toBe('第三句。');
    expect(forwarder.next('turn-1', '第一句。第二句。第三句。')).toBeNull();
  });

  it('keeps already-incremental progress chunks from the new runner', () => {
    const forwarder = new CodexAppProgressForwarder({ maxContentChars: 5 });

    expect(forwarder.next('turn-1', '第一句。')?.content).toBe('第一句。');
    expect(forwarder.next('turn-1', '第二句。')?.content).toBe('第二句。');
  });

  it('buffers legacy partial chunks until they form a complete sentence', () => {
    const forwarder = new CodexAppProgressForwarder();

    expect(forwarder.next('turn-1', '我')).toBeNull();
    expect(forwarder.next('turn-1', '正在检查原因。')?.content).toBe('我正在检查原因。');
  });

  it('uses a fixed short single-line node title', () => {
    expect(codexAppProgressCardTitle(1)).toBe('进度节点 1');
    expect(codexAppProgressCardTitle(9999).length).toBeLessThanOrEqual(10);
  });
});
