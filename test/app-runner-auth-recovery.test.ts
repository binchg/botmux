import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { expect, it, vi } from 'vitest';

it('refresh token 轮换失败后重启 app-server 并沿原线程静默重试一次', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'auth-rotation-recovery-'));
  const calls = join(dir, 'calls.jsonl');
  const generationFile = join(dir, 'generation');
  const bin = join(dir, 'server');
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
  const id='turn-'+generation;
  send({id:m.id,result:{turn:{id,status:'inProgress'}}});
  if(generation===1){
   setTimeout(()=>send({method:'turn/completed',params:{threadId:'original-thread',turn:{id,status:'failed',error:{message:'Your access token could not be refreshed because your refresh token was already used. Please log out and sign in again.'}}}}),10);
  }else{
   setTimeout(()=>send({method:'item/completed',params:{threadId:'original-thread',turnId:id,item:{id:'answer',type:'agentMessage',phase:'final_answer',text:'认证恢复成功'}}}),10);
   setTimeout(()=>send({method:'turn/completed',params:{threadId:'original-thread',turn:{id,status:'completed'}}}),20);
  }
  return;
 }
 send({id:m.id,result});
});
`, { mode: 0o700 });

  const child = spawn(process.execPath, ['--import', 'tsx', resolve('src/codex-app-runner.ts'),
    '--session-id', 'auth-recovery', '--codex-bin', bin, '--cwd', dir, '--locale', 'zh'], {
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
    send('只执行一次');
    await vi.waitFor(() => expect(output).toContain('\u001b]777;botmux:final:'), { timeout: 10_000 });
    const finalPayload = output.match(/\u001b\]777;botmux:final:([^\u0007]+)\u0007/)?.[1];
    expect(finalPayload).toBeTruthy();
    expect(JSON.parse(Buffer.from(finalPayload!, 'base64').toString('utf8')).content).toContain('认证恢复成功');
    const rows = readFileSync(calls, 'utf8').trim().split('\n').map(line => JSON.parse(line));
    expect(readFileSync(generationFile, 'utf8')).toBe('2');
    expect(rows.filter(row => row.method === 'turn/start')).toHaveLength(2);
    expect(rows.filter(row => row.method === 'thread/start')).toHaveLength(1);
    expect(rows.filter(row => row.method === 'thread/resume')).toHaveLength(1);
    expect(output.match(/\[user\]/g)).toHaveLength(1);
    expect(output.match(/\[auto continue\]/g)).toHaveLength(1);
    expect(output).toContain('尚未产生模型输出或工具副作用');
    expect(output).not.toContain('Codex App turn failed:');
  } finally {
    const exited = new Promise<void>(done => child.once('exit', () => done()));
    if (child.exitCode === null) { child.kill(); await exited; }
    rmSync(dir, { recursive: true, force: true });
  }
}, 15_000);
