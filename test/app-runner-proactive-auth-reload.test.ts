import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { expect, it, vi } from 'vitest';

it('auth.json overnight replacement reloads the app-server before the next turn and resumes the same thread', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'auth-proactive-reload-'));
  const calls = join(dir, 'calls.jsonl');
  const generationFile = join(dir, 'generation');
  const authFile = join(dir, 'auth.json');
  const bin = join(dir, 'server');
  const timerShim = join(dir, 'timer-shim.mjs');
  writeFileSync(timerShim, `const interval=globalThis.setInterval;
globalThis.setInterval=(fn,ms,...args)=>interval(fn,ms===60000?20:ms,...args);`);
  writeFileSync(authFile, '{"generation":1}');
  writeFileSync(bin, `#!/usr/bin/env node
const fs=require('node:fs'),rl=require('node:readline');
const generation=fs.existsSync(process.env.GENERATION_FILE)
 ? Number(fs.readFileSync(process.env.GENERATION_FILE,'utf8'))+1 : 1;
fs.writeFileSync(process.env.GENERATION_FILE,String(generation));
const send=value=>console.log(JSON.stringify(value));
rl.createInterface({input:process.stdin}).on('line',line=>{
 const m=JSON.parse(line);if(!m.id)return;
 fs.appendFileSync(process.env.CALLS,JSON.stringify({generation,method:m.method,params:m.params})+'\\n');
 let result={};
 if(m.method==='config/read')result={config:{model:'gpt-test',model_reasoning_effort:'high'}};
 if(m.method==='hooks/list')result={data:[]};
 if(m.method==='thread/start'||m.method==='thread/resume')result={thread:{id:'original-thread'}};
 if(m.method==='turn/start'){
  const id='turn-'+generation; send({id:m.id,result:{turn:{id,status:'inProgress'}}});
  setTimeout(()=>send({method:'item/completed',params:{threadId:'original-thread',turnId:id,item:{id:'answer',type:'agentMessage',phase:'final_answer',text:'夜间认证已加载'}}}),10);
  setTimeout(()=>send({method:'turn/completed',params:{threadId:'original-thread',turn:{id,status:'completed'}}}),20); return;
 }
 send({id:m.id,result});
});
`, { mode: 0o700 });

  const child = spawn(process.execPath, ['--import', timerShim, '--import', 'tsx', resolve('src/codex-app-runner.ts'),
    '--session-id', 'auth-proactive', '--codex-bin', bin, '--cwd', dir, '--locale', 'zh'], {
    env: {
      ...process.env,
      HOME: dir,
      CODEX_HOME: dir,
      SESSION_DATA_DIR: dir,
      CALLS: calls,
      GENERATION_FILE: generationFile,
      TRAEX_ADAPTIVE_MODELS: '',
      TRAEX_APP_SERVER_DEFAULT: '',
      BOT_SHARED_CONTEXT_GROUP: '',
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', data => { output += data; });
  child.stderr.on('data', data => { output += data; });
  const send = (content: string) => child.stdin.write('::botmux-codex-app:'
    + Buffer.from(JSON.stringify({ type: 'message', content })).toString('base64') + '\n');
  try {
    await vi.waitFor(() => expect(output).toContain('Codex App connected.'), { timeout: 10_000 });
    writeFileSync(join(dir, 'auth.next'), '{"generation":2,"changed":true}');
    renameSync(join(dir, 'auth.next'), authFile);
    // Idle sessions retain their process; only a new user turn may replace it.
    // The former 60-second watcher is accelerated above, so this also detects
    // a regression without waiting a minute or launching hundreds of sessions.
    await new Promise(resolve => setTimeout(resolve, 150));
    expect(readFileSync(generationFile, 'utf8')).toBe('1');
    send('正常执行一次');
    await vi.waitFor(() => expect(output).toContain('\u001b]777;botmux:final:'), { timeout: 10_000 });
    const rows = readFileSync(calls, 'utf8').trim().split('\n').map(line => JSON.parse(line));
    expect(readFileSync(generationFile, 'utf8')).toBe('2');
    expect(rows.filter(row => row.method === 'turn/start')).toHaveLength(1);
    expect(rows.filter(row => row.method === 'thread/start')).toHaveLength(1);
    expect(rows.filter(row => row.method === 'thread/resume')).toHaveLength(1);
    expect(rows.find(row => row.method === 'turn/start')?.generation).toBe(2);
    expect(output.match(/\[user\]/g)).toHaveLength(1);
  } finally {
    const exited = new Promise<void>(done => child.once('exit', () => done()));
    if (child.exitCode === null) { child.kill(); await exited; }
    rmSync(dir, { recursive: true, force: true });
  }
}, 15_000);
