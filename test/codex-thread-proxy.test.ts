import { afterEach, expect, it, vi } from 'vitest';
import { appendFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { CodexThreadProxy } from '../src/services/codex-thread-proxy.js';
import type { FollowupCheckpoint } from '../src/services/external-codex-bridge.js';

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'codex-thread-proxy-'));
  dirs.push(dir);
  const rolloutPath = join(dir, 'history.jsonl');
  writeFileSync(rolloutPath, '');
  const thread = {threadId:'original',rolloutPath,codexHome:dir,cwd:dir,bot:'Nene',title:'Original'};
  const state = join(dir, 'state.json');
  const event = (type: string, turn_id: string, last_agent_message?: string) =>
    JSON.stringify({type:'event_msg',payload:{type,turn_id,last_agent_message}})+'\n';
  return {dir,thread,state,event};
}

it('serializes two clients on the same original and keeps repeat submissions idempotent across restart', async () => {
  const {thread,state,event} = fixture();
  const submit = vi.fn(async (_home: string, id: string, _path: string, _text: string, checkpoint: FollowupCheckpoint, requestId?: string) => {
    expect(id).toBe('original');
    checkpoint();
    const turn = 'turn-' + requestId;
    appendFileSync(thread.rolloutPath, event('task_started', turn));
    checkpoint(true, turn);
    return true;
  });
  const proxy = new CodexThreadProxy([thread], state, submit);
  proxy.enqueue('original','vscode-0001','first');
  proxy.enqueue('original','feishu-0002','second');
  await Promise.all([proxy.tick(), proxy.tick()]);
  expect(submit).toHaveBeenCalledTimes(1);
  expect(proxy.status('original')).toMatchObject({phase:'running',queued:1});
  expect(proxy.enqueue('original','vscode-0001','different')).toEqual({conflict:true});
  const restored = new CodexThreadProxy([thread], state, submit);
  expect(restored.enqueue('original','vscode-0001','first')).toMatchObject({status:'accepted',phase:'running'});
  await restored.tick();
  expect(submit).toHaveBeenCalledTimes(1);
  appendFileSync(thread.rolloutPath, event('task_complete','turn-vscode-0001','done'));
  await restored.tick();
  await restored.tick();
  expect(submit.mock.calls.map(call => call[5])).toEqual(['vscode-0001','feishu-0002']);
  expect(restored.receipt('original','vscode-0001')).toMatchObject({phase:'finished'});
  expect(JSON.parse(readFileSync(state, 'utf8'))[0].text).toBeUndefined();
});

it('recovers a lost acknowledgement only from the exact durable client ID', async () => {
  const {thread,state,event,dir} = fixture();
  const submit = vi.fn(async (_home: string, _id: string, _path: string, _text: string, checkpoint: FollowupCheckpoint) => {
    checkpoint();
    throw Error('lost response');
  });
  let proxy = new CodexThreadProxy([thread], state, submit);
  proxy.enqueue('original','unknown-0001','same text');
  await proxy.tick();
  proxy = new CodexThreadProxy([thread], state, submit);
  const db = new DatabaseSync(join(dir,'thread_history_1.sqlite'));
  db.exec('CREATE TABLE thread_items(thread_id TEXT, turn_id TEXT, item_type TEXT, item_json TEXT)');
  const insert = db.prepare('INSERT INTO thread_items VALUES(?,?,?,?)');
  insert.run('original','unrelated','userMessage',JSON.stringify({clientId:'separate-request',content:'same text'}));
  insert.run('original','accepted-turn','userMessage',JSON.stringify({clientId:'unknown-0001'}));
  db.close();
  appendFileSync(thread.rolloutPath, event('task_started','accepted-turn') + event('task_complete','accepted-turn','finished'));
  await proxy.tick();
  expect(proxy.receipt('original','unknown-0001')).toMatchObject({phase:'finished',turnId:'accepted-turn'});
  expect(submit).toHaveBeenCalledTimes(1);
});
