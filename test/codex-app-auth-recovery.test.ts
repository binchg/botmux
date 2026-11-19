import { describe, expect, it } from 'vitest';
import {
  codexAuthRecoveryFailed,
  codexAuthRecoveryNotice,
  isCodexRefreshTokenRotation,
} from '../src/services/codex-app-auth-recovery.js';

describe('Codex refresh token 轮换恢复', () => {
  it('只识别 refresh token 已被使用的明确错误', () => {
    expect(isCodexRefreshTokenRotation('Your access token could not be refreshed because your refresh token was already used. Please log out and sign in again.')).toBe(true);
    expect(isCodexRefreshTokenRotation('refresh token was already used')).toBe(true);
    expect(isCodexRefreshTokenRotation('Your access token could not be refreshed. Please log out and sign in again.')).toBe(false);
    expect(isCodexRefreshTokenRotation('401 Unauthorized')).toBe(false);
  });

  it('说明零副作用自动重试和一次上限', () => {
    expect(codexAuthRecoveryNotice('zh')).toContain('尚未产生模型输出或工具副作用');
    expect(codexAuthRecoveryNotice('zh')).toContain('自动重试一次');
    expect(codexAuthRecoveryFailed('zh')).toContain('未继续重试');
  });
});
