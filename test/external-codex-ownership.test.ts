import { it, expect, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const state = vi.hoisted(() => ({ home: '' }));
vi.mock('node:os', async original => ({ ...await original<typeof import('node:os')>(), homedir: () => state.home }));
const auto = vi.hoisted(() => ({ start: vi.fn(async () => {}) }));
const construct = vi.hoisted(() => vi.fn(function () { return auto; }));
vi.mock('../src/services/codex-auto-bridge.js', () => ({ CodexAutoBridge: construct }));
import { startExternalCodexBridge } from '../src/services/external-codex-runtime.js';

it('only starts discovery in the configured owner daemon, even when both bots share HOME', () => {
  state.home = mkdtempSync(join(tmpdir(), 'codex-owner-bot-'));
  mkdirSync(join(state.home, '.config/botmux'), { recursive: true });
  const path = join(state.home, '.config/botmux/external-codex.json');
  try {
    writeFileSync(path, JSON.stringify({ enabled: true, mode: 'auto', codexHomes: ['/codex'],
      larkAppId: 'nene', chatId: 'ningning', ownerOpenId: 'owner', codexBin: '/codex' }));
    startExternalCodexBridge('chenchen');
    expect(construct).not.toHaveBeenCalled();
    startExternalCodexBridge('nene');
    expect(construct).toHaveBeenCalledTimes(1);
    expect(auto.start).toHaveBeenCalledTimes(1);
    // Explicit mappings cannot accidentally start another bot's bridge either.
    writeFileSync(path, JSON.stringify({ enabled: true, bindings: [{ larkAppId: 'nene' }] }));
    startExternalCodexBridge('chenchen');
    expect(construct).toHaveBeenCalledTimes(1);
  } finally { rmSync(state.home, { recursive: true, force: true }); }
});
