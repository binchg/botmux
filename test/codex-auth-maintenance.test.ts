import { mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  codexAuthPrcWindow,
  refreshCodexAccount,
  runCodexAuthMaintenanceTick,
  type CodexAuthMaintenanceDeps,
  type CodexAuthMaintenanceState,
} from '../src/services/codex-auth-maintenance.js';
import {
  readCodexAccessTokenExpiryMs,
  readCodexAuthFileStamp,
  sameCodexAuthFileStamp,
} from '../src/services/codex-auth-file.js';

const dirs: string[] = [];
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

// 2026-11-20 04:30 PRC.
const IN_WINDOW = Date.parse('2026-11-19T20:30:00.000Z');

function fakeJwt(expMs: number): string {
  const part = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
  return `${part({ alg: 'none' })}.${part({ exp: Math.floor(expMs / 1_000) })}.signature`;
}

function makeDeps(options: {
  now?: number;
  expiry?: number;
  busy?: boolean;
  state?: CodexAuthMaintenanceState;
  fail?: boolean;
} = {}) {
  let state = { ...(options.state ?? {}) };
  const calls = { refresh: 0, writes: 0, locks: 0 };
  const deps: CodexAuthMaintenanceDeps = {
    now: () => options.now ?? IN_WINDOW,
    readExpiryMs: () => options.expiry,
    anyBusy: () => options.busy ?? false,
    readState: () => ({ ...state }),
    writeState: next => { state = { ...next }; calls.writes++; },
    refresh: async () => { calls.refresh++; if (options.fail) throw new Error('refresh failed'); },
    withLock: async fn => { calls.locks++; return fn(); },
  };
  return { deps, calls, state: () => state };
}

describe('Codex 04:00-07:00 proactive auth maintenance', () => {
  it('uses a fixed PRC window and looks ahead through the next window end', () => {
    const inside = codexAuthPrcWindow(IN_WINDOW);
    expect(inside).toEqual({
      date: '2026-11-20',
      inWindow: true,
      nextWindowEndMs: Date.parse('2026-11-20T23:00:00.000Z'),
    });
    expect(codexAuthPrcWindow(Date.parse('2026-11-20T00:00:00.000Z')).inWindow).toBe(false);
  });

  it('does not rotate a token that survives the next maintenance window', async () => {
    const { deps, calls } = makeDeps({ expiry: Date.parse('2026-11-22T00:00:00.000Z') });
    expect(await runCodexAuthMaintenanceTick(deps)).toBe('not_due');
    expect(calls.refresh).toBe(0);
  });

  it('defers while any bot is busy, without consuming the daily attempt', async () => {
    const { deps, calls, state } = makeDeps({ expiry: Date.parse('2026-11-20T07:33:33.000Z'), busy: true });
    expect(await runCodexAuthMaintenanceTick(deps)).toBe('busy');
    expect(calls.refresh).toBe(0);
    expect(state()).toEqual({});
  });

  it('refreshes once under the cross-process lock and marks the local date', async () => {
    const { deps, calls, state } = makeDeps({ expiry: Date.parse('2026-11-20T07:33:33.000Z') });
    expect(await runCodexAuthMaintenanceTick(deps)).toBe('refreshed');
    expect(calls).toEqual({ refresh: 1, writes: 2, locks: 1 });
    expect(state()).toEqual(expect.objectContaining({ lastSuccessDate: '2026-11-20', lastResult: 'refreshed' }));
    expect(await runCodexAuthMaintenanceTick(deps)).toBe('already_refreshed');
    expect(calls.refresh).toBe(1);
  });

  it('throttles a failed refresh but can retry later within the same window', async () => {
    const { deps, calls, state } = makeDeps({ expiry: Date.parse('2026-11-20T07:33:33.000Z'), fail: true });
    expect(await runCodexAuthMaintenanceTick(deps)).toBe('failed');
    expect(state().lastResult).toBe('failed');
    expect(await runCodexAuthMaintenanceTick(deps)).toBe('retry_later');
    expect(calls.refresh).toBe(1);
  });
});

describe('Codex auth file metadata', () => {
  it('reads only JWT expiry and detects atomic auth.json replacement', () => {
    const dir = mkdtempSync(join(tmpdir(), 'codex-auth-file-'));
    dirs.push(dir);
    const path = join(dir, 'auth.json');
    const expiry = Date.parse('2026-11-29T20:30:00.000Z');
    writeFileSync(path, JSON.stringify({ tokens: { access_token: fakeJwt(expiry), refresh_token: 'never-returned' } }));
    const before = readCodexAuthFileStamp(path);
    expect(readCodexAccessTokenExpiryMs(path)).toBe(expiry);
    const replacement = join(dir, 'replacement');
    writeFileSync(replacement, JSON.stringify({ tokens: { access_token: fakeJwt(expiry + 1_000), refresh_token: 'new' } }));
    renameSync(replacement, path);
    expect(sameCodexAuthFileStamp(before, readCodexAuthFileStamp(path))).toBe(false);
  });

  it('uses account/read refreshToken without creating a thread or model turn', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'codex-auth-refresh-'));
    dirs.push(dir);
    const authPath = join(dir, 'auth.json');
    const callsPath = join(dir, 'calls');
    const before = Date.parse('2026-11-20T07:33:33.000Z');
    const after = Date.parse('2026-11-29T20:30:00.000Z');
    writeFileSync(authPath, JSON.stringify({ tokens: { access_token: fakeJwt(before), refresh_token: 'old' } }));
    const bin = join(dir, 'codex');
    writeFileSync(bin, `#!/usr/bin/env node
const fs=require('node:fs'),rl=require('node:readline');
rl.createInterface({input:process.stdin}).on('line',line=>{
 const m=JSON.parse(line); if(!m.id)return;
 fs.appendFileSync(${JSON.stringify(callsPath)},m.method+'\\n');
 if(m.method==='account/read'){
  fs.writeFileSync(${JSON.stringify(authPath)},JSON.stringify({tokens:{access_token:${JSON.stringify(fakeJwt(after))},refresh_token:'new'}}));
  console.log(JSON.stringify({id:m.id,result:{account:{type:'chatgpt'},requiresOpenaiAuth:false}})); return;
 }
 console.log(JSON.stringify({id:m.id,result:{}}));
});
`, { mode: 0o700 });
    await refreshCodexAccount(bin, dir, authPath);
    expect(readCodexAccessTokenExpiryMs(authPath)).toBe(after);
    expect(readFileSync(callsPath, 'utf8').trim().split('\n')).toEqual(['initialize', 'account/read']);
  });
});
