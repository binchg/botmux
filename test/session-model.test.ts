import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readdirSync, rmSync, statSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { parseModelCommand } from '../src/cli/session-model-command.js';
import { validateModelSelection } from '../src/services/session-model-selection.js';
import { readSessionModel, sessionModelStatus, writeSessionModel, writeSessionModelRuntime } from '../src/services/session-model-store.js';

const dirs: string[] = [];
const temp = () => { const d = mkdtempSync(join(tmpdir(), 'botmux-model-')); dirs.push(d); return d; };
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
const models = [{ model: 'synthetic-a', defaultReasoningEffort: 'high', supportedReasoningEfforts: [{ reasoningEffort: 'high' }, { reasoningEffort: 'xhigh' }], serviceTiers: [{ id: 'priority' }] }];

describe('session model selection', () => {
  it('validates actual model catalog, effort and tier, retaining existing tier on effort-only changes', () => {
    const before = validateModelSelection({ model: 'synthetic-a', effort: 'high', serviceTier: 'priority' }, models);
    expect(validateModelSelection({ effort: 'xhigh' }, models, before)).toEqual({ ...before, effort: 'xhigh' });
    for (const patch of [{ model: 'missing' }, { model: 'synthetic-a', effort: 'ultra' }, { model: 'synthetic-a', serviceTier: 'other' }, { model: 'synthetic-a', global: true }]) expect(() => validateModelSelection(patch, models)).toThrow();
  });
  it('isolates sessions and survives re-read without changing global config', () => {
    const d = temp(); writeFileSync(join(d, 'config.toml'), 'model="unchanged"');
    const first = writeSessionModel(d, 'a', { model: 'synthetic-a', effort: 'high' });
    expect(writeSessionModel(d, 'a', first).revision).toBe(first.revision);
    expect(readSessionModel(d, 'b')).toBeUndefined();
    expect(readSessionModel(d, 'a')).toEqual(first);
    expect(readFileSync(join(d, 'config.toml'), 'utf8')).toBe('model="unchanged"');
    for (const name of readdirSync(join(d, 'session-models'))) expect(statSync(join(d, 'session-models', name)).mode & 0o777).toBe(0o600);
  });
  it('never reports a pending, failed, old revision or dead runner as verified', () => {
    const d = temp(), request = writeSessionModel(d, 'a', { model: 'synthetic-a', effort: 'xhigh' });
    expect(sessionModelStatus(d, 'a').status).toBe('pending_runner_reload');
    const runtime = { sessionId: 'a', pid: process.pid, threadId: 'same-thread', revision: request.revision, selection: request };
    writeSessionModelRuntime(d, { ...runtime, phase: 'ready', revision: undefined });
    expect(sessionModelStatus(d, 'a').status).toBe('pending_next_turn');
    writeSessionModelRuntime(d, { ...runtime, phase: 'running' }); expect(sessionModelStatus(d, 'a').status).toBe('accepted');
    writeSessionModelRuntime(d, { ...runtime, phase: 'failed' }); expect(sessionModelStatus(d, 'a').status).toBe('failed');
    writeSessionModelRuntime(d, { ...runtime, phase: 'completed' }); expect(sessionModelStatus(d, 'a').status).toBe('verified');
    writeSessionModel(d, 'a', { model: 'synthetic-a', effort: 'high' }); expect(sessionModelStatus(d, 'a').status).toBe('pending_next_turn');
    writeSessionModelRuntime(d, { ...runtime, phase: 'completed', pid: -1 }); expect(sessionModelStatus(d, 'a').status).toBe('pending_runner_reload');
  });
  it('parses quick commands and rejects accidental global/unknown/missing options', () => {
    expect(parseModelCommand(['set', 'synthetic-a', 'xhigh', '--service-tier', 'priority', '--session-id', 'a']).body).toEqual({ model: 'synthetic-a', effort: 'xhigh', serviceTier: 'priority' });
    expect(parseModelCommand(['effort', 'high']).body).toEqual({ effort: 'high' });
    for (const args of [['set'], ['set','synthetic-a','--global'], ['set','synthetic-a','--service-tier'], ['status','oops']]) expect(() => parseModelCommand(args)).toThrow();
  });
});

describe('real runner protocol with synthetic app-server', () => {
  it('keeps one process/thread, freezes the active request and applies the new model/effort on the next turn', async () => {
    const d = temp(), executable = join(d, 'fake-codex.cjs'), calls = join(d, 'calls.jsonl');
    writeFileSync(executable, `#!/usr/bin/env node
const fs=require('node:fs'),readline=require('node:readline');let n=0;
const send=x=>process.stdout.write(JSON.stringify(x)+'\\n');
readline.createInterface({input:process.stdin}).on('line',line=>{const m=JSON.parse(line);if(!m.id)return;let result={};
if(m.method==='config/read')result={config:{model:'synthetic-a',model_reasoning_effort:'high',service_tier:'priority'}};
if(m.method==='thread/start'||m.method==='thread/resume')result={thread:{id:'same-thread'}};
if(m.method==='turn/start'){const id='turn-'+(++n);fs.appendFileSync(process.env.MODEL_TEST_CALLS,JSON.stringify(m.params)+'\\n');send({id:m.id,result:{turn:{id}}});setTimeout(()=>{send({method:'item/completed',params:{threadId:'same-thread',item:{type:'agentMessage',id:'answer-'+n,text:'synthetic complete',phase:'final_answer'}}});send({method:'turn/completed',params:{threadId:'same-thread',turn:{id,status:n===3?'failed':'completed',error:n===3?{message:'synthetic failure'}:null}}});},300);return;}
send({id:m.id,result});});
`, { mode: 0o700 });
    const runner = spawn(process.execPath, ['--import', 'tsx', resolve('src/codex-app-runner.ts'), '--session-id', 'synthetic-session', '--codex-bin', executable, '--cwd', d], {
      cwd: process.cwd(), env: { ...process.env, SESSION_DATA_DIR: d, MODEL_TEST_CALLS: calls }, stdio: ['pipe', 'pipe', 'pipe'],
    });
    let errors = ''; runner.stdout.on('data', () => {}); runner.stderr.on('data', chunk => { errors += chunk.toString(); });
    const state = () => sessionModelStatus(d, 'synthetic-session');
    const send = () => runner.stdin.write('::botmux-codex-app:' + Buffer.from(JSON.stringify({type:'message',content:'synthetic request'})).toString('base64') + '\n');
    try {
      await vi.waitFor(() => expect(state().runtime?.phase, errors).toBe('ready'), { timeout: 15000 });
      const first = writeSessionModel(d, 'synthetic-session', { model: 'synthetic-a', effort: 'high', serviceTier: 'priority' }); send();
      await vi.waitFor(() => expect(state().runtime?.phase).toBe('running'));
      const second = writeSessionModel(d, 'synthetic-session', { model: 'synthetic-b', effort: 'xhigh', serviceTier: 'priority' });
      expect(state().status).toBe('pending_next_turn');
      await vi.waitFor(() => expect(state().runtime?.phase).toBe('completed'));
      expect(state().runtime?.revision).toBe(first.revision); send();
      await vi.waitFor(() => expect(state().status).toBe('verified'));
      expect(state().runtime?.revision).toBe(second.revision);
      expect(state().runtime?.pid).toBe(runner.pid);
      const requests = readFileSync(calls, 'utf8').trim().split('\n').map(s => JSON.parse(s));
      expect(requests.map(x => [x.threadId,x.model,x.effort,x.serviceTier])).toEqual([['same-thread','synthetic-a','high','priority'],['same-thread','synthetic-b','xhigh','priority']]);
      send(); await vi.waitFor(() => expect(state().status).toBe('failed'));
    } finally { runner.kill('SIGTERM'); await new Promise<void>(resolve => runner.once('exit', () => resolve())); }
  }, 20000);
});
