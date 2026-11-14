import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { expect, it, vi } from 'vitest';
import { sessionModelStatus } from '../src/services/session-model-store.js';

/** 真实运行器验证新建、生成中、工具执行中与准入等待中指定模型，无额外追问。 */
it.each(['new', 'busy', 'tools', 'waiting'])('自然语言模型设置自动应用：%s', async mode => {
  const dir = mkdtempSync(join(tmpdir(), 'model-intent-runner-')), calls = join(dir, 'calls.jsonl'), bin = join(dir, 'server');
  mkdirSync(join(dir, 'cli'));
  writeFileSync(bin, `#!/usr/bin/env node
const fs=require('node:fs'),rl=require('node:readline'),mode=process.env.TEST_MODE;let n=0;
const record=x=>fs.appendFileSync(process.env.CALLS,JSON.stringify(x)+'\\n');
if(process.argv[2]==='debug'){process.stdout.write(JSON.stringify({models:['gpt-5.5','gpt-6.1-sol'].map(slug=>({slug,visibility:'list',model_provider_id:'trae',supported_reasoning_levels:[{effort:'xhigh'}],business_metadata:{load:{load_percent:119}}}))}));process.exit(0);}
const send=x=>process.stdout.write(JSON.stringify(x)+'\\n');
rl.createInterface({input:process.stdin}).on('line',line=>{
const m=JSON.parse(line);if(!m.id)return;record({method:m.method,params:m.params});let result={};
if(m.method==='config/read')result={config:{model:'gpt-5.5',model_reasoning_effort:'high',service_tier:'priority'}};
if(m.method==='model/list')result={data:['gpt-5.5','gpt-6.1-sol'].map(model=>({model,defaultReasoningEffort:'high',supportedReasoningEfforts:[{reasoningEffort:'high'},{reasoningEffort:'xhigh'}],serviceTiers:[{id:'priority'}]}))};
if(m.method==='thread/start'||m.method==='thread/resume')result={thread:{id:'same-thread'}};
if(m.method==='turn/start'){
const id='turn-'+(++n);send({id:m.id,result:{turn:{id}}});
if(m.params.model==='gpt-6.1-sol')setTimeout(()=>{send({method:'item/completed',params:{threadId:'same-thread',item:{type:'agentMessage',id:'answer',text:'work complete',phase:'final_answer'}}});send({method:'turn/completed',params:{threadId:'same-thread',turn:{id,status:'completed'}}});},50);
else if(mode==='tools'){send({method:'item/started',params:{threadId:'same-thread',item:{type:'commandExecution',id:'tool'}}});const timer=setInterval(()=>{if(!fs.existsSync(process.env.FINISH_TOOL))return;clearInterval(timer);record({method:'tool_finished'});send({method:'item/completed',params:{threadId:'same-thread',item:{type:'commandExecution',id:'tool'}}});},20);}
return;}
if(m.method==='turn/interrupt'){send({id:m.id,result:{}});send({method:'turn/completed',params:{threadId:'same-thread',turn:{id:'turn-'+n,status:'interrupted'}}});return;}
send({id:m.id,result});});
`, { mode: 0o700 });
  const runner = spawn(process.execPath, ['--import', 'tsx', resolve('src/codex-app-runner.ts'),
    '--session-id', 'intent', '--codex-bin', bin, '--traex-bin', bin, '--cwd', dir], {
    env: { ...process.env, HOME: dir, SESSION_DATA_DIR: dir, TRAE_HOME: dir, TEST_MODE: mode, CALLS: calls,
      FINISH_TOOL: join(dir, 'finish-tool'), TRAEX_ADAPTIVE_MODELS: '', TRAEX_APP_SERVER_DEFAULT: mode === 'waiting' ? '1' : '0',
      ...(mode === 'waiting' ? { TRAEX_ADAPTIVE_MODELS: 'gpt-5.5,gpt-6.1-sol' } : {}) }, stdio: ['pipe', 'pipe', 'pipe'],
  });
  let output = ''; runner.stdout.on('data', data => { output += data; }); runner.stderr.on('data', data => { output += data; });
  const state = () => sessionModelStatus(dir, 'intent');
  const rows = () => readFileSync(calls, 'utf8').trim().split('\n').map(line => JSON.parse(line));
  const send = (content: string) => runner.stdin.write('::botmux-codex-app:' + Buffer.from(JSON.stringify({ type: 'message', content })).toString('base64') + '\n');
  try {
    await vi.waitFor(() => expect(state().runtime?.phase, output).toBe('ready'), { timeout: 10000 });
    if (mode !== 'new') {
      send('原任务需要继续完成');
      await vi.waitFor(() => expect(mode === 'waiting' ? state().runtime?.routing?.state : state().runtime?.phase, output)
        .toBe(mode === 'waiting' ? 'waiting' : 'running'), { timeout: 10000 });
    }
    send('<user_message>本会话切换成 gpt 6.1 xhigh 不是 fast，继续原任务</user_message>');
    await vi.waitFor(() => expect(state().desired?.serviceTier, output).toBe('default'), { timeout: 10000 });
    if (mode === 'tools') {
      expect(rows().some(row => row.method === 'turn/interrupt')).toBe(false);
      writeFileSync(join(dir, 'finish-tool'), 'done');
    }
    await vi.waitFor(() => expect(state().status, output).toBe('verified'), { timeout: 10000 });
    expect(state().runtime?.threadId).toBe('same-thread');
    expect(state().runtime?.selection).toMatchObject({ model: 'gpt-6.1-sol', effort: 'xhigh', serviceTier: 'default', routingMode: 'fixed' });
    const turns = rows().filter(row => row.method === 'turn/start');
    expect(turns.map(row => row.params.model)).toEqual(['busy', 'tools'].includes(mode) ? ['gpt-5.5', 'gpt-6.1-sol'] : ['gpt-6.1-sol']);
    expect(turns.at(-1).params).toMatchObject({ model: 'gpt-6.1-sol', effort: 'xhigh', serviceTier: 'default' });
    if (mode === 'waiting') expect(turns[0].params.input[0].text).toContain('原任务需要继续完成');
    if (mode === 'tools') expect(rows().findIndex(row => row.method === 'turn/interrupt')).toBeGreaterThan(rows().findIndex(row => row.method === 'tool_finished'));
    expect(rows().filter(row => row.method === 'turn/interrupt')).toHaveLength(['busy', 'tools'].includes(mode) ? 1 : 0);
  } finally {
    const done = new Promise<void>(resolve => runner.once('exit', () => resolve())); runner.kill(); await done;
    rmSync(dir, { recursive: true, force: true });
  }
}, 20000);
