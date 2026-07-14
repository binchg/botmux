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

  it('asks the model for concise, verifiable phase decisions rather than hidden reasoning', () => {
    expect(source).toContain('正在做什么 + 已确认的关键决定/结果或等待原因');
    expect(source).toContain('不输出隐藏思维链');
  });

  it('starts a new progress epoch when busy follow-up guidance arrives', () => {
    expect(source).toContain('activeTurn.progress.resetTo(activeTurn.allAgentText)');
  });

  it('forwards structured item and hook lifecycles as activity markers', () => {
    expect(source).toContain("msg.method === 'hook/started' || msg.method === 'hook/completed'");
    expect(source).toContain("codexAppHookActivity(run, phase");
    expect(source).toContain("codexAppItemActivity(item, 'started'");
    expect(source).toContain("codexAppItemActivity(item, 'completed'");
    expect(source).toContain("emitMarker('activity'");
    expect(source).toContain('normalizeCodexAppTimestampMs');
  });
});
