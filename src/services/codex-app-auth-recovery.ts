/**
 * Codex OAuth refresh token 会在成功刷新后立即轮换。多个长期存活的
 * app-server 若缓存同一旧 token，落后的进程会收到该明确错误；只有这种
 * 可判定的轮换冲突才允许重载进程，普通 401/登录失败仍交给用户处理。
 */
export function isCodexRefreshTokenRotation(error: string): boolean {
  const text = error.trim();
  return /refresh token was already used/i.test(text)
    || /access token could not be refreshed because your refresh token was already used/i.test(text);
}

export function codexAuthRecoveryNotice(locale?: string): string {
  return locale === 'zh'
    ? '检测到 refresh token 已被另一个 Codex 进程轮换；本轮尚未产生模型输出或工具副作用，已重载认证并自动重试一次。'
    : 'Another Codex process rotated the refresh token. No model output or tool side effect occurred, so authentication was reloaded and the turn is being retried once.';
}

export function codexAuthRecoveryFailed(locale?: string, detail?: string): string {
  const suffix = detail?.trim() ? ` ${detail.trim()}` : '';
  return locale === 'zh'
    ? `Codex 登录凭据已失效；自动重载一次后仍无法认证。请在本机重新登录 Codex。为避免重复副作用，本轮未继续重试。${suffix}`
    : `Codex login credentials are invalid after one automatic reload. Sign in to Codex again locally. The turn was not retried further to avoid duplicate side effects.${suffix}`;
}
