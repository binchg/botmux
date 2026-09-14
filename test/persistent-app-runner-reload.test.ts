import { describe, expect, it } from 'vitest';
import { shouldReloadPersistentAppRunner } from '../src/services/persistent-app-runner-reload.js';

describe('persistent Botmux app runner reload policy', () => {
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
