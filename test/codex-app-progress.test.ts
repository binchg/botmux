import { describe, expect, it } from 'vitest';
import {
  CodexAppProgressForwarder,
  CodexAppProgressThrottler,
  normalizeCodexAppProgressText,
  selectCodexAppProgressChunk,
} from '../src/services/codex-app-progress.js';

describe('Codex App progress throttling', () => {
  it('waits for a natural sentence boundary before the first progress card', () => {
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
      text: '我先看下，',
      startedAtMs: 100,
      nowMs: 202,
    })).toMatchObject({
      turnId: 'turn-1',
      content: '我先看下，',
      startedAtMs: 100,
      updatedAtMs: 202,
    });
  });

  it('emits incremental progress every interval regardless of added length', () => {
    const throttler = new CodexAppProgressThrottler({
      minInitialChars: 5,
      minIntervalMs: 1_000,
      minDeltaChars: 0,
    });

    expect(throttler.maybeSnapshot({ text: 'hello,', startedAtMs: 0, nowMs: 10 })?.content).toBe('hello,');
    expect(throttler.maybeSnapshot({
      text: 'hello, ok.',
      startedAtMs: 0,
      nowMs: 30,
    })).toBeNull();
    expect(throttler.maybeSnapshot({
      text: 'hello, ok.',
      startedAtMs: 0,
      nowMs: 1_020,
    })?.content).toBe('ok.');
  });

  it('falls back within one second, then limits live progress to every three seconds', () => {
    const throttler = new CodexAppProgressThrottler();

    expect(throttler.maybeSnapshot({
      text: 'first,',
      startedAtMs: 0,
      nowMs: 10,
    })?.content).toBe('first,');
    expect(throttler.maybeSnapshot({
      text: 'first, second,',
      startedAtMs: 0,
      nowMs: 2_999,
    })).toBeNull();
    expect(throttler.maybeSnapshot({
      text: 'first, second,',
      startedAtMs: 0,
      nowMs: 3_010,
    })?.content).toBe('second,');
  });

  it('forces a first progress snapshot after the interval even without punctuation', () => {
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
    })?.content).toBe('checking repository state');
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

  it('normalizes and keeps long progress text within a natural prefix', () => {
    const text = normalizeCodexAppProgressText(`first,\r\n\r\n\r\nsecond sentence. ${'x'.repeat(30)}`, 20);
    expect(text).toBe('first,');
  });

  it('splits progress on punctuation so the next card starts after the separator', () => {
    const throttler = new CodexAppProgressThrottler({
      minIntervalMs: 1_000,
      maxContentChars: 5,
    });

    expect(throttler.maybeSnapshot({
      text: '第一句，第二句，第三句。',
      startedAtMs: 0,
      nowMs: 1,
    })?.content).toBe('第一句，');
    expect(throttler.maybeSnapshot({
      text: '第一句，第二句，第三句。',
      startedAtMs: 0,
      nowMs: 1_010,
    })?.content).toBe('第二句，');
    expect(throttler.maybeSnapshot({
      text: '第一句，第二句，第三句。',
      startedAtMs: 0,
      nowMs: 2_020,
    })?.content).toBe('第三句。');
  });

  it('returns chunk length metadata including skipped leading whitespace', () => {
    expect(selectCodexAppProgressChunk('\n\n下一句。', 20)).toEqual({
      content: '下一句。',
      consumedChars: 6,
    });
  });

  it('falls back to the hard mobile limit when no punctuation exists before the limit', () => {
    const chunk = selectCodexAppProgressChunk('abcdefghij klmnopqrstuvwxyz。', 10);
    expect(chunk?.content.length).toBeLessThanOrEqual(10);
    expect(chunk?.content).toBe('abcdefghij');
  });

  it('forwards legacy cumulative progress as incremental chunks', () => {
    const forwarder = new CodexAppProgressForwarder({ maxContentChars: 5 });

    expect(forwarder.next('turn-1', '第一句，第二句，')?.content).toBe('第一句，');
    expect(forwarder.next('turn-1', '第一句，第二句，第三句。')?.content).toBe('第二句，');
    expect(forwarder.next('turn-1', '第一句，第二句，第三句。')?.content).toBe('第三句。');
    expect(forwarder.next('turn-1', '第一句，第二句，第三句。')).toBeNull();
  });

  it('keeps already-incremental progress chunks from the new runner', () => {
    const forwarder = new CodexAppProgressForwarder({ maxContentChars: 5 });

    expect(forwarder.next('turn-1', '第一句，')?.content).toBe('第一句，');
    expect(forwarder.next('turn-1', '第二句，')?.content).toBe('第二句，');
  });

  it('forwards runner-throttled chunks even when they have no punctuation', () => {
    const forwarder = new CodexAppProgressForwarder();

    expect(forwarder.next('turn-1', 'checking repository state')?.content)
      .toBe('checking repository state');
  });
});
