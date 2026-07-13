import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('codex-app runner steering', () => {
  const source = readFileSync(join(process.cwd(), 'src/codex-app-runner.ts'), 'utf8');

  it('uses app-server turn/steer for busy follow-up guidance', () => {
    expect(source).toContain("client.request('turn/steer'");
    expect(source).toContain('expectedTurnId');
    expect(source).toContain('input: userTextInput(content)');
  });

  it('falls back to next-turn queueing when steering is unavailable', () => {
    expect(source).toContain('pendingSteers');
    expect(source).toContain('steer failed, queued as next turn');
    expect(source).toContain('queuePendingSteersAsNextTurns(turn)');
  });

  it('ticks progress independently from app-server delta arrival', () => {
    expect(source).toContain('const PROGRESS_TICK_MS = 250');
    expect(source).toContain('turn.progressTimer = setInterval');
    expect(source).toContain('clearInterval(turn.progressTimer)');
  });

  it('falls back to a user-visible heartbeat during long tool calls', () => {
    expect(source).toContain('heartbeat: new CodexAppHeartbeat(startedAtMs)');
    expect(source).toContain('turn.heartbeat.noteVisibleProgress(nowMs)');
    expect(source).toContain('turn.heartbeat.maybeSnapshot(turn.turnId, nowMs, turn.activity)');
  });

  it('starts a new progress epoch when busy follow-up guidance arrives', () => {
    expect(source).toContain('activeTurn.progress.resetTo(activeTurn.allAgentText)');
  });
});
