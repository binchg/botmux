import { describe, expect, it, vi } from 'vitest';
import * as globals from '../src/global-config.js';
import * as store from '../src/services/session-model-store.js';
import { globalHookPolicyNeedsReload, shouldReloadPersistentAppRunner } from '../src/services/persistent-app-runner-reload.js';

describe('persistent Botmux app runner reload policy', () => {
  it('recovers an explicit global decision after daemon restart, without repeatedly reloading matching runners', () => {
    const policy = vi.spyOn(globals, 'readGlobalConfig').mockReturnValue({});
    const runtime = vi.spyOn(store, 'readSessionModelRuntime').mockReturnValue(undefined);
    try {
      expect(globalHookPolicyNeedsReload('codex-app', '/unused', 'sample')).toBe(false);
      policy.mockReturnValue({ hookTrust: 'always' });
      expect(globalHookPolicyNeedsReload('codex-app', '/unused', 'sample')).toBe(true);
      expect(globalHookPolicyNeedsReload('mira', '/unused', 'sample')).toBe(false);
      runtime.mockReturnValue({sessionId:'sample',pid:process.pid,protocol:3,phase:'ready',updatedAt:'now',selection:{model:'same',effort:'high',hookTrust:'always'}});
      expect(globalHookPolicyNeedsReload('codex-app', '/unused', 'sample')).toBe(false);
      policy.mockReturnValue({ hookTrust: 'review' });
      expect(globalHookPolicyNeedsReload('codex-app', '/unused', 'sample')).toBe(true);
    } finally { vi.restoreAllMocks(); }
  });
  it('daemon 部署默认保留全部已有 AI 进程', () => {
    expect(shouldReloadPersistentAppRunner('codex-app', true)).toBe(false);
    expect(shouldReloadPersistentAppRunner('mira', true)).toBe(false);
    expect(shouldReloadPersistentAppRunner('mir', true)).toBe(false);
  });

  it('只有显式重建请求才允许重载自有 runner', () => {
    expect(shouldReloadPersistentAppRunner('codex-app', true, true)).toBe(true);
    expect(shouldReloadPersistentAppRunner('claude-code', true, true)).toBe(false);
    expect(shouldReloadPersistentAppRunner('codex-app', false, true)).toBe(false);
  });

  it('does not reload fresh runners or third-party CLIs', () => {
    expect(shouldReloadPersistentAppRunner('codex-app', false)).toBe(false);
    expect(shouldReloadPersistentAppRunner('claude-code', true)).toBe(false);
    expect(shouldReloadPersistentAppRunner('codex', true)).toBe(false);
  });
});
