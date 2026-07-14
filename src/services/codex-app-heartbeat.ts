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

const DEFAULT_INTERVAL_MS = 30_000;
const MAX_ACTIVITY_CHARS = 44;

function compactField(value: string | undefined, maxChars: number): string | undefined {
  const text = String(value ?? '')
    .replace(/[\r\n]+/g, ' ')
    .replace(/^[\s>*#`\-•]+/, '')
    .replace(/(authorization|token|password|secret)\s*[:=]\s*\S+/gi, '$1=[已脱敏]')
    .replace(/[。！？!?…]+/g, '，')
    .replace(/\.(?=\s|$)/g, '，')
    .replace(/，{2,}/g, '，')
    .replace(/\s+/g, ' ')
    .replace(/[，,；;：:\s]+$/, '')
    .trim();
  if (!text) return undefined;
  return text.length <= maxChars ? text : `${text.slice(0, Math.max(1, maxChars - 1))}…`;
}

/**
 * Emits factual background activity milestones when the model is silent.
 * This is event-driven rather than a duration heartbeat: a stage is posted at
 * most once, contains no elapsed time, and is never synthesized by the AI.
 */
export class CodexAppHeartbeat {
  private readonly intervalMs: number;
  private lastVisibleAtMs: number;
  private lastSnapshotAtMs = 0;
  private lastActivityFingerprint = '';
  private readonly activities = new Map<string, CodexAppHeartbeatActivity>();

  constructor(startedAtMs: number, options: CodexAppHeartbeatOptions = {}) {
    this.lastVisibleAtMs = startedAtMs;
    this.intervalMs = options.intervalMs ?? DEFAULT_INTERVAL_MS;
  }

  noteVisibleProgress(nowMs: number, _summary?: string): void {
    this.lastVisibleAtMs = nowMs;
  }

  startActivity(activity: CodexAppHeartbeatActivity): void {
    this.activities.set(activity.id, activity);
  }

  completeActivity(id: string, _completedAtMs: number): void {
    if (!this.activities.delete(id)) return;
  }

  maybeSnapshot(turnId: string | undefined, nowMs: number): CodexAppHeartbeatSnapshot | null {
    if (nowMs - this.lastVisibleAtMs < this.intervalMs) return null;
    if (this.lastSnapshotAtMs > 0 && nowMs - this.lastSnapshotAtMs < this.intervalMs) return null;
    const activity = this.currentActivity();
    if (!activity) return null;
    const fingerprint = `${activity.label}\u0000${activity.detail ?? ''}`;
    if (fingerprint === this.lastActivityFingerprint) return null;
    this.lastActivityFingerprint = fingerprint;
    return this.snapshot(turnId, nowMs);
  }

  /** Render the current factual tool stage without duration text. */
  currentSnapshot(turnId: string | undefined, nowMs: number): CodexAppHeartbeatSnapshot {
    return this.snapshot(turnId, nowMs);
  }

  private currentActivity(): CodexAppHeartbeatActivity | undefined {
    return [...this.activities.values()].sort((a, b) => b.startedAtMs - a.startedAtMs)[0];
  }

  private snapshot(turnId: string | undefined, nowMs: number): CodexAppHeartbeatSnapshot {
    this.lastSnapshotAtMs = nowMs;
    const activity = this.currentActivity();
    const activityText = compactField(
      activity
        ? `${activity.label}${activity.detail ? ` ${activity.detail}` : ''}`
        : '分析问题',
      MAX_ACTIVITY_CHARS,
    ) ?? '分析问题';
    return {
      turnId,
      content: `正在执行：${activityText}。`,
      updatedAtMs: nowMs,
    };
  }
}
