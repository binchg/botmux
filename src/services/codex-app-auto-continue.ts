/**
 * Codex App 上游限流后的自动续跑策略，集中约束识别条件、退避时间和续跑提示。
 */

export const CODEX_APP_RATE_LIMIT_MAX_CONTINUES = 5;

const CODEX_APP_RATE_LIMIT_BASE_DELAY_MS = 15_000;
const CODEX_APP_RATE_LIMIT_MAX_DELAY_MS = 120_000;

/** 判断错误是否为 Codex 内部重试耗尽后的 HTTP 429 限流。 */
export function isCodexAppRetryLimit429(message: string): boolean {
  const normalized = message.trim().toLowerCase();
  const hasRateLimitStatus = normalized.includes('429') || normalized.includes('too many requests');
  const hasRetryLimit = normalized.includes('exceeded retry limit')
    || normalized.includes('retry limit')
    || normalized.includes('rate limit');
  return hasRateLimitStatus && hasRetryLimit;
}

/** 按自动续跑序号计算指数退避，并限制最长等待时间。 */
export function codexAppAutoContinueDelayMs(continueNumber: number): number {
  const exponent = Math.max(0, Math.floor(continueNumber) - 1);
  return Math.min(
    CODEX_APP_RATE_LIMIT_BASE_DELAY_MS * (2 ** exponent),
    CODEX_APP_RATE_LIMIT_MAX_DELAY_MS,
  );
}

/** 生成安全续跑提示，要求复用现场且避免重复副作用。 */
export function codexAppAutoContinuePrompt(locale?: string): string {
  if (locale === 'zh') {
    return '继续执行刚才因 429 限流中断的未完成任务。复用已有上下文，不要重复已完成或可能产生副作用的操作。';
  }
  return 'Continue the unfinished task interrupted by the 429 rate limit. Reuse the existing context and do not repeat completed or potentially side-effecting actions.';
}
