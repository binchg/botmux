import { describe, expect, it } from 'vitest';
import { CodexAppHeartbeat } from '../src/services/codex-app-heartbeat.js';

describe('Codex App progress heartbeat', () => {
  it('emits after 45 seconds without user-visible progress', () => {
    const heartbeat = new CodexAppHeartbeat(1_000);
    heartbeat.startActivity({ id: 'command-1', label: '搜索代码', detail: 'worker.ts', startedAtMs: 5_000 });

    expect(heartbeat.maybeSnapshot('turn-1', 45_999)).toBeNull();
    expect(heartbeat.maybeSnapshot('turn-1', 46_000)).toEqual({
      turnId: 'turn-1',
      content: '正在执行：搜索代码（worker.ts）\n- 当前步骤已持续：约 41 秒\n- 本轮已持续：约 45 秒',
      updatedAtMs: 46_000,
    });
  });

  it('restarts the quiet interval after real progress and avoids rapid repeats', () => {
    const heartbeat = new CodexAppHeartbeat(0, { intervalMs: 1_000 });

    heartbeat.noteVisibleProgress(900);
    expect(heartbeat.maybeSnapshot('turn-2', 1_899)).toBeNull();
    expect(heartbeat.maybeSnapshot('turn-2', 1_900)?.content)
      .toBe('正在处理：模型分析与下一步决策\n- 当前步骤已持续：约 2 秒\n- 本轮已持续：约 2 秒');
    expect(heartbeat.maybeSnapshot('turn-2', 2_899)).toBeNull();
    expect(heartbeat.maybeSnapshot('turn-2', 2_900)?.content)
      .toContain('本轮已持续：约 3 秒');
  });

  it('uses minute-level elapsed text for long turns', () => {
    const heartbeat = new CodexAppHeartbeat(0, { intervalMs: 45_000 });
    expect(heartbeat.maybeSnapshot(undefined, 135_000)?.content)
      .toContain('本轮已持续：约 2 分钟');
  });

  it('uses the latest activity in the next throttled heartbeat', () => {
    const heartbeat = new CodexAppHeartbeat(0, { intervalMs: 1_000 });
    expect(heartbeat.maybeSnapshot('turn-3', 1_000)).not.toBeNull();
    heartbeat.startActivity({ id: 'hook-1', label: '运行 Codex Hook', detail: '工具完成后检查', startedAtMs: 1_500 });
    expect(heartbeat.maybeSnapshot('turn-3', 1_999)).toBeNull();
    expect(heartbeat.maybeSnapshot('turn-3', 2_000)?.content)
      .toContain('正在执行：运行 Codex Hook（工具完成后检查）');
  });
});
