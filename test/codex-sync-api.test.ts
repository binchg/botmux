import { beforeEach, afterEach, it, expect, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const ctx=vi.hoisted(()=>({dir:'',sessions:[] as any[],live:undefined as any,send:vi.fn(),reply:vi.fn(),reconcile:vi.fn()}));
vi.mock('../src/config.js',()=>({config:{session:{get dataDir(){return ctx.dir;}}}}));
vi.mock('node:os',async original=>({...await original<typeof import('node:os')>(),homedir:()=>ctx.dir}));
vi.mock('../src/services/session-store.js',()=>({listSessions:()=>ctx.sessions}));
vi.mock('../src/services/session-model-store.js',()=>({readSessionModelRuntime:()=>undefined,modelRuntimeAlive:()=>false}));
vi.mock('../src/services/transcript-resolver.js',()=>({resolveSessionTranscriptPath:()=>({path:join(ctx.dir,'rollout.jsonl')})}));
vi.mock('../src/services/external-codex-runtime.js',()=>({externalCodexBridge:{owns:()=>false}}));
vi.mock('../src/bot-registry.js',()=>({getBot:()=>({config:{name:'Test Bot'}}),effectiveBotDisplayName:()=> 'Test Bot'}));
vi.mock('../src/im/lark/client.js',()=>({replyMessage:(...a:any[])=>ctx.reply(...a)}));
vi.mock('../src/core/worker-pool.js',()=>({findActiveBySessionId:()=>ctx.live,getActiveSessionsRegistry:()=>new Map()}));
vi.mock('../src/core/session-manager.js',()=>({reconcileActiveSessionRegistry:(...a:any[])=>ctx.reconcile(...a),buildFollowUpContent:(text:string)=>`wrapped:${text}`,rememberLastCliInput:vi.fn()}));
vi.mock('../src/core/session-working-dir-runtime.js',()=>({sendSessionInput:(...a:any[])=>ctx.send(...a)}));
vi.mock('../src/core/session-activity.js',()=>({markSessionActivity:vi.fn()}));
import {registerCodexSyncApi} from '../src/core/codex-sync-api.js';

let routes:Record<string,any>;
beforeEach(()=>{
 ctx.dir=mkdtempSync(join(tmpdir(),'codex-sync-api-'));ctx.sessions=[{sessionId:'same-session',status:'active',cliId:'codex-app',larkAppId:'app',title:'test',rootMessageId:'root',chatId:'chat'}];
 ctx.live={larkAppId:'app',session:ctx.sessions[0]};ctx.send.mockReset();ctx.reply.mockReset();ctx.reconcile.mockReset();
 writeFileSync(join(ctx.dir,'rollout.jsonl'),JSON.stringify({type:'event_msg',payload:{type:'user_message',message:'same thread'}})+'\n');
 routes={};registerCodexSyncApi('app',(method,path,handler)=>{routes[method+' '+path]=handler;},(res:any,status,value)=>{res.status=status;res.value=value;},async(req:any)=>req.body);
});
afterEach(()=>{vi.useRealTimers();rmSync(ctx.dir,{recursive:true,force:true});});
async function call(route:string,body?:unknown,key='same-session'){const res:any={};await routes[route]({url:'/api/codex-sync/x/events',body},res,{key});return res;}
it('lists only this bot and rejects cross-bot keys before writes',async()=>{
 ctx.sessions.push({...ctx.sessions[0],sessionId:'other',larkAppId:'other-bot'});
 const listed=await call('GET /api/codex-sync/threads');expect(listed.value.threads.map((t:any)=>t.key)).toEqual(['same-session']);expect(JSON.stringify(listed.value)).not.toContain('rollout.jsonl');
 const wrong=await call('POST /api/codex-sync/:key/input',{text:'q',requestId:'request-a'},'other');expect(wrong.status).toBe(404);expect(ctx.send).not.toHaveBeenCalled();
});
it('submits to the original live session, mirrors the question once and persists idempotency',async()=>{
 const body={text:' 原文\n第二行 ',requestId:'request-a'};
 expect((await call('POST /api/codex-sync/:key/input',body)).value.ok).toBe(true);
 expect(ctx.send.mock.calls[0]).toEqual([ctx.live,{type:'message',content:'wrapped: 原文\n第二行 '}]);
 expect((await call('POST /api/codex-sync/:key/input',body)).value.duplicate).toBe(true);
 expect(ctx.send).toHaveBeenCalledTimes(1);expect(ctx.reply).toHaveBeenCalledTimes(1);
 expect((await call('POST /api/codex-sync/:key/input',{...body,text:'different'})).status).toBe(409);
});
it('returns a receipt for the same session and never discloses the original question in it',async()=>{
 const route='GET /api/codex-sync/:key/receipt';
 async function receipt(key:string,requestId:string){
   const res:any={};
   await routes[route]({url:`/api/codex-sync/x/receipt?requestId=${requestId}`},res,{key});
   return res;
 }
 expect((await receipt('same-session','check-receipt')).value).toEqual({status:'missing'});
 await call('POST /api/codex-sync/:key/input',{text:'private test text',requestId:'check-receipt'});
 const data=await receipt('same-session','check-receipt');
 expect(data.value.status).toBe('accepted');
 expect(JSON.stringify(data.value)).not.toContain('private test text');
 expect((await receipt('another','check-receipt')).status).toBe(404);
 expect((await receipt('same-session','!')).status).toBe(400);
});
it('cold-restores the same session and never creates or forks a new thread',async()=>{
 const ds=ctx.live;ctx.live=undefined;ctx.reconcile.mockResolvedValue({ok:true,ds});
 const r=await call('POST /api/codex-sync/:key/input',{text:'followup',requestId:'request-b'});
 expect(r.status).toBe(200);expect(ctx.reconcile.mock.calls[0][0]).toBe('same-session');expect(ctx.send.mock.calls[0][0]).toBe(ds);
});
it('never blindly replays an uncertain send, including after handler re-registration',async()=>{
 ctx.send.mockRejectedValue(new Error('unknown transport result'));
 const body={text:'followup',requestId:'request-c'};
 expect((await call('POST /api/codex-sync/:key/input',body)).status).toBe(409);
 registerCodexSyncApi('app',(method,path,handler)=>{routes[method+' '+path]=handler;},(res:any,status,value)=>{res.status=status;res.value=value;},async(req:any)=>req.body);
 expect((await call('POST /api/codex-sync/:key/input',body)).status).toBe(409);expect(ctx.send).toHaveBeenCalledTimes(1);
});
it('serializes simultaneous inputs from two windows and exposes incremental reads',async()=>{
 const order:string[]=[];ctx.send.mockImplementation(async(_ds,m)=>{order.push(m.content);await new Promise(r=>setTimeout(r,5));});
 await Promise.all(['one','two'].map(text=>call('POST /api/codex-sync/:key/input',{text,requestId:'request-'+text})));
 expect(order).toEqual(['wrapped:one','wrapped:two']);
 const r=await call('GET /api/codex-sync/:key/events');expect(r.value.events[0].text).toBe('same thread');
});
it('acknowledges execution without waiting for a slow Lark mirror',async()=>{
 let finish!:()=>void;ctx.reply.mockImplementation(()=>new Promise<void>(resolve=>{finish=resolve;}));
 const result=await call('POST /api/codex-sync/:key/input',{text:'q',requestId:'request-slow'});
 expect(result.status).toBe(200);expect(ctx.send).toHaveBeenCalledTimes(1);expect(ctx.reply).toHaveBeenCalledTimes(1);
 finish();await Promise.resolve();
});
it('retries only its own persisted mirrors when multiple bot daemons share the data directory',async()=>{
 const dir=join(ctx.dir,'codex-sync-receipts');mkdirSync(dir);
 for(const appId of ['app','other-bot'])writeFileSync(join(dir,appId+'.json'),JSON.stringify({appId,status:'accepted',mirrored:false,mirror:{rootMessageId:appId+'-root',text:'question',uuid:appId+'-uuid'}}));
 vi.useFakeTimers();
 registerCodexSyncApi('app',()=>{},()=>{},async()=>({}));
 await vi.advanceTimersByTimeAsync(5001);
 expect(ctx.reply).toHaveBeenCalledTimes(1);expect(ctx.reply.mock.calls[0][0]).toBe('app');expect(ctx.reply.mock.calls[0][1]).toBe('app-root');
});
