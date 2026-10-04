import { afterEach, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { parseModelCommand } from '../src/cli/session-model-command.js';
import { validateModelSelection } from '../src/services/session-model-selection.js';
import { executorHandoff } from '../src/services/session-executor-handoff.js';
import { sessionModelStatus, writeSessionModel, readSessionExecutor } from '../src/services/session-model-store.js';

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
const catalog = [{ id: 'gpt-test', configName: 'gpt-test', model: 'GPT-Test', defaultReasoningEffort: 'high', supportedReasoningEfforts: [{ reasoningEffort: 'high' }, { reasoningEffort: 'xhigh' }], serviceTiers: [] }];

it('normalizes Trae catalog names, resets provider-specific priority and rejects unsupported speed', () => {
  const previous = { model: 'gpt-test', effort: 'xhigh', serviceTier: 'priority' };
  expect(validateModelSelection({ executor: 'traex' }, catalog, previous)).toEqual({ model: 'gpt-test', effort: 'xhigh', executor: 'traex', serviceTier: 'default' });
  expect(() => validateModelSelection({ executor: 'traex', serviceTier: 'priority' }, catalog, previous)).toThrow('unsupported_service_tier');
  expect(validateModelSelection({ model: 'GPT-Test', executor: 'codex', serviceTier: 'default' }, catalog).model).toBe('gpt-test');
  expect(parseModelCommand(['executor','traex']).body).toEqual({ executor: 'traex' });
  expect(parseModelCommand(['speed','default']).body).toEqual({ serviceTier: 'default' });
  expect(parseModelCommand(['hooks','always','--all'])).toMatchObject({all:true,body:{hookTrust:'always'}});
  expect(()=>parseModelCommand(['hooks','always','--all','--session-id','x'])).toThrow('invalid_global_hook_command');
  expect(parseModelCommand(['hooks','always']).body).toEqual({ hookTrust: 'always' });
  expect(validateModelSelection({hookTrust:'always'},catalog,{model:'gpt-test',effort:'high'}).hookTrust).toBe('always');
  expect(()=>validateModelSelection({hookTrust:'disable'},catalog,{model:'gpt-test',effort:'high'})).toThrow('unsupported_hook_trust');
  expect(parseModelCommand(['list','--executor','traex']).executor).toBe('traex');
  expect(parseModelCommand(['set','gpt-test','high','--executor','traex','--speed','default']).body).toEqual({ model:'gpt-test', effort:'high', executor:'traex', serviceTier:'default' });
});

it('bounds handoff to visible messages without copying reasoning, tools, or recursive handoffs', () => {
  const text = executorHandoff({ turns: [{ items: [
    { type:'reasoning', text:'hidden-secret' }, { type:'commandExecution', aggregatedOutput:'tool-secret' },
    { type:'userMessage', content:[{ type:'text', text:'<botmux_executor_handoff>older-secret</botmux_executor_handoff><user_message>remember apple</user_message>' }] },
    { type:'agentMessage', text:'remembered' },
  ] }] });
  expect(text).toContain('remember apple'); expect(text).toContain('remembered');
  for (const secret of ['hidden-secret','tool-secret','older-secret']) expect(text).not.toContain(secret);
});

it('switches only after the current turn, preserves visible context and recovers the selected executor after restart', async () => {
  const d = mkdtempSync(join(tmpdir(),'botmux-executor-')); dirs.push(d);
  const calls = join(d,'calls.jsonl');
  for (const name of ['codex','traex']) writeFileSync(join(d,name), `#!/usr/bin/env node
const fs=require('node:fs'),rl=require('node:readline'),name=require('node:path').basename(__filename);let n=0;
const send=x=>process.stdout.write(JSON.stringify(x)+'\\n');
rl.createInterface({input:process.stdin}).on('line',line=>{const m=JSON.parse(line);if(!m.id)return;
fs.appendFileSync(process.env.EXECUTOR_TEST_CALLS,JSON.stringify({name,method:m.method,params:m.params})+'\\n');let result={};
if(m.method==='config/read')result={config:{model:'gpt-test',model_reasoning_effort:'high',model_provider:name}};
if(m.method==='thread/start'||m.method==='thread/resume')result={model:'gpt-test',thread:{id:name+'-thread'}};
if(m.method==='thread/read')result={thread:{turns:[{items:[{type:'userMessage',content:[{type:'text',text:'remember apple'}]},{type:'agentMessage',text:'remembered'}]}]}};
if(m.method==='turn/start'){const id='turn-'+(++n);send({id:m.id,result:{turn:{id}}});setTimeout(()=>{send({method:'item/completed',params:{threadId:name+'-thread',item:{type:'agentMessage',id:'answer-'+n,text:'synthetic complete',phase:'final_answer'}}});send({method:'turn/completed',params:{threadId:name+'-thread',turn:{id,status:'completed'}}});},150);return;}
send({id:m.id,result});});
`, { mode:0o700 });
  const start = () => spawn(process.execPath, ['--import','tsx',resolve('src/codex-app-runner.ts'),'--session-id','switch-test','--codex-bin',join(d,'codex'),'--traex-bin',join(d,'traex'),'--cwd',d], { cwd:process.cwd(),env:{...process.env,HOME:d,SESSION_DATA_DIR:d,EXECUTOR_TEST_CALLS:calls},stdio:['pipe','pipe','pipe'] });
  let runner = start(); let errors = '';
  const attach = () => { runner.stdout.on('data',()=>{});runner.stderr.on('data',x=>{errors+=x;}); };
  attach(); const state = () => sessionModelStatus(d,'switch-test');
  const send = () => runner.stdin.write('::botmux-codex-app:'+Buffer.from(JSON.stringify({type:'message',content:'continue'})).toString('base64')+'\n');
  const stop = async () => { const done = new Promise<void>(resolve=>runner.once('exit',()=>resolve()));runner.kill();await done; };
  try {
    await vi.waitFor(()=>expect(state().runtime?.phase,errors).toBe('ready'),{timeout:15000});
    expect(state().runtime?.selection?.hookTrust).toBe('review');
    const initial = writeSessionModel(d,'switch-test',{model:'gpt-test',effort:'high',executor:'codex-app'}); send();
    await vi.waitFor(()=>expect(state().runtime?.phase).toBe('running'));
    writeSessionModel(d,'switch-test',{model:'gpt-test',effort:'xhigh',executor:'traex',serviceTier:'default',hookTrust:'always'});
    await vi.waitFor(()=>expect(state().runtime?.phase).toBe('completed'));
    expect(state().runtime?.revision).toBe(initial.revision); send();
    await vi.waitFor(()=>expect(state().status,errors).toBe('verified'));
    expect(state().runtime?.selection?.executor).toBe('traex');
    expect(state().runtime?.threadId).toBe('traex-thread');
    const rows=readFileSync(calls,'utf8').trim().split('\n').map(x=>JSON.parse(x));
    const turns=rows.filter(x=>x.method==='turn/start');
    expect(turns.map(x=>x.name)).toEqual(['codex','traex']);
    expect(turns[1].params.input[0].text).toContain('remember apple');
    expect(turns[1].params.input[0].text).not.toContain('hidden-secret');
    expect(readSessionExecutor(d,'switch-test')?.handoff).toBeUndefined();
    expect(rows.find(x=>x.name==='traex'&&x.method==='thread/start').params.config.bypass_hook_trust).toBe(true);
    expect(state().runtime?.selection?.hookTrust).toBe('always');
    writeSessionModel(d,'switch-test',{model:'gpt-test',effort:'xhigh',executor:'traex',serviceTier:'default',hookTrust:'review'});send();
    await vi.waitFor(()=>expect(state().status).toBe('verified'));
    expect(state().runtime?.threadId).toBe('traex-thread');
    expect(state().runtime?.selection?.hookTrust).toBe('review');
    mkdirSync(join(d,'.botmux'),{recursive:true});
    for (const hookTrust of ['always','review']) {
      writeFileSync(join(d,'.botmux','config.json'),JSON.stringify({hookTrust}));send();
      await vi.waitFor(()=>expect(state().runtime?.phase).toBe('running'));
      await vi.waitFor(()=>expect(state().runtime?.phase).toBe('completed'));
      expect(state().runtime?.selection?.hookTrust).toBe(hookTrust);
      expect(state().runtime?.threadId).toBe('traex-thread');
    }
    writeSessionModel(d,'switch-test',{model:'wrong-target',effort:'high',executor:'codex-app'}); send();
    await vi.waitFor(()=>expect(state().status).toBe('failed'));
    expect(readSessionExecutor(d,'switch-test')?.executor).toBe('traex');
    expect(state().runtime?.selection?.executor).toBe('traex');
    writeSessionModel(d,'switch-test',{model:'gpt-test',effort:'xhigh',executor:'traex',serviceTier:'default'}); send();
    await vi.waitFor(()=>expect(state().status).toBe('verified'));
    await stop(); runner=start();attach();
    await vi.waitFor(()=>expect(state().runtime?.pid,errors).toBe(runner.pid),{timeout:15000});send();
    await vi.waitFor(()=>expect(state().status,errors).toBe('verified'));
    const recovered=readFileSync(calls,'utf8').trim().split('\n').map(x=>JSON.parse(x));
    expect(recovered.filter(x=>x.method==='thread/resume').at(-1)).toMatchObject({name:'traex',params:{threadId:'traex-thread'}});
    expect(recovered.filter(x=>x.method==='turn/start').at(-1).params.input[0].text).toBe('continue');
  } finally { await stop(); }
},20000);
