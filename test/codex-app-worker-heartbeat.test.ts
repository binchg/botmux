import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('Codex App worker background progress integration', () => {
  const source = readFileSync(join(process.cwd(), 'src/worker.ts'), 'utf8');
  const daemonSource = readFileSync(join(process.cwd(), 'src/core/worker-pool.ts'), 'utf8');

  it('starts at the actual PTY turn and emits independently from runner deltas', () => {
    expect(source).toContain('currentBotmuxTurnId = item.turnId;\n      beginCodexAppHeartbeat();');
    expect(source).toContain('maybeEmitCodexAppHeartbeat(status);');
  });

  it('resets after visible progress and stops at final or idle', () => {
    expect(source).toContain('noteCodexAppVisibleProgress(');
    expect(source).toContain('clearCodexAppHeartbeat();');
    expect(source).toContain("if (!codexAppHeartbeat || status === 'idle') return;");
  });

  it('tracks app-server activities and marks background activity separately from assistant progress', () => {
    expect(source).toContain("if (kind === 'activity' && typeof payload.id === 'string')");
    expect(source).toContain("kind: 'activity'");
    expect(source).toContain("kind: 'assistant'");
    expect(source).toContain('const turnId = codexAppProgressTurnId ?? currentBotmuxTurnId');
    expect(source).toContain('normalizeCodexAppTimestampMs(payload.atMs)');
    expect(source).toContain('ensureCodexAppHeartbeat(');
    expect(source).toContain('codexAppProgressTurnId');
  });

  it('keeps automatic stages internal and posts only real assistant progress', () => {
    expect(daemonSource).toContain("msg.kind === 'heartbeat' || msg.kind === 'activity'");
    expect(daemonSource).toContain('only AI assistant progress is posted');
  });
});
