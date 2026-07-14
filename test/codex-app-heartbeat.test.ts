import { describe, expect, it } from 'vitest';
import { CodexAppHeartbeat } from '../src/services/codex-app-heartbeat.js';

describe('Codex App background activity progress', () => {
  it('emits one factual tool stage after 30 seconds without user-visible progress', () => {
    const heartbeat = new CodexAppHeartbeat(1_000);
    heartbeat.startActivity({ id: 'command-1', label: '搜索代码', detail: 'worker.ts', startedAtMs: 5_000 });

    expect(heartbeat.maybeSnapshot('turn-1', 30_999)).toBeNull();
    expect(heartbeat.maybeSnapshot('turn-1', 31_000)).toEqual({
      turnId: 'turn-1',
      content: '正在执行：搜索代码 worker.ts。',
      updatedAtMs: 31_000,
    });
  });

  it('restarts the quiet interval after real progress and never repeats the same stage', () => {
    const heartbeat = new CodexAppHeartbeat(0, { intervalMs: 1_000 });
    heartbeat.startActivity({ id: 'command-1', label: '检查代码', startedAtMs: 500 });

    heartbeat.noteVisibleProgress(900, '已完成建档，正在核对 Hook 与 Harness。');
    expect(heartbeat.maybeSnapshot('turn-2', 1_899)).toBeNull();
    expect(heartbeat.maybeSnapshot('turn-2', 1_900)?.content)
      .toBe('正在执行：检查代码。');
    expect(heartbeat.maybeSnapshot('turn-2', 2_899)).toBeNull();
    expect(heartbeat.maybeSnapshot('turn-2', 2_900)).toBeNull();
  });

  it('does not emit timer-only updates when no concrete activity is running', () => {
    const heartbeat = new CodexAppHeartbeat(0, { intervalMs: 45_000 });
    expect(heartbeat.maybeSnapshot(undefined, 135_000)).toBeNull();
  });

  it('uses the latest activity in the next throttled background update', () => {
    const heartbeat = new CodexAppHeartbeat(0, { intervalMs: 1_000 });
    heartbeat.startActivity({ id: 'initial', label: '检查代码', startedAtMs: 500 });
    expect(heartbeat.maybeSnapshot('turn-3', 1_000)).not.toBeNull();
    heartbeat.startActivity({ id: 'hook-1', label: '运行 Codex Hook', detail: '工具完成后检查', startedAtMs: 1_500 });
    expect(heartbeat.maybeSnapshot('turn-3', 1_999)).toBeNull();
    expect(heartbeat.maybeSnapshot('turn-3', 2_000)?.content)
      .toBe('正在执行：运行 Codex Hook 工具完成后检查。');
  });

  it('keeps the current activity short and omits elapsed time', () => {
    const heartbeat = new CodexAppHeartbeat(0, { intervalMs: 1_000 });
    heartbeat.startActivity({ id: 'long', label: '执行命令', detail: '很长的说明'.repeat(30), startedAtMs: 1 });
    const content = heartbeat.currentSnapshot('turn-4', 500).content;
    expect(content.split('\n')).toHaveLength(1);
    expect(content).toContain('正在执行：执行命令');
    expect(content).not.toMatch(/秒|分钟|耗时/);
    expect(content.length).toBeLessThan(120);
  });
});
