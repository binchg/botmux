export interface CodexAppHeartbeatSnapshot {
  turnId?: string;
  content: string;
  updatedAtMs: number;
}

export interface CodexAppHeartbeatOptions {
  intervalMs?: number;
}

export interface CodexAppHeartbeatActivity {
  id: string;
  label: string;
  detail?: string;
  startedAtMs: number;
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
  private lastSnapshotAtMs = 0;
  private phaseStartedAtMs: number;
  private readonly activities = new Map<string, CodexAppHeartbeatActivity>();

  constructor(startedAtMs: number, options: CodexAppHeartbeatOptions = {}) {
    this.startedAtMs = startedAtMs;
    this.lastVisibleAtMs = startedAtMs;
    this.phaseStartedAtMs = startedAtMs;
    this.intervalMs = options.intervalMs ?? DEFAULT_INTERVAL_MS;
  }

  noteVisibleProgress(nowMs: number): void {
    this.lastVisibleAtMs = nowMs;
  }

  startActivity(activity: CodexAppHeartbeatActivity): void {
    this.activities.set(activity.id, activity);
    this.phaseStartedAtMs = activity.startedAtMs;
  }

  completeActivity(id: string, completedAtMs: number): void {
    if (!this.activities.delete(id)) return;
    const current = this.currentActivity();
    this.phaseStartedAtMs = current?.startedAtMs ?? completedAtMs;
  }

  maybeSnapshot(turnId: string | undefined, nowMs: number): CodexAppHeartbeatSnapshot | null {
    if (nowMs - this.lastVisibleAtMs < this.intervalMs) return null;
    if (this.lastSnapshotAtMs > 0 && nowMs - this.lastSnapshotAtMs < this.intervalMs) return null;
    return this.snapshot(turnId, nowMs);
  }

  private currentActivity(): CodexAppHeartbeatActivity | undefined {
    return [...this.activities.values()].sort((a, b) => b.startedAtMs - a.startedAtMs)[0];
  }

  private snapshot(turnId: string | undefined, nowMs: number): CodexAppHeartbeatSnapshot {
    this.lastSnapshotAtMs = nowMs;
    const activity = this.currentActivity();
    const headline = activity
      ? `正在执行：${activity.label}${activity.detail ? `（${activity.detail}）` : ''}`
      : '正在处理：模型分析与下一步决策';
    return {
      turnId,
      content: `${headline}\n- 当前步骤已持续：${formatElapsed(nowMs - (activity?.startedAtMs ?? this.phaseStartedAtMs))}\n- 本轮已持续：${formatElapsed(nowMs - this.startedAtMs)}`,
      updatedAtMs: nowMs,
    };
  }
}
