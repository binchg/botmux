export interface CodexAppHeartbeatSnapshot {
  turnId?: string;
  content: string;
  updatedAtMs: number;
}

export interface CodexAppHeartbeatOptions {
  intervalMs?: number;
}

const DEFAULT_INTERVAL_MS = 45_000;

function formatElapsed(elapsedMs: number): string {
  const seconds = Math.max(1, Math.round(elapsedMs / 1_000));
  if (seconds < 60) return `约 ${seconds} 秒`;
  const minutes = Math.max(1, Math.round(seconds / 60));
  return `约 ${minutes} 分钟`;
}

/**
 * Keeps long Codex App turns visible in Lark even while the model is blocked
 * inside a tool call and therefore cannot emit a commentary message itself.
 */
export class CodexAppHeartbeat {
  private readonly intervalMs: number;
  private readonly startedAtMs: number;
  private lastVisibleAtMs: number;

  constructor(startedAtMs: number, options: CodexAppHeartbeatOptions = {}) {
    this.startedAtMs = startedAtMs;
    this.lastVisibleAtMs = startedAtMs;
    this.intervalMs = options.intervalMs ?? DEFAULT_INTERVAL_MS;
  }

  noteVisibleProgress(nowMs: number): void {
    this.lastVisibleAtMs = nowMs;
  }

  maybeSnapshot(turnId: string | undefined, nowMs: number, activity?: string): CodexAppHeartbeatSnapshot | null {
    if (nowMs - this.lastVisibleAtMs < this.intervalMs) return null;
    this.lastVisibleAtMs = nowMs;
    const activityText = activity ? `，当前${activity}` : '';
    return {
      turnId,
      content: `任务仍在执行${activityText}，已持续${formatElapsed(nowMs - this.startedAtMs)}。`,
      updatedAtMs: nowMs,
    };
  }
}
