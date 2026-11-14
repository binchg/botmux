import { it, expect } from 'vitest';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runExternalCodexTurn } from '../src/services/external-codex-runtime.js';

it('submits a Lark follow-up to the exact fork in the default library and waits for completion', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'external-codex-rpc-'));
  const binary = join(dir, 'mock-codex.cjs');
  writeFileSync(binary, `#!/usr/bin/env node
const fs = require('node:fs');
const rl = require('node:readline').createInterface({input:process.stdin});
rl.on('line', l => {
 const m=JSON.parse(l); fs.appendFileSync('requests.jsonl', JSON.stringify({m,home:process.env.CODEX_HOME})+'\\n');
 if(!m.id)return;
 const result=m.method==='turn/start'?{turn:{id:'turn'}}:{};
 process.stdout.write(JSON.stringify({id:m.id,result})+'\\n');
 if(m.method==='turn/start')setTimeout(()=>process.stdout.write(JSON.stringify({method:'turn/completed',params:{threadId:'fork',turn:{id:'turn',status:'completed'}}})+'\\n'),20);
});
`, { mode: 0o700 });
  try {
    let checkpoints = 0;
    await runExternalCodexTurn(binary, '/default-codex', {
      threadId: 'fork', rolloutPath: '', cwd: dir, larkAppId: 'app', chatId: 'chat', ownerOpenId: 'owner', rootMessageId: 'root',
    }, 'follow-up', () => { checkpoints++; });
    const rows = readFileSync(join(dir, 'requests.jsonl'), 'utf8').trim().split('\n').map(l => JSON.parse(l));
    expect(checkpoints).toBe(1);
    expect(rows.every(r => r.home === '/default-codex')).toBe(true);
    expect(rows.find(r => r.m.method === 'thread/resume').m.params.threadId).toBe('fork');
    expect(rows.find(r => r.m.method === 'turn/start').m.params.input).toEqual([{ type: 'text', text: 'follow-up' }]);
    expect(rows.some(r => r.m.method === 'thread/fork')).toBe(false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
