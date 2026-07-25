import { describe, expect, it } from 'vitest';
import { daemonBotIndexArgs, resolveDaemonBotIndex } from '../src/utils/daemon-bot-index.js';

describe('daemon bot index', () => {
  it('builds a stable PM2 argument pair', () => {
    expect(daemonBotIndexArgs(2)).toEqual(['--bot-index', '2']);
  });

  it('prefers the fixed process argument over a polluted environment', () => {
    expect(resolveDaemonBotIndex(['--bot-index', '0'], '1')).toBe(0);
    expect(resolveDaemonBotIndex(['--bot-index=2'], '1')).toBe(2);
  });

  it('keeps the environment fallback for legacy startup', () => {
    expect(resolveDaemonBotIndex([], '1')).toBe(1);
    expect(resolveDaemonBotIndex([], undefined)).toBeUndefined();
  });

  it('rejects a malformed explicit argument instead of falling back', () => {
    expect(resolveDaemonBotIndex(['--bot-index'], '1')).toBeNaN();
    expect(resolveDaemonBotIndex(['--bot-index=bad'], '1')).toBeNaN();
  });
});
