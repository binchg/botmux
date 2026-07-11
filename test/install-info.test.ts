import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { isLocalDevInstallAt, isLocalDevInstall, botmuxVersion, botmuxVersionAt } from '../src/utils/install-info.js';

describe('isLocalDevInstallAt', () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'botmux-install-')); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  it('true when a .git directory is present (checkout)', () => {
    mkdirSync(join(dir, '.git'));
    expect(isLocalDevInstallAt(dir)).toBe(true);
  });
  it('true when .git is a file (git worktree pointer)', () => {
    writeFileSync(join(dir, '.git'), 'gitdir: /somewhere/.git/worktrees/x\n');
    expect(isLocalDevInstallAt(dir)).toBe(true);
  });
  it('true when a src/ directory is present (unpublished source tree)', () => {
    mkdirSync(join(dir, 'src'));
    expect(isLocalDevInstallAt(dir)).toBe(true);
  });
  it('false for an npm-global-style install (only dist/, no .git/src)', () => {
    mkdirSync(join(dir, 'dist'));
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'botmux' }));
    expect(isLocalDevInstallAt(dir)).toBe(false);
  });
});

describe('isLocalDevInstall (runtime)', () => {
  it('returns a boolean and detects this checkout/worktree as local-dev', () => {
    const v = isLocalDevInstall();
    expect(typeof v).toBe('boolean');
    expect(v).toBe(true); // the test runs from a git working copy with src/
  });
});

describe('botmuxVersion', () => {
  it('reads the tracked dev version for this source checkout', () => {
    // resolve repo root from this test file: test/ → repo root
    const root = fileURLToPath(new URL('..', import.meta.url));
    const expected = JSON.parse(readFileSync(join(root, 'dev-version.json'), 'utf-8')).version;
    expect(botmuxVersion()).toBe(expected);
  });

  it('prefers a published package version and falls back safely', () => {
    const dir = mkdtempSync(join(tmpdir(), 'botmux-version-'));
    try {
      writeFileSync(join(dir, 'package.json'), JSON.stringify({ version: '2.3.4' }));
      writeFileSync(join(dir, 'dev-version.json'), JSON.stringify({ version: '9.9.9' }));
      expect(botmuxVersionAt(dir)).toBe('2.3.4');
      writeFileSync(join(dir, 'package.json'), JSON.stringify({ version: '0.0.0' }));
      expect(botmuxVersionAt(dir)).toBe('9.9.9');
      writeFileSync(join(dir, 'dev-version.json'), JSON.stringify({ version: 'bad' }));
      expect(botmuxVersionAt(dir)).toBe('0.0.0');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
