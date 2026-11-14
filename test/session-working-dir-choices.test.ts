import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sessionWorkingDirChoices } from '../src/services/session-working-dir-choices.js';
import type { Session } from '../src/types.js';
const roots: string[] = [];
const root = () => { const p = mkdtempSync(join(tmpdir(), 'dir-choices-')); roots.push(p); return p; };
afterEach(() => roots.splice(0).forEach(p => rmSync(p, { recursive: true, force: true })));
const s = (path: string, at: number, extra: Partial<Session> = {}): Session => ({ sessionId: String(at), chatId: 'chat', rootMessageId: 'root', title: 'title', status: 'closed', createdAt: new Date(at).toISOString(), larkAppId: 'nene', workingDir: path, ...extra });
describe('working-directory quick choices', () => {
  it('sorts by last real use, isolates bots, ignores pending choices, missing paths and files, deduplicates aliases', () => {
    const r = root(), a = join(r, 'a'), b = join(r, 'b'), alias = join(r, 'alias'), file = join(r, 'file');
    mkdirSync(a); mkdirSync(b); symlinkSync(a, alias); writeFileSync(file, 'x');
    const result = sessionWorkingDirChoices([s(a, 1), s(b, 2), s(alias, 3), s(file, 4), s(join(r, 'gone'), 5), s(r, 6, { larkAppId: 'other' }), s(r, 7, { pendingRepoSelection: {} })], 'nene', [r, alias, a, file, '/missing']);
    expect(result.recent).toEqual([alias, b]); expect(result.configured).toEqual([r, alias]);
    expect(sessionWorkingDirChoices([s(a, 1, { workingDirLastUsedAt: new Date(20).toISOString() }), s(b, 10)], 'nene').recent).toEqual([a, b]);
  });
  it('caps recents at five and preserves spaces in configured paths', () => {
    const r = root(); const paths = Array.from({ length: 8 }, (_, i) => join(r, `project ${i}`)); paths.forEach(p => mkdirSync(p));
    const result = sessionWorkingDirChoices(paths.map((p, i) => s(p, i)), 'nene', paths);
    expect(result.recent).toEqual(paths.slice(3).reverse()); expect(result.configured).toEqual(paths);
  });
});
