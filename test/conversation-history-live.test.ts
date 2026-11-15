import { afterEach, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ensureNativeConversationHistory, ensureConversationHistory, visibleHistoryText } from '../src/services/conversation-history-store.js';
import { renderConversationHistory } from '../src/services/conversation-history-page.js';
import { readHistoryBundle } from '../src/services/conversation-history-reader.js';
import { handleConversationHistoryRequest } from '../src/services/conversation-history-http.js';
import { cachedHistoryPage } from '../src/services/conversation-history-page-cache.js';
import { formatStatisticsDuration } from '../src/services/codex-session-statistics.js';
import { nativeConversationHistoryButtons } from '../src/im/lark/conversation-history-button.js';
import { config } from '../src/config.js';
import type { Session } from '../src/types.js';
import type { IncomingMessage, ServerResponse } from 'node:http';
const dirs: string[] = [];
const storage=()=>{const d=mkdtempSync(join(tmpdir(),'history-live-'));dirs.push(d);return d};
afterEach(()=>{vi.unstubAllEnvs();dirs.splice(0).forEach(d=>rmSync(d,{recursive:true,force:true}))});
const binding={threadId:'native-test',rolloutPath:'',cwd:'/test',larkAppId:'nene',rootMessageId:'topic',firstUserMessage:'原始问题'};
it('native topic grants remain stable, isolate bot/topic identity and only renew for user input',()=>{
  const dir=storage(),now=Date.now();const a=ensureNativeConversationHistory(binding,false,dir,now);
  expect(ensureNativeConversationHistory(binding,false,dir,now+1000).token).toBe(a.token);
  expect(ensureNativeConversationHistory(binding,false,dir,now+1000).expiresAt).toBe(a.expiresAt);
  expect(ensureNativeConversationHistory(binding,true,dir,now+1000).expiresAt).toBe(a.expiresAt+1000);
  expect(ensureNativeConversationHistory({...binding,larkAppId:'other'},false,dir).token).not.toBe(a.token);
  expect(ensureNativeConversationHistory({...binding,rootMessageId:'other'},false,dir).token).not.toBe(a.token);
});
it('native history reads the explicitly bound local transcript without registering a new CLI session',async()=>{
  const dir=storage(),path=join(dir,'source.jsonl');
  const records=[['user',undefined,'<user_message>原始问题</user_message>'],['assistant','commentary','完整进展'],['assistant','final_answer','最终结果']];
  writeFileSync(path,records.map(([role,phase,text],i)=>JSON.stringify({type:'response_item',timestamp:new Date(1000+i).toISOString(),payload:{type:'message',role,phase,content:[{type:role==='user'?'input_text':'output_text',text}]}})).join('\n')+'\n');
  const before=readFileSync(path,'utf8'),grant=ensureNativeConversationHistory({...binding,rolloutPath:path},false,dir);
  expect((await readHistoryBundle(grant,dir)).messages.map(m=>m.content)).toEqual(['原始问题','完整进展','最终结果']);
  expect(readFileSync(path,'utf8')).toBe(before);
});
it('shared public input filter excludes injected page/system context and unwraps only the question',()=>{
  for(const input of ['<external_codex_apps_selected_page_part_1_of_1>private</external_codex_apps_selected_page_part_1_of_1>','<user_instructions>rules</user_instructions>','# AGENTS.md instructions for /private'])expect(visibleHistoryText(input,'user')).toBe('');
  expect(visibleHistoryText('<botmux_reminder>internal</botmux_reminder><user_message>真实追问</user_message><sender id="hidden"/>','user')).toBe('真实追问');
});
it('full chronological page includes each public message once, times, MathML and continuous refresh',()=>{
  const dir=storage(),h=ensureNativeConversationHistory(binding,false,dir);
  const msgs=[{id:'u',kind:'user' as const,content:'唯一追问',at:1000},{id:'p',kind:'assistant_progress' as const,content:'唯一进展',at:2000},{id:'f',kind:'assistant_final' as const,content:'唯一结果 $\\sum_{i=1}^n x_i$ `code $x$`',at:3000}];
  const p=renderConversationHistory(h,msgs),body=p.html.match(/<article[^>]*>([\s\S]*?)<\/article>/)![1];
  for(const text of ['唯一追问','唯一进展','唯一结果'])expect(body.split(text)).toHaveLength(2);
  expect(body).not.toContain('<details');expect(body).toContain('最终回复');expect(body).toContain('原始追问');expect(body).toContain('<math');expect(body).toContain('<code>code $x$</code>');
  expect(p.html).toContain('setTimeout(()=>load(retry),delay)');expect(p.html).toContain('北京时间');expect(p.revision).toBe(renderConversationHistory(h,msgs).revision);
});
it('unchanged live page returns 204 while expired grants remain denied without renewal',async()=>{
  const dir=storage(),now=Date.now(),h=ensureConversationHistory({sessionId:'live-test',title:'test'} as Session,dir,now);
  const state=cachedHistoryPage(h,dir);await vi.waitFor(()=>expect(state.page).toBeDefined());
  const request=async(at:number)=>{let status=0;await handleConversationHistoryRequest({method:'GET',headers:{host:'localhost'},socket:{remoteAddress:'127.0.0.1',localAddress:'127.0.0.1'}} as IncomingMessage,{writeHead:(s:number)=>{status=s},end:()=>{}} as unknown as ServerResponse,new URL(`http://localhost/conversation/${h.token}?complete=1&revision=${state.page!.revision}`),{dataDir:dir,now:at});return status};
  expect(await request(now)).toBe(204);expect(await request(h.expiresAt)).toBe(410);
});
it('native card button shares a direct host:port URL and a stable token',()=>{
  vi.stubEnv('SESSION_DATA_DIR',storage());vi.stubEnv('BOTMUX_HISTORY_BASE_URL','http://100.64.0.1:7891');
  const button=nativeConversationHistoryButtons(binding)[0];expect(button.multi_url.url).toMatch(/^http:\/\/100\.64\.0\.1:7891\/conversation\/[\w-]{43}$/);
  expect(nativeConversationHistoryButtons(binding)[0].multi_url.url).toBe(button.multi_url.url);
});
it('duration omits seconds and retains days, hours and minutes',()=>{
  expect(formatStatisticsDuration((((3*24+13)*60+36)*60+45)*1000)).toBe('3天13时36分');
  expect(formatStatisticsDuration((44*60+30)*1000)).toBe('44分');expect(formatStatisticsDuration(45000)).toBe('不足1分钟');expect(formatStatisticsDuration(0)).toBe('不足1分钟');
});

it('history network gate accepts direct Tailnet only and rejects public/LAN/forwarded access even with a valid token',async()=>{
  const {historyNetworkAllowed}=await import('../src/services/conversation-history-network.js');
  const req=(remote:string,local:string,host:string,extra={})=>({headers:{host,...extra},socket:{remoteAddress:remote,localAddress:local}} as IncomingMessage);
  expect(historyNetworkAllowed(req('100.70.1.2','100.64.0.1','100.64.0.1:7891'))).toBe(true);
  expect(historyNetworkAllowed(req('::ffff:100.70.1.2','::ffff:100.64.0.1','100.64.0.1:7891'))).toBe(true);
  expect(historyNetworkAllowed(req('fd7a:115c:a1e0::2','fd7a:115c:a1e0::1','[fd7a:115c:a1e0::1]:7891'))).toBe(true);
  for(const r of [req('8.8.8.8','100.64.0.1','100.64.0.1:7891'),req('192.168.31.2','192.168.31.251','192.168.31.251:7891'),req('127.0.0.1','127.0.0.1','public.example'),req('100.70.1.2','100.64.0.1','public.example'),req('127.0.0.1','127.0.0.1','localhost',{'x-forwarded-for':'8.8.8.8'})])expect(historyNetworkAllowed(r)).toBe(false);
  const dir=storage(),now=Date.now(),h=ensureConversationHistory({sessionId:'network-test',title:'private'} as Session,dir,now);let status=0;
  await handleConversationHistoryRequest(req('8.8.8.8','100.64.0.1','100.64.0.1:7891'),{writeHead:(s:number)=>{status=s},end:()=>{}} as unknown as ServerResponse,new URL(`http://100.64.0.1:7891/conversation/${h.token}`),{dataDir:dir,now});expect(status).toBe(403);
});
