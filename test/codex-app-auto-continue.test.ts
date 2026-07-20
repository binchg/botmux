import { describe, expect, it } from 'vitest';
import {
  CODEX_APP_RATE_LIMIT_MAX_CONTINUES,
  codexAppAutoContinueDelayMs,
  codexAppAutoContinuePrompt,
  isCodexAppRetryLimit429,
} from '../src/services/codex-app-auto-continue.js';

describe('Codex App 429 自动继续', () => {
  it('识别内部重试耗尽后的 429 错误', () => {
    expect(isCodexAppRetryLimit429('exceeded retry limit, last status: 429 Too Many Requests')).toBe(true);
    expect(isCodexAppRetryLimit429('rate limit: HTTP 429')).toBe(true);
    expect(isCodexAppRetryLimit429('500 Internal Server Error')).toBe(false);
  });

  it('使用有上限的指数退避', () => {
    expect(CODEX_APP_RATE_LIMIT_MAX_CONTINUES).toBe(5);
    expect([1, 2, 3, 4, 5].map(codexAppAutoContinueDelayMs)).toEqual([
      15_000,
      30_000,
      60_000,
      120_000,
      120_000,
    ]);
  });

  it('要求续跑时复用现场并避免重复副作用', () => {
    expect(codexAppAutoContinuePrompt('zh')).toContain('复用已有上下文');
    expect(codexAppAutoContinuePrompt('zh')).toContain('不要重复');
    expect(codexAppAutoContinuePrompt('en')).toContain('do not repeat');
  });
});
