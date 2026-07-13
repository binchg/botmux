import { describe, expect, it } from 'vitest';
import { CodexAppHeartbeat } from '../src/services/codex-app-heartbeat.js';

describe('Codex App progress heartbeat', () => {
  it('emits after 45 seconds without user-visible progress', () => {
    const heartbeat = new CodexAppHeartbeat(1_000);

    expect(heartbeat.maybeSnapshot('turn-1', 45_999, '执行命令')).toBeNull();
    expect(heartbeat.maybeSnapshot('turn-1', 46_000, '执行命令')).toEqual({
      turnId: 'turn-1',
      content: '任务仍在执行，当前执行命令，已持续约 45 秒。',
      updatedAtMs: 46_000,
    });
  });

  it('restarts the quiet interval after real progress and avoids rapid repeats', () => {
    const heartbeat = new CodexAppHeartbeat(0, { intervalMs: 1_000 });

    heartbeat.noteVisibleProgress(900);
    expect(heartbeat.maybeSnapshot('turn-2', 1_899)).toBeNull();
    expect(heartbeat.maybeSnapshot('turn-2', 1_900)?.content)
      .toBe('任务仍在执行，已持续约 2 秒。');
    expect(heartbeat.maybeSnapshot('turn-2', 2_899)).toBeNull();
    expect(heartbeat.maybeSnapshot('turn-2', 2_900)?.content)
      .toBe('任务仍在执行，已持续约 3 秒。');
  });

  it('uses minute-level elapsed text for long turns', () => {
    const heartbeat = new CodexAppHeartbeat(0, { intervalMs: 45_000 });
    expect(heartbeat.maybeSnapshot(undefined, 135_000)?.content)
      .toBe('任务仍在执行，已持续约 2 分钟。');
  });
});
