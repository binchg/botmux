import type { TraexQueueEvidence } from './traex-adaptive-model.js';

/** 短队列最多等待十秒；长队列和额度低优先级立即降级，重复心跳不延长截止时间。 */
export class TraexQueueWait {
  private since?: number;
  /** 已离队或产生新进展时重置；返回 true 表示已达到降级边界。 */
  shouldDegrade(evidence: TraexQueueEvidence | undefined, now = Date.now()): boolean {
    if (!evidence) { this.since = undefined; return false; }
    this.since ??= now;
    return evidence.quotaLowPriority === true || evidence.position === undefined
      || evidence.position > 10 || now - this.since >= 10000;
  }
}
