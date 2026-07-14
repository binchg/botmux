import { describe, expect, it } from 'vitest';
import { CodexAppHeartbeat } from '../src/services/codex-app-heartbeat.js';

describe('Codex App progress heartbeat', () => {
  it('emits one compact line after 30 seconds without user-visible progress', () => {
    const heartbeat = new CodexAppHeartbeat(1_000);
    heartbeat.startActivity({ id: 'command-1', label: '搜索代码', detail: 'worker.ts', startedAtMs: 5_000 });

    expect(heartbeat.maybeSnapshot('turn-1', 30_999)).toBeNull();
    expect(heartbeat.maybeSnapshot('turn-1', 31_000)).toEqual({
      turnId: 'turn-1',
      content: '正在执行：搜索代码 worker.ts｜本轮约 30 秒。',
      updatedAtMs: 31_000,
    });
  });

  it('restarts the quiet interval after real progress and avoids rapid repeats', () => {
    const heartbeat = new CodexAppHeartbeat(0, { intervalMs: 1_000 });

    heartbeat.noteVisibleProgress(900, '已完成建档，正在核对 Hook 与 Harness。');
    expect(heartbeat.maybeSnapshot('turn-2', 1_899)).toBeNull();
    expect(heartbeat.maybeSnapshot('turn-2', 1_900)?.content)
      .toBe('正在执行：分析问题｜进展：已完成建档，正在核对 Hook 与 Harness｜本轮约 2 秒。');
    expect(heartbeat.maybeSnapshot('turn-2', 2_899)).toBeNull();
    expect(heartbeat.maybeSnapshot('turn-2', 2_900)?.content)
      .toContain('本轮约 3 秒');
  });

  it('uses minute-level elapsed text for long turns', () => {
    const heartbeat = new CodexAppHeartbeat(0, { intervalMs: 45_000 });
    expect(heartbeat.maybeSnapshot(undefined, 135_000)?.content)
      .toContain('本轮约 2 分钟');
  });

  it('uses the latest activity in the next throttled heartbeat', () => {
    const heartbeat = new CodexAppHeartbeat(0, { intervalMs: 1_000 });
    expect(heartbeat.maybeSnapshot('turn-3', 1_000)).not.toBeNull();
    heartbeat.startActivity({ id: 'hook-1', label: '运行 Codex Hook', detail: '工具完成后检查', startedAtMs: 1_500 });
    expect(heartbeat.maybeSnapshot('turn-3', 1_999)).toBeNull();
    expect(heartbeat.maybeSnapshot('turn-3', 2_000)?.content)
      .toContain('正在执行：运行 Codex Hook 工具完成后检查');
  });

  it('keeps assistant decisions short and on the same line as total elapsed time', () => {
    const heartbeat = new CodexAppHeartbeat(0, { intervalMs: 1_000 });
    heartbeat.noteVisibleProgress(500, `关键决策：${'很长的说明'.repeat(30)}`);
    const content = heartbeat.currentSnapshot('turn-4', 500).content;
    expect(content.split('\n')).toHaveLength(1);
    expect(content).toContain('正在执行：分析问题｜进展：关键决策：');
    expect(content).toContain('｜本轮约 1 秒');
    expect(content.length).toBeLessThan(120);
  });
});
