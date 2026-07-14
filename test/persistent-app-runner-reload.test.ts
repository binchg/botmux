import { describe, expect, it } from 'vitest';
import { shouldReloadPersistentAppRunner } from '../src/services/persistent-app-runner-reload.js';

describe('persistent Botmux app runner reload policy', () => {
  it('reloads reattached Botmux-owned runners after daemon deployment', () => {
    expect(shouldReloadPersistentAppRunner('codex-app', true)).toBe(true);
    expect(shouldReloadPersistentAppRunner('mira', true)).toBe(true);
    expect(shouldReloadPersistentAppRunner('mir', true)).toBe(true);
  });

  it('does not reload fresh runners or third-party CLIs', () => {
    expect(shouldReloadPersistentAppRunner('codex-app', false)).toBe(false);
    expect(shouldReloadPersistentAppRunner('claude-code', true)).toBe(false);
    expect(shouldReloadPersistentAppRunner('codex', true)).toBe(false);
  });
});
