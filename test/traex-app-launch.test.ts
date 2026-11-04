import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { configureTraexAppLaunch } from '../src/services/traex-app-launch.js';
import { sessionModelStatus, writeSessionModel, writeSessionModelRuntime } from '../src/services/session-model-store.js';
import { sanitizePerBotEnv } from '../src/core/per-bot-env.js';

const roots: string[] = [];
const temp = () => { const path = mkdtempSync(join(tmpdir(), 'traex-launch-')); roots.push(path); return path; };
afterEach(() => { roots.splice(0).forEach(p => rmSync(p, { recursive: true, force: true })); });

it('routes a new TraeX session through the controllable runner and preserves its binary/environment', () => {
  const init: any = { type: 'init', sessionId: 'new', cliId: 'traex', cliPathOverride: '/custom/traex', env: { EXISTING: 'kept' } };
  configureTraexAppLaunch(init, temp());
  expect(init).toMatchObject({ cliId: 'codex-app', env: { EXISTING: 'kept', TRAEX_APP_SERVER_DEFAULT: '1', TRAEX_APP_SERVER_BIN: '/custom/traex' } });
  expect(sanitizePerBotEnv(init.env)).toEqual(init.env);
  expect(init.cliPathOverride).toBeUndefined();
});

it('resumes app-server sessions but does not feed runner controls into native/adopted terminals', () => {
  const dir = temp();
  for (const extra of [{ resume: true }, { adoptMode: true }, { wrapperCli: 'custom' }, { env: { TRAEX_ADAPTIVE_ENABLED: '0' } }]) {
    const init: any = { type: 'init', sessionId: 'legacy', cliId: 'traex', ...extra };
    configureTraexAppLaunch(init, dir);
    expect(init.cliId).toBe('traex');
  }
  writeSessionModelRuntime(dir, { sessionId: 'bridged', pid: 1, phase: 'ready' });
  const init: any = { type: 'init', sessionId: 'bridged', cliId: 'traex', resume: true };
  configureTraexAppLaunch(init, dir);
  expect(init.cliId).toBe('codex-app');
  const migrate: any = { type: 'init', sessionId: 'legacy', cliId: 'traex', resume: true, cliSessionId: 'original-thread' };
  configureTraexAppLaunch(migrate, dir, true);
  expect(migrate).toMatchObject({ cliId: 'codex-app', cliSessionId: 'original-thread' });
});

it('requires an old TraeX runner to reload before reporting the new policy accepted', () => {
  const dir = temp();
  const request = writeSessionModel(dir, 'old', { executor: 'traex', model: 'gpt-5.6-sol', effort: 'xhigh' });
  const runtime = { sessionId: 'old', pid: process.pid, phase: 'completed' as const, revision: request.revision, selection: request };
  writeSessionModelRuntime(dir, runtime);
  const path = join(dir, 'session-models', readdirSync(join(dir, 'session-models')).find(p => p.endsWith('.runtime.json'))!);
  const previous = JSON.parse(readFileSync(path, 'utf8')); previous.protocol = 3;
  writeFileSync(path, JSON.stringify(previous));
  expect(sessionModelStatus(dir, 'old').status).toBe('pending_runner_reload');
  writeSessionModelRuntime(dir, runtime);
  expect(sessionModelStatus(dir, 'old').status).toBe('verified');
});
