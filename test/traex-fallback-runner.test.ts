import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { expect, it, vi } from 'vitest';
import { readSessionExecutor, sessionModelStatus } from '../src/services/session-model-store.js';

/** 真实运行器跨进程接续：模拟低负载模型仍排队，并检查可见追问迁移与重启恢复。 */
it.each(['success', 'target-failure'])('TraeX 排队后的执行器接续：%s', async mode => {
  const dir = mkdtempSync(join(tmpdir(), 'fallback-runner-')), calls = join(dir, 'calls.jsonl');
  mkdirSync(join(dir, 'cli'));
  for (const name of ['traex', 'codex']) writeFileSync(join(dir, name), `#!/usr/bin/env node
const fs=require('node:fs'),rl=require('node:readline'),{DatabaseSync}=require('node:sqlite');
const name=require('node:path').basename(__filename),history=[];let n=0;
if(process.argv[2]==='debug'){process.stdout.write(JSON.stringify({models:['busy','low'].map(slug=>({slug,visibility:'list',model_provider_id:'trae',supported_reasoning_levels:[{effort:'xhigh'}],business_metadata:{load:{load_percent:slug==='busy'?119:63}}}))}));process.exit(0);}
const db=new DatabaseSync(process.env.TRAE_HOME+'/cli/logs_2.sqlite');db.exec('CREATE TABLE IF NOT EXISTS logs(id INTEGER PRIMARY KEY,ts INTEGER,ts_nanos INTEGER,thread_id TEXT,process_uuid TEXT,feedback_log_body TEXT)');
const send=x=>process.stdout.write(JSON.stringify(x)+'\\n');
rl.createInterface({input:process.stdin}).on('line',line=>{
const m=JSON.parse(line);if(!m.id)return;let result={};
fs.appendFileSync(process.env.CALLS,JSON.stringify({name,method:m.method,params:m.params})+'\\n');
if(m.method==='config/read')result={config:{model:name==='codex'?'target':'low',model_reasoning_effort:'xhigh'}};
if(m.method==='model/list')result={data:[{model:'target',defaultReasoningEffort:'xhigh',supportedReasoningEfforts:[{reasoningEffort:'xhigh'}]}]};
if(m.method==='thread/start'||m.method==='thread/resume')result={thread:{id:name+'-thread'},model:name==='codex'&&process.env.TEST_MODE==='target-failure'?'wrong':m.params.model};
if(m.method==='thread/read')result={thread:{turns:[{items:history}]}};
if(m.method==='turn/steer'){history.push({type:'userMessage',content:m.params.input});result={turnId:'turn-'+n};}
if(m.method==='turn/start'){
const id='turn-'+(++n);history.push({type:'userMessage',content:m.params.input});send({id:m.id,result:{turn:{id}}});
if(name==='traex')setTimeout(()=>{const now=Date.now();db.prepare('INSERT INTO logs(ts,ts_nanos,thread_id,process_uuid,feedback_log_body) VALUES(?,?,?,?,?)').run(Math.floor(now/1000),(now%1000)*1e6,'traex-thread','pid:'+process.pid+':test','request_wait_in_queue Your queue position is 774');send({method:'hook/completed',params:{threadId:'traex-thread',turnId:id,run:{}}});},500);
else setTimeout(()=>{send({method:'item/completed',params:{threadId:'codex-thread',item:{type:'agentMessage',id:'answer',text:'done',phase:'final_answer'}}});send({method:'turn/completed',params:{threadId:'codex-thread',turn:{id,status:'completed'}}});},50);return;}
if(m.method==='turn/interrupt'){send({id:m.id,result:{}});send({method:'turn/completed',params:{threadId:'traex-thread',turn:{id:'turn-'+n,status:'interrupted'}}});return;}
send({id:m.id,result});});
`, { mode: 0o700 });
  const start = () => spawn(process.execPath, ['--import', 'tsx', resolve('src/codex-app-runner.ts'),
    '--session-id', 'fallback', '--codex-bin', join(dir, 'codex'), '--traex-bin', join(dir, 'traex'), '--cwd', dir], {
    env: { ...process.env, HOME: dir, SESSION_DATA_DIR: dir, TRAE_HOME: dir, CALLS: calls, TEST_MODE: mode,
      TRAEX_ADAPTIVE_MODELS: 'busy,low', TRAEX_ADAPTIVE_FALLBACK_EXECUTOR: 'codex-app',
      TRAEX_ADAPTIVE_FALLBACK_MODEL: 'target' }, stdio: ['pipe', 'pipe', 'pipe'],
  });
  let runner = start(), output = '';
  const attach = () => { runner.stdout.on('data', data => { output += data; }); runner.stderr.on('data', data => { output += data; }); };
  attach();
  const state = () => sessionModelStatus(dir, 'fallback');
  const rows = () => readFileSync(calls, 'utf8').trim().split('\n').map(line => JSON.parse(line));
  const send = (content: string) => runner.stdin.write('::botmux-codex-app:' + Buffer.from(JSON.stringify({ type: 'message', content })).toString('base64') + '\n');
  const stop = async () => { const done = new Promise<void>(resolve => runner.once('exit', () => resolve())); runner.kill(); await done; };
  try {
    await vi.waitFor(() => expect(state().runtime?.phase, output).toBe('ready'), { timeout: 10000 });
    send('compare control and experiment, update corresponding bugs');
    await vi.waitFor(() => expect(state().runtime?.phase, output).toBe('running'));
    send('preserve QA results');
    await vi.waitFor(() => expect(state().runtime?.phase, output).toBe(mode === 'success' ? 'completed' : 'failed'), { timeout: 15000 });
    if (mode === 'success') {
      const turns = rows().filter(row => row.method === 'turn/start');
      expect(turns.map(row => row.name)).toEqual(['traex', 'codex']);
      expect(turns[1].params.input[0].text).toContain('preserve QA results');
      expect(turns[1].params.input[0].text).toContain('compare control and experiment');
      expect(state().desired?.executor).toBe('codex-app');
      await stop(); runner = start(); attach();
      await vi.waitFor(() => expect(state().runtime?.pid, output).toBe(runner.pid), { timeout: 10000 });
      send('continue after restart');
      await vi.waitFor(() => expect(state().runtime?.phase, output).toBe('completed'), { timeout: 10000 });
      expect(rows().filter(row => row.method === 'turn/start').map(row => row.name)).toEqual(['traex', 'codex', 'codex']);
      expect(rows().filter(row => row.method === 'thread/resume').at(-1)).toMatchObject({ name: 'codex', params: { threadId: 'codex-thread' } });
    } else {
      expect(readSessionExecutor(dir, 'fallback')?.executor).toBe('traex');
      expect(rows().filter(row => row.method === 'turn/start').map(row => row.name)).toEqual(['traex']);
      expect(output).toContain('executor_model_mismatch');
    }
  } finally { await stop(); rmSync(dir, { recursive: true, force: true }); }
}, 25000);
