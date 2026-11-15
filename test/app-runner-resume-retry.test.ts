import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { expect, it, vi } from 'vitest';
import { readSessionModelRuntime } from '../src/services/session-model-store.js';

it('keeps the runner alive after a history error and retries the original ID after repair', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'resume-retry-'));
  const calls = join(dir, 'calls.jsonl'), repaired = join(dir, 'repaired'), bin = join(dir, 'server');
  writeFileSync(bin, `#!/usr/bin/env node
const fs=require('node:fs'),rl=require('node:readline');
rl.createInterface({input:process.stdin}).on('line',line=>{
 const m=JSON.parse(line);if(!m.id)return;
 fs.appendFileSync(process.env.CALLS,JSON.stringify(m)+'\n');
 const send=x=>console.log(JSON.stringify(x));let result={};
 if(m.method==='config/read')result={config:{model:'gpt-6.1-sol',model_reasoning_effort:'medium'}};
 if(m.method==='thread/resume'){
  if(!fs.existsSync(process.env.REPAIRED)){send({id:m.id,error:{code:-32603,message:'migration 1 was previously applied but has been modified'}});return;}
  result={thread:{id:m.params.threadId}};
 }
 if(m.method==='turn/start'){
  send({id:m.id,result:{turn:{id:'fake-turn',status:'inProgress'}}});
  setTimeout(()=>send({method:'turn/completed',params:{turn:{id:'fake-turn',status:'completed'}}}),10);return;
 }
 send({id:m.id,result});
});
`.replace("JSON.stringify(m)+'\n'", "JSON.stringify(m)+'\\n'"), { mode: 0o700 });
  const child = spawn(process.execPath, ['--import', 'tsx', resolve('src/codex-app-runner.ts'),
    '--session-id', 'retry', '--thread-id', 'original-thread', '--codex-bin', bin, '--cwd', dir], {
    env: { ...process.env, HOME: dir, CODEX_HOME: dir, SESSION_DATA_DIR: dir,
      CALLS: calls, REPAIRED: repaired, TRAEX_ADAPTIVE_MODELS: '', TRAEX_APP_SERVER_DEFAULT: '',
      BOT_SHARED_CONTEXT_GROUP: '' }, stdio: ['pipe', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', data => { output += data; });
  child.stderr.on('data', data => { output += data; });
  const rows = () => readFileSync(calls, 'utf8').trim().split('\n').map(line => JSON.parse(line));
  const send = (content: string) => child.stdin.write('::botmux-codex-app:' +
    Buffer.from(JSON.stringify({ type: 'message', content })).toString('base64') + '\n');
  try {
    await vi.waitFor(() => expect(readSessionModelRuntime(dir, 'retry')?.phase, output).toBe('failed'), { timeout: 10000 });
    expect(child.exitCode).toBeNull();
    send('retry while unavailable');
    await vi.waitFor(() => expect(rows().filter(r => r.method === 'thread/resume')).toHaveLength(2));
    expect(rows().some(r => r.method === 'thread/start' || r.method === 'turn/start')).toBe(false);
    await vi.waitFor(() => expect(output).toContain('Codex App runner error:'));
    writeFileSync(repaired, 'ready');
    send('retry after repair');
    await vi.waitFor(() => expect(rows().some(r => r.method === 'turn/start')).toBe(true));
    expect(rows().filter(r => r.method === 'thread/resume').every(r => r.params.threadId === 'original-thread')).toBe(true);
    expect(rows().some(r => r.method === 'thread/start')).toBe(false);
    expect(rows().find(r => r.method === 'turn/start').params.threadId).toBe('original-thread');
    expect(output).not.toContain('starting a fresh thread');
  } finally {
    const exited = new Promise<void>(done => child.once('exit', () => done()));
    if (child.exitCode === null) { child.kill(); await exited; }
    rmSync(dir, { recursive: true, force: true });
  }
}, 15000);
