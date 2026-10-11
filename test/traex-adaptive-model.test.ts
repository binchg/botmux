import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { readTraexAdaptivePolicy, TraexAdaptiveRouter, TraexQueueReader } from '../src/services/traex-adaptive-model.js';
import { sessionModelStatus } from '../src/services/session-model-store.js';

const roots: string[] = [];
const temp = () => { const p = mkdtempSync(join(tmpdir(), 'traex-adaptive-')); roots.push(p); return p; };
afterEach(() => { for (const p of roots.splice(0)) rmSync(p, { recursive: true, force: true }); });

describe('TraeX admission routing', () => {
  it('is opt-in and retries the preferred model after the queue cooldown', async () => {
    expect(readTraexAdaptivePolicy({})).toBeUndefined();
    const p = { models: ['top', 'middle', 'low'], cooldownMs: 2000 };
    const router = new TraexAdaptiveRouter(p, join(temp(), 'health.json'));
    expect(router.choose(p.models, new Set(), 100)).toBe('top');
    await router.queued('top', 100);
    expect(router.choose(p.models, new Set(), 200)).toBe('middle');
    expect(router.lower('top', p.models, new Set(['top']))).toBe('middle');
    expect(router.choose(p.models, new Set(), 2100)).toBe('top');
    expect(router.lower('low', p.models, new Set())).toBeUndefined();
    expect(router.choose(['low'], new Set(['low']))).toBeUndefined();
  });

  it('merges simultaneous queue reports from separate sessions', async () => {
    const path = join(temp(), 'health.json');
    const a = new TraexAdaptiveRouter({ models: ['top','middle','low'], cooldownMs: 1000 }, path);
    const b = new TraexAdaptiveRouter(a.policy, path);
    await Promise.all([a.queued('top', 100), b.queued('middle', 100)]);
    expect(a.choose(a.policy.models, new Set(), 500)).toBe('low');
  });

  it('requires a new queue event belonging to this thread/process, after the last progress', () => {
    const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite');
    const path = join(temp(), 'logs.sqlite'); const db = new DatabaseSync(path);
    db.exec('CREATE TABLE logs(id INTEGER PRIMARY KEY,ts INTEGER,ts_nanos INTEGER,thread_id TEXT,process_uuid TEXT,feedback_log_body TEXT)');
    const insert = (id: number, tid: string | null, pid: string, body: string, ts = 2) => db.prepare('INSERT INTO logs VALUES(?,?,?,?,?,?)').run(id,ts,0,tid,pid,body);
    insert(1, 'mine', 'pid:42:x', 'request_wait_in_queue Your queue position is 90');
    const r = new TraexQueueReader('mine', 42, path);
    insert(2, 'other', 'pid:43:x', 'request_wait_in_queue Your queue position is 91');
    insert(3, 'mine', 'pid:42:x', 'load percent=111');
    insert(4, 'mine', 'pid:42:x', 'request_wait_in_queue Your queue position is 0');
    insert(5, 'mine', 'pid:42:x', 'request_wait_in_queue Your queue position is 10', 1);
    expect(r.poll(1500)).toBeUndefined();
    insert(6, 'mine', 'pid:43:x', 'request_wait_in_queue Your queue position is 99');
    expect(r.poll(1500)).toBeUndefined();
    insert(7, null, 'pid:42:x', 'request_wait_in_queue Your queue position is 8');
    expect(r.poll(1500)).toMatchObject({ id: 7, position: 8 });
    expect(r.poll(1500)).toBeUndefined();
    r.close(); db.close();
  });
});

describe('real runner adaptive protocol', () => {
  it.each(['queue', 'cancel', 'completion-race', 'tools'])('handles %s without replaying work or losing follow-up', async (mode) => {
    const dir = temp(), executable = join(dir, 'fake-traex.cjs'), calls = join(dir, 'calls.jsonl');
    mkdirSync(join(dir, 'cli'));
    writeFileSync(executable, `#!/usr/bin/env node
const fs=require('node:fs'),readline=require('node:readline'),{DatabaseSync}=require('node:sqlite');
const db=new DatabaseSync(process.env.TRAE_HOME+'/cli/logs_2.sqlite');
db.exec('CREATE TABLE IF NOT EXISTS logs(id INTEGER PRIMARY KEY,ts INTEGER,ts_nanos INTEGER,thread_id TEXT,process_uuid TEXT,feedback_log_body TEXT)');
const mode=process.env.ADAPTIVE_TEST_MODE; let n=0; const send=x=>process.stdout.write(JSON.stringify(x)+'\\n');
readline.createInterface({input:process.stdin}).on('line',line=>{
const m=JSON.parse(line);if(!m.id)return; let result={};
if(m.method==='config/read')result={config:{}};
if(m.method==='model/list')result={data:[{model:'top'},{model:'low'}]};
if(m.method==='thread/start'||m.method==='thread/resume')result={thread:{id:'same-thread'}};
if(m.method==='turn/steer'){fs.appendFileSync(process.env.MODEL_TEST_CALLS,JSON.stringify({steer:m.params})+'\\n');result={turnId:'turn-'+n};}
if(m.method==='turn/start'){
const id='turn-'+(++n);fs.appendFileSync(process.env.MODEL_TEST_CALLS,JSON.stringify(m.params)+'\\n');send({id:m.id,result:{turn:{id}}});
if(n===1 && mode==='tools'){send({method:'item/started',params:{threadId:'same-thread',item:{type:'commandExecution',id:'cmd-1',command:'fake tool'}}});setTimeout(()=>{send({method:'item/completed',params:{threadId:'same-thread',item:{type:'commandExecution',id:'cmd-1'}}});send({method:'turn/completed',params:{threadId:'same-thread',turn:{id,status:'completed'}}});},1300);}
if(n===1)setTimeout(()=>{const now=Date.now();db.prepare('INSERT INTO logs(ts,ts_nanos,thread_id,process_uuid,feedback_log_body) VALUES(?,?,?,?,?)').run(Math.floor(now/1000),(now%1000)*1e6,'same-thread','pid:'+process.pid+':fake','Trae request_wait_in_queue Your queue position is 71');send({method:'hook/completed',params:{threadId:'same-thread',turnId:id,run:{}}});},600);
else setTimeout(()=>{send({method:'item/completed',params:{threadId:'same-thread',item:{type:'agentMessage',id:'answer-'+n,text:'complete',phase:'final_answer'}}});send({method:'turn/completed',params:{threadId:'same-thread',turn:{id,status:'completed'}}});},50);
return;}
if(m.method==='turn/interrupt'){send({id:m.id,result:{}});send({method:'turn/completed',params:{threadId:'same-thread',turn:{id:'turn-'+n,status:mode==='completion-race'?'completed':'interrupted'}}});return;}
send({id:m.id,result});});
`, { mode: 0o700 });
    const runner = spawn(process.execPath, ['--import','tsx',resolve('src/codex-app-runner.ts'),'--session-id','adaptive-session','--traex-bin',executable,'--cwd',dir], {
      env: { ...process.env, SESSION_DATA_DIR: dir, TRAE_HOME: dir, TRAEX_ADAPTIVE_MODELS: 'top,low', TRAEX_ADAPTIVE_COOLDOWN_MS: '1000', MODEL_TEST_CALLS: calls, ADAPTIVE_TEST_MODE: mode }, stdio: ['pipe','pipe','pipe'],
    });
    let errors = ''; runner.stderr.on('data', x => { errors += x; }); runner.stdout.on('data', () => {});
    const state = () => sessionModelStatus(dir, 'adaptive-session');
    const send = (content: string) => runner.stdin.write('::botmux-codex-app:' + Buffer.from(JSON.stringify({type:'message',content})).toString('base64') + '\n');
    try {
      await vi.waitFor(() => expect(state().runtime?.phase, errors).toBe('ready'), { timeout: 15000 });
      send('original task');
      await vi.waitFor(() => expect(state().runtime?.phase, errors).toBe('running'));
      if (mode === 'cancel') {
        runner.stdin.write('::botmux-codex-app:' + Buffer.from(JSON.stringify({type:'interrupt'})).toString('base64') + '\n');
        await vi.waitFor(() => expect(state().runtime?.phase).toBe('failed'));
        await new Promise(r => setTimeout(r, 1100));
        expect(readFileSync(calls,'utf8').trim().split('\n')).toHaveLength(1);
        return;
      }
      send('additional constraint');
      if (mode !== 'queue') {
        await vi.waitFor(() => expect(state().runtime?.phase, errors).toBe('completed'), { timeout: 5000 });
        expect(state().runtime?.selection?.model).toBe('top');
        expect(readFileSync(calls,'utf8').trim().split('\n').map(x => JSON.parse(x)).filter(x => x.model)).toHaveLength(1);
        return;
      }
      await vi.waitFor(() => expect(state().runtime?.selection?.model, errors).toBe('low'), { timeout: 5000 });
      await vi.waitFor(() => expect(state().runtime?.phase).toBe('completed'));
      expect(state().runtime?.selection?.executor).toBe('traex');
      await new Promise(r => setTimeout(r, 1100)); send('next question');
      await vi.waitFor(() => expect(state().runtime?.turnId).toBe('turn-3'));
      await vi.waitFor(() => expect(state().runtime?.phase).toBe('completed'));
      expect(state().runtime?.selection?.model).toBe('top');
      const rows = readFileSync(calls, 'utf8').trim().split('\n').map(x => JSON.parse(x));
      expect(rows.filter(x => x.model).map(x => [x.threadId,x.model])).toEqual([['same-thread','top'],['same-thread','low'],['same-thread','top']]);
      expect(rows.find(x => x.steer)?.steer.input[0].text).toBe('additional constraint');
      expect(rows.filter(x => x.model)[1].input[0].text).toContain('不要重放');
    } finally {
      runner.kill('SIGTERM');
      await new Promise<void>(r => runner.once('exit', () => r()));
    }
  }, 25000);
});
