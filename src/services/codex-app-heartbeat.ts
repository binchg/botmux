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
const MAX_PROGRESS_CHARS = 64;

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

export function compactCodexAppProgressSummary(value: string): string {
  return compactField(value, MAX_PROGRESS_CHARS) ?? '处理中';
}

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
  private latestProgress?: string;
  private readonly activities = new Map<string, CodexAppHeartbeatActivity>();

  constructor(startedAtMs: number, options: CodexAppHeartbeatOptions = {}) {
    this.startedAtMs = startedAtMs;
    this.lastVisibleAtMs = startedAtMs;
    this.intervalMs = options.intervalMs ?? DEFAULT_INTERVAL_MS;
  }

  noteVisibleProgress(nowMs: number, summary?: string): void {
    this.lastVisibleAtMs = nowMs;
    if (summary) this.latestProgress = compactCodexAppProgressSummary(summary);
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
    return this.snapshot(turnId, nowMs);
  }

  /** Render an immediate user-visible status after an explicit assistant
   * progress sentence. The same compact shape is reused by periodic heartbeats
   * so the progress card never oscillates between long prose and timer lists. */
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
    const progress = this.latestProgress ? `｜进展：${this.latestProgress}` : '';
    return {
      turnId,
      content: `正在执行：${activityText}${progress}｜本轮${formatElapsed(nowMs - this.startedAtMs)}。`,
      updatedAtMs: nowMs,
    };
  }
}
