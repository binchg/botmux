import { it, expect } from 'vitest';
import { mkdtempSync,writeFileSync,appendFileSync,rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ExternalCodexBridge,consumeExternalCodex,type ExternalCodexCursor } from '../src/services/external-codex-bridge.js';
const event=(payload:unknown)=>JSON.stringify({type:'event_msg',payload})+'\n';
it('mirrors exact questions, sentence increments and tool activity, with no inbound echo or final duplication',()=>{
  const s:ExternalCodexCursor={offset:0,carry:'',busy:false,outbox:[],received:[],echoInputs:['飞书原文']};
  consumeExternalCodex(s,event({type:'task_started',turn_id:'t'})+event({type:'user_message',message:'飞书原文'})+
    event({type:'user_message',message:'  IDE追问\n第二行  '})+
    event({type:'agent_message',phase:'commentary',message:'先读代码。再跑检查。'})+
    JSON.stringify({type:'response_item',payload:{type:'function_call',name:'exec_command',arguments:'password=secret'}})+'\n'+
    event({type:'agent_message',phase:'final_answer',message:'完成'})+event({type:'task_complete',turn_id:'t',last_agent_message:'完成'}));
  expect(s.outbox.map(o=>o.kind)).toEqual(['user','progress','progress','tool','final']);
  expect(s.outbox[0].text).toBe('  IDE追问\n第二行  ');
  expect(JSON.stringify(s.outbox)).not.toContain('secret');
});
it('keeps partial progress across persisted cursors without replaying earlier sentences',()=>{
  const s:ExternalCodexCursor={offset:0,carry:'',busy:false,outbox:[],received:[]};
  consumeExternalCodex(s,event({type:'agent_message',phase:'commentary',message:'完整一句。剩余'}));
  expect(s.outbox.map(o=>o.text)).toEqual(['完整一句。']);s.outbox=[];
  const restored=JSON.parse(JSON.stringify(s));
  consumeExternalCodex(restored,event({type:'agent_message',phase:'commentary',message:'部分。'}));
  expect(restored.outbox.map((o:any)=>o.text)).toEqual(['剩余部分。']);
});
it('forwards progress while a headless submitted turn is still running and serializes follow-ups',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'external-live-progress-')),path=join(dir,'rollout.jsonl');
  writeFileSync(path,JSON.stringify({type:'session_meta',payload:{id:'t'}})+'\n');
  let finish!:()=>void,calls=0;const deliveries:string[]=[];
  const bridge=new ExternalCodexBridge([{threadId:'t',rolloutPath:path,cwd:dir,chatId:'chat',larkAppId:'app',rootMessageId:'root',ownerOpenId:'owner'}],join(dir,'state.json'),{
    reply:async(_b,text)=>{deliveries.push(text);},error:()=>{},turn:async(_b,_text,checkpoint)=>{checkpoint();calls++;await new Promise<void>(r=>{finish=r;});},
  });
  try{
    await bridge.receive('root','app','owner','q1','question');const pending=bridge.tick();
    await Promise.resolve();expect(calls).toBe(1);
    appendFileSync(path,event({type:'task_started',turn_id:'active'})+event({type:'agent_message',phase:'commentary',message:'任务仍在运行。'}));
    await bridge.tick();expect(deliveries).toEqual(['任务仍在运行。']);expect(calls).toBe(1);
    finish();await pending;
  }finally{rmSync(dir,{recursive:true,force:true});}
});
