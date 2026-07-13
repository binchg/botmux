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

  it('starts a fresh progress epoch after mid-turn user guidance', () => {
    const throttler = new CodexAppProgressThrottler();
    expect(throttler.maybeSnapshot({
      turnId: 'turn-steer',
      text: '正在检查旧问题。',
      startedAtMs: 0,
      nowMs: 1,
    })?.content).toBe('正在检查旧问题。');

    throttler.resetTo('正在检查旧问题。');
    expect(throttler.maybeSnapshot({
      turnId: 'turn-steer',
      text: '正在检查旧问题。已收到新的补充要求。',
      startedAtMs: 0,
      nowMs: 2,
    })?.content).toBe('已收到新的补充要求。');
  });

  it('normalizes and keeps a complete long sentence beyond the soft limit', () => {
    const text = normalizeCodexAppProgressText(`first,\r\n\r\n\r\nsecond sentence. ${'x'.repeat(30)}`, 20);
    expect(text).toBe('first,\nsecond sentence.');
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

  it('drops a detached leading tail through the next full stop', () => {
    const raw = ')，不再只回复当前旧话题。这个动作需要 botmux-send 的顶层消息。';
    const chunk = selectCodexAppProgressChunk(raw, 240);

    expect(chunk?.content).toBe('这个动作需要 botmux-send 的顶层消息。');
    expect(raw.slice(chunk?.consumedChars)).toBe('');
  });

  it('uses a comma as the weakest recovery boundary for a detached beginning', () => {
    expect(selectCodexAppProgressChunk('），还在检查原因，下一步核对发送日志。', 240)?.content)
      .toBe('下一步核对发送日志。');
  });

  it('buffers a detached beginning until a safe recovery boundary appears', () => {
    expect(selectCodexAppProgressChunk('），仍在检查这段内容。', 240)).toBeNull();
  });

  it('keeps a long sentence intact instead of hard-splitting at the soft card limit', () => {
    const chunk = selectCodexAppProgressChunk('abcdefghij klmnopqrstuvwxyz。', 10);
    expect(chunk?.content).toBe('abcdefghij klmnopqrstuvwxyz。');
  });

  it('keeps exactly one complete sentence per card without blank lines', () => {
    expect(selectCodexAppProgressChunk('第一句。\n\n第二句。', 240)?.content).toBe('第一句。');
    const forwarder = new CodexAppProgressForwarder();
    expect(forwarder.drain('turn-one-sentence', '第一句。\n\n第二句。').map(item => item.content))
      .toEqual(['第一句。', '第二句。']);
  });

  it('drains multiple completed runner sentences immediately as separate snapshots', () => {
    const throttler = new CodexAppProgressThrottler({ minIntervalMs: 10_000 });
    expect(throttler.drainSnapshots({
      turnId: 'turn-drain',
      text: '版本根因已经定位。接下来增加自动版本并在 push 后部署。',
      startedAtMs: 0,
      nowMs: 1,
    }).map(item => item.content)).toEqual([
      '版本根因已经定位。',
      '接下来增加自动版本并在 push 后部署。',
    ]);
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

  it('drops a pending partial sentence when the visible turn is reset', () => {
    const forwarder = new CodexAppProgressForwarder();
    expect(forwarder.next('turn-steer', '旧的半句')).toBeNull();

    forwarder.reset();
    expect(forwarder.next('turn-steer', '补充后的完整进度。')?.content)
      .toBe('补充后的完整进度。');
  });

  it('realigns a legacy runner chunk that starts inside the previous sentence', () => {
    const forwarder = new CodexAppProgressForwarder();

    expect(forwarder.next('turn-1', ')，不再只回复当前旧话题。这个动作需要顶层消息。')?.content)
      .toBe('这个动作需要顶层消息。');
  });

  it('realigns after a forced runner snapshot ended mid-sentence', () => {
    const throttler = new CodexAppProgressThrottler({ minIntervalMs: 1 });

    expect(throttler.maybeSnapshot({
      text: '收到，完成后在同一个话题群发新话题，并真实 @ 你（open_id `ou_641',
      startedAtMs: 0,
      nowMs: 1,
      force: true,
    })?.content).toContain('open_id');
    expect(throttler.maybeSnapshot({
      text: '收到，完成后在同一个话题群发新话题，并真实 @ 你（open_id `ou_641`），不再只回复当前旧话题。这个动作需要顶层消息。',
      startedAtMs: 0,
      nowMs: 2,
    })?.content).toBe('这个动作需要顶层消息。');
  });

  it('uses the latest question with a 25-Chinese-character visual budget', () => {
    expect(codexAppProgressCardTitle('可以了，再试试 \\[图片 1\\]')).toBe('可以了，再试试');
    expect(codexAppProgressCardTitle('[图片 1]\n还是有 badcase，标题不对')).toBe('还是有 badcase，标题不对');
    const title = codexAppProgressCardTitle('这是一个需要持续排查并修复所有仓库问题的很长提问补充内容');
    expect(Array.from(title).filter(ch => /\p{Script=Han}/u.test(ch))).toHaveLength(24);
    expect(title.endsWith('…')).toBe(true);
    expect(codexAppProgressCardTitle('a'.repeat(60))).toBe(`${'a'.repeat(49)}…`);
    expect(codexAppProgressCardTitle('标题' + 'a'.repeat(46) + '额外')).toBe(`标题${'a'.repeat(45)}…`);
    expect(codexAppProgressCardTitle('第一行\n第二行')).toBe('第一行 第二行');
    expect(codexAppProgressCardTitle(undefined)).toBe('进度更新');
  });
});
