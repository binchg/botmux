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
it('recovers legacy mid-record byte cursors without rewriting logs or blocking other new events',()=>{
  const s:ExternalCodexCursor={offset:0,carry:'',busy:false,outbox:[],received:[]};
  consumeExternalCodex(s,'"total_tokens":42}}\n'+event({type:'agent_message',phase:'commentary',message:'后续进展正常。'}));
  expect(s.outbox.map(o=>o.text)).toEqual(['后续进展正常。']);
});
it('retains lifecycle from history without forwarding it when the daemon attaches mid-turn',()=>{
  const s:ExternalCodexCursor={offset:0,carry:'',busy:false,outbox:[],received:[],notBefore:Date.now()};
  consumeExternalCodex(s,JSON.stringify({timestamp:'2020-01-01T00:00:00Z',type:'event_msg',payload:{type:'task_started',turn_id:'still-running'}})+'\n');
  expect(s.busy).toBe(true);expect(s.turnId).toBe('still-running');expect(s.outbox).toEqual([]);
});
it('reads canonical-only public messages and deduplicates event_msg copies',()=>{
  const s:ExternalCodexCursor={offset:0,carry:'',busy:false,outbox:[],received:[]};
  const row=(role:string,text:string,phase?:string)=>JSON.stringify({type:'response_item',payload:{type:'message',role,phase,content:[{type:role==='user'?'input_text':'output_text',text}]}})+'\n';
  consumeExternalCodex(s,event({type:'task_started',turn_id:'t'})+row('user','# AGENTS.md instructions\nsecret')+row('user','question')+
    event({type:'user_message',message:'question'})+row('assistant','检查中。','commentary')+event({type:'agent_message',phase:'commentary',message:'检查中。'}));
  expect(s.outbox.map(o=>[o.kind,o.text])).toEqual([['user','question'],['progress','检查中。']]);
});
it('rescans a canonical history rewrite without redelivering prior questions or progress',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'external-rewrite-')),path=join(dir,'rollout.jsonl'),stateFile=join(dir,'state.json');
  const meta=JSON.stringify({type:'session_meta',payload:{id:'t'}})+'\n',start=event({type:'task_started',turn_id:'turn'}),q=event({type:'user_message',message:'question'});
  writeFileSync(path,meta);
  const delivered:string[]=[];const deps={reply:async(_b:unknown,text:string)=>{delivered.push(text);},error:()=>{},turn:async()=>{}};
  const binding={threadId:'t',rolloutPath:path,cwd:dir,chatId:'chat',larkAppId:'app',rootMessageId:'root',ownerOpenId:'owner'};
  try{
    const bridge=new ExternalCodexBridge([binding],stateFile,deps);appendFileSync(path,start+q+event({type:'agent_message',phase:'commentary',message:'处理中。'}));await bridge.tick();
    expect(delivered).toEqual(['question','处理中。']);
    writeFileSync(path,meta+JSON.stringify({type:'turn_context',payload:{padding:'x'.repeat(1500)}})+'\n'+start+q+event({type:'agent_message',phase:'commentary',message:'处理中。'})+event({type:'task_complete',turn_id:'turn',last_agent_message:'done'}));
    await bridge.tick();expect(delivered).toEqual(['question','处理中。','done']);
    await new ExternalCodexBridge([binding],stateFile,deps).tick();expect(delivered).toHaveLength(3);
  }finally{rmSync(dir,{recursive:true,force:true});}
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
