import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { mkdtempSync, writeFileSync, appendFileSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readCodexSessionStatistics, codexStatisticsText } from '../src/services/codex-session-statistics.js';
import { readCodexSyncEvents } from '../src/services/codex-sync-reader.js';
import { publicCodexEvent } from '../src/services/codex-sync-events.js';

beforeEach(() => vi.stubEnv('BOTMUX_BOT_INDEX', '2'));
afterEach(() => vi.unstubAllEnvs());
const dirs: string[] = [];
const fixture = () => { const d = mkdtempSync(join(tmpdir(), 'codex-stats-')); dirs.push(d); const p = join(d, 'rollout.jsonl'); writeFileSync(p, ''); return p; };
const event = (type: string, payload: unknown, at = 1_800_000_000_000) => JSON.stringify({ type, payload, timestamp: new Date(at).toISOString() }) + '\n';
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

it('counts cumulative usage once, separates live work from idle time, and deduplicates completion', () => {
  const path = fixture(), start = 1_800_000_000_000;
  const complete = event('event_msg', { type:'task_complete', turn_id:'a', started_at:start/1000, completed_at:start/1000+10, duration_ms:9000 }, start+10000);
  writeFileSync(path, event('session_meta', {id:'thread'}, start) + event('event_msg', {type:'task_started',turn_id:'a',started_at:start/1000}, start) +
    event('event_msg', {type:'token_count',info:{total_token_usage:{input_tokens:1000,output_tokens:40,cached_input_tokens:700}}}, start+1000));
  expect(readCodexSessionStatistics(path,start+5000,true)).toMatchObject({runningMs:5000,inputTokens:1000,outputTokens:40,cachedTokens:700});
  appendFileSync(path, complete+complete);
  expect(readCodexSessionStatistics(path,start+86400000,false)).toMatchObject({runningMs:9000,turns:1,inputTokens:1000});
  const before = readFileSync(path,'utf8');
  for(let i=0;i<100;i++) readCodexSessionStatistics(path,start+86400000,false);
  expect(readFileSync(path,'utf8')).toBe(before);
});

it('does not invent days of runtime for a dead/aborted worker; handles split lines and rotation', () => {
  const path=fixture(), start=1_800_000_000_000;
  writeFileSync(path,event('event_msg',{type:'task_started',turn_id:'a'},start));
  expect(readCodexSessionStatistics(path,start+86400000,false)).toMatchObject({runningMs:0,incomplete:true});
  const line=event('event_msg',{type:'turn_aborted',turn_id:'a'},start+3000);
  appendFileSync(path,line.slice(0,-2));
  expect(readCodexSessionStatistics(path,start+86400000,false)?.runningMs).toBe(0);
  appendFileSync(path,line.slice(-2));
  expect(readCodexSessionStatistics(path,start+86400000,false)).toMatchObject({runningMs:3000,incomplete:false});
  writeFileSync(path,event('session_meta',{id:'replacement'},start));
  expect(readCodexSessionStatistics(path)?.runningMs).toBe(0);
});

it('counts unique tools and keeps absent usage unknown in the compact footer', () => {
  const path=fixture(), start=1_800_000_000_000;
  const tool=event('response_item',{type:'function_call',call_id:'tool-a',name:'exec_command'});
  writeFileSync(path,event('session_meta',{id:'a'},start)+tool+tool);
  const stats=readCodexSessionStatistics(path);
  expect(stats).toMatchObject({tools:1,inputTokens:undefined});
  expect(codexStatisticsText(stats,new Date(start-86400000).toISOString(),start+2000)).toContain('消耗 — · 缓存率 — · 工具 1次');
  expect(codexStatisticsText(undefined)).toContain('消耗 —');
});

it('formats total tokens in hundred-millions and computes cache rate without counting cache twice',()=>{
  const text=codexStatisticsText({runningMs:791000,turns:1,tools:65,inputTokens:4690959,outputTokens:18298,cachedTokens:4581248,incomplete:false},undefined,0);
  expect(text.split('\n')).toHaveLength(2);
  expect(text).toContain('消耗 0.05亿 · 缓存率 97.7% · 工具 65次');
  expect(text).not.toMatch(/Token 输入|输出|含于输入|可用记录/);
});

it('serves shared incremental public events without reasoning, developer prompts, arguments or duplicate final copies', () => {
  const path=fixture();
  writeFileSync(path,event('response_item',{type:'reasoning',summary:[{text:'hidden'}]})+
    event('event_msg',{type:'user_message',message:'<botmux_reminder>meta</botmux_reminder><user_message>原文</user_message>'})+
    event('event_msg',{type:'agent_message',phase:'commentary',message:'进展。'})+
    event('response_item',{type:'function_call',call_id:'a',name:'exec_command',arguments:'password=secret'})+
    event('event_msg',{type:'agent_message',phase:'final_answer',message:'结果'})+
    event('event_msg',{type:'task_complete',turn_id:'t',last_agent_message:'结果'}));
  const first=readCodexSyncEvents(path);
  expect(first.events.map(e=>e.kind)).toEqual(['user','progress','tool','final']);
  expect(first.events[0].text).toBe('原文');
  expect(JSON.stringify(first)).not.toContain('secret');expect(JSON.stringify(first)).not.toContain('hidden');
  expect(readCodexSyncEvents(path,first.cursor).events).toEqual([]);
  const line=Buffer.from(event('event_msg',{type:'user_message',message:'中文追问'}));const cut=line.indexOf(Buffer.from('中文'))+1;
  appendFileSync(path,line.subarray(0,cut));expect(readCodexSyncEvents(path,first.cursor).events).toEqual([]);
  appendFileSync(path,line.subarray(cut));expect(readCodexSyncEvents(path,first.cursor).events[0].text).toBe('中文追问');
});

it('does not expose other response_item messages',()=>{
  expect(publicCodexEvent({type:'response_item',payload:{type:'message',role:'developer',content:'secret'}},'0')).toBeUndefined();
  for(const text of ['<external_codex_apps_open_page>{"page_id":null}</external_codex_apps_open_page>','<external_codex_apps_selected_page_part_1_of_1>private page snapshot</external_codex_apps_selected_page_part_1_of_1>','<environment_context>private context</environment_context>']){
    expect(publicCodexEvent({type:'response_item',payload:{type:'message',role:'user',content:[{type:'input_text',text}]}},'0')).toBeUndefined();
    expect(publicCodexEvent({type:'event_msg',payload:{type:'user_message',message:text}},'0')).toBeUndefined();
  }
});

it('supports canonical-only messages, deduplicates event copies and detects a larger in-place rewrite',()=>{
  const path=fixture(),start=1_800_000_000_000;
  const user=event('response_item',{type:'message',role:'user',content:[{type:'input_text',text:'actual question'}]},start);
  const progress=event('response_item',{type:'message',role:'assistant',phase:'commentary',content:[{type:'output_text',text:'Working.\n'}]},start+1);
  const startEvent=event('event_msg',{type:'task_started',turn_id:'t'},start);
  writeFileSync(path,startEvent+user+event('event_msg',{type:'user_message',message:'actual question'},start)+progress+event('event_msg',{type:'agent_message',phase:'commentary',message:'Working.'},start+1));
  const first=readCodexSyncEvents(path);expect(first.events.map(e=>e.kind)).toEqual(['status','user','progress']);
  const stats=readCodexSessionStatistics(path,start+100,true);expect(stats?.runningMs).toBe(100);
  // Same inode, larger file, rewritten bytes before the old cursor.
  writeFileSync(path,event('session_meta',{id:'thread',padding:'x'.repeat(1500)},start)+startEvent+user+progress+
    event('event_msg',{type:'task_complete',turn_id:'t',duration_ms:300,last_agent_message:'Done'},start+300));
  const rewritten=readCodexSyncEvents(path,first.cursor);
  expect(rewritten.epoch).not.toBe(first.epoch);
  expect(rewritten.events.some(e=>e.kind==='final')).toBe(true);
  expect(readCodexSessionStatistics(path,start+1000,false)).toMatchObject({runningMs:300,turns:1});
});

it.each(['0', '1', undefined])('uses the same concise statistics for bot %s without double-counting cache', (botIndex) => {
  vi.stubEnv('BOTMUX_BOT_INDEX', botIndex);
  const stats = { runningMs: 791000, turns: 1, tools: 65, inputTokens: 4690959, outputTokens: 18298, cachedTokens: 4581248, incomplete: false };
  const text = codexStatisticsText(stats, undefined, 0);
  expect(text.split('\n')).toHaveLength(2);
  expect(text).toContain('耗 0.05亿 · 缓存 98%');
  expect(text).not.toContain('工具');
  expect(codexStatisticsText(undefined)).toContain('耗 — · 缓存 —');
  expect(codexStatisticsText(stats, undefined, 0, true)).toContain('Tools 65');
});
