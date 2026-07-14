import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('Codex App worker progress heartbeat integration', () => {
  const source = readFileSync(join(process.cwd(), 'src/worker.ts'), 'utf8');

  it('starts at the actual PTY turn and emits independently from runner deltas', () => {
    expect(source).toContain('currentBotmuxTurnId = item.turnId;\n      beginCodexAppHeartbeat();');
    expect(source).toContain('maybeEmitCodexAppHeartbeat(status);');
  });

  it('resets after visible progress and stops at final or idle', () => {
    expect(source).toContain('noteCodexAppVisibleProgress(');
    expect(source).toContain('clearCodexAppHeartbeat();');
    expect(source).toContain("if (!codexAppHeartbeat || status === 'idle') return;");
  });

  it('tracks app-server activities and marks heartbeats separately from assistant progress', () => {
    expect(source).toContain("if (kind === 'activity' && typeof payload.id === 'string')");
    expect(source).toContain("kind: 'heartbeat'");
    expect(source).toContain("kind: 'assistant'");
    expect(source).toContain('const turnId = currentBotmuxTurnId');
    expect(source).toContain('normalizeCodexAppTimestampMs(payload.atMs)');
  });
});
