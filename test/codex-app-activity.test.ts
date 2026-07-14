import { describe, expect, it } from 'vitest';
import { codexAppHookActivity, codexAppItemActivity, normalizeCodexAppTimestampMs } from '../src/services/codex-app-activity.js';

describe('Codex App activity formatter', () => {
  it('turns structured command actions into safe, concrete progress', () => {
    expect(codexAppItemActivity({
      type: 'commandExecution',
      id: 'cmd-1',
      command: 'rg secret .',
      commandActions: [{ type: 'search', query: 'CodexAppHeartbeat', path: '/repo/src/worker.ts' }],
      status: 'inProgress',
      durationMs: null,
    }, 'started', 1_000)).toEqual({
      phase: 'started',
      id: 'item:cmd-1',
      label: '搜索代码',
      detail: 'CodexAppHeartbeat · worker.ts',
      atMs: 1_000,
      durationMs: undefined,
      status: 'inProgress',
    });
  });

  it('never forwards raw command arguments and redacts status secrets', () => {
    const command = codexAppItemActivity({
      type: 'commandExecution',
      id: 'cmd-2',
      command: 'curl -H authorization=super-secret-value https://example.com',
      commandActions: [{ type: 'unknown', command: 'curl -H authorization=super-secret-value' }],
    }, 'started', 2_000);
    expect(command?.detail).toBe('curl');

    const hook = codexAppHookActivity({
      id: 'hook-1',
      eventName: 'postToolUse',
      statusMessage: 'token=super-secret-value',
      source: 'project',
      status: 'running',
    }, 'started', 3_000);
    expect(hook?.detail).toBe('工具完成后检查 · token=[已脱敏] · project');
    expect(hook?.detail).not.toContain('super-secret-value');
  });

  it('describes hook and collaboration waits explicitly', () => {
    expect(codexAppHookActivity({
      id: 'hook-2',
      eventName: 'stop',
      source: 'user',
      status: 'running',
    }, 'started', 4_000)).toMatchObject({
      label: '运行 Codex Hook',
      detail: '任务结束检查 · user',
    });
    expect(codexAppItemActivity({
      type: 'collabAgentToolCall',
      id: 'collab-1',
      tool: 'wait',
      status: 'inProgress',
    }, 'started', 5_000)).toMatchObject({ label: '等待子 Agent' });
  });

  it('normalizes app-server seconds without changing millisecond timestamps', () => {
    expect(normalizeCodexAppTimestampMs(1_784_005_480)).toBe(1_784_005_480_000);
    expect(normalizeCodexAppTimestampMs(1_784_005_480_123)).toBe(1_784_005_480_123);
  });
});
