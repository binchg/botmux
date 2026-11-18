/** 从正式运行器验证三个通道、独立环境、连续追问和冷却恢复，避免只测试排序函数。 */
import { spawn } from 'node:child_process';
import { copyFileSync, chmodSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { expect, it, vi } from 'vitest';
import { sessionModelStatus } from '../src/services/session-model-store.js';

it('实际队列到方舟429再到Codex，后续追问复用线程且不把方舟环境带给Codex', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mixed-runner-'));
  mkdirSync(join(dir, 'cli')); mkdirSync(join(dir, 'ark-home'));
  writeFileSync(join(dir, 'ark-home/config.toml'), '');
  const calls = join(dir, 'calls.jsonl'), policy = join(dir, 'policy.json');
  writeFileSync(policy, JSON.stringify({ version: 1, maxAttempts: 3, routes: [
    { executor: 'traex', model: 'gpt-6-astra', policyModel: 'gpt-6-astra', effort: 'xhigh' },
    { executor: 'ark', model: 'ep-real', policyModel: 'gpt-6-astra', effort: 'xhigh' },
    { executor: 'codex-app', model: 'gpt-6.1-sol', policyModel: 'gpt-6.1-sol', effort: 'xhigh' },
  ] }));
  for (const name of ['traex', 'codex']) {
    copyFileSync(resolve('test/fixtures/mixed-app-server.cjs'), join(dir, name)); chmodSync(join(dir, name), 0o700);
  }
  const runner = spawn(process.execPath, ['--import', 'tsx', resolve('src/codex-app-runner.ts'),
    '--session-id', 'mixed', '--codex-bin', join(dir, 'codex'), '--traex-bin', join(dir, 'traex'), '--cwd', dir], {
    env: { ...process.env, HOME: dir, CODEX_HOME: join(dir, 'native-home'), SESSION_DATA_DIR: dir, TRAE_HOME: dir,
      TRAEX_APP_SERVER_DEFAULT: '1', MIXED_MODEL_ROUTES_FILE: policy, ARK_CODEX_HOME: join(dir, 'ark-home'), MIXED_TEST_CALLS: calls },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let output = '';
  runner.stdout.on('data', data => { output += data; }); runner.stderr.on('data', data => { output += data; });
  const state = () => sessionModelStatus(dir, 'mixed');
  const rows = () => readFileSync(calls, 'utf8').trim().split('\n').map(line => JSON.parse(line));
  const send = (content: string) => runner.stdin.write('::botmux-codex-app:' + Buffer.from(JSON.stringify({ type: 'message', content })).toString('base64') + '\n');
  try {
    await vi.waitFor(() => expect(state().runtime?.phase, output).toBe('ready'), { timeout: 10000 });
    send('read the test marker');
    await vi.waitFor(() => expect(state().runtime?.phase, output).toBe('completed'), { timeout: 15000 });
    expect(rows().filter(row => row.method === 'turn/start').map(row => row.name)).toEqual(['traex', 'ark', 'codex-app']);
    expect(rows().find(row => row.name === 'ark')?.home).toBe(join(dir, 'ark-home'));
    expect(rows().filter(row => row.name === 'codex-app').every(row => row.home === join(dir, 'native-home'))).toBe(true);
    expect(state().runtime?.selection).toMatchObject({ executor: 'codex-app', routingMode: 'adaptive' });
    const revision = state().desired?.revision;
    send('recall the marker without repeating previous actions');
    await vi.waitFor(() => expect(rows().filter(row => row.method === 'turn/start')).toHaveLength(4), { timeout: 10000 });
    await vi.waitFor(() => expect(state().runtime?.phase, output).toBe('completed'));
    expect(state().runtime?.threadId).toBe('codex-app-thread');
    expect(state().desired?.revision).toBe(revision);
    expect(rows().filter(row => row.method === 'turn/start').at(-1)?.name).toBe('codex-app');
  } finally {
    const done = new Promise<void>(resolve => runner.once('exit', () => resolve())); runner.kill(); await done;
    rmSync(dir, { recursive: true, force: true });
  }
}, 25000);
