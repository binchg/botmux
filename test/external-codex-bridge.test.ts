import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync, appendFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ExternalCodexBridge, consumeExternalCodex, type ExternalCodexCursor } from '../src/services/external-codex-bridge.js';

const event = (payload: unknown) => JSON.stringify({ type: 'event_msg', payload }) + '\n';
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'external-codex-'));
  const rolloutPath = join(dir, 'rollout.jsonl');
  writeFileSync(rolloutPath, JSON.stringify({ type: 'session_meta', payload: { id: 'fork' } }) + '\n' + event({ type: 'task_complete', turn_id: 'old', last_agent_message: 'archive' }));
  const binding = { threadId: 'fork', rolloutPath, cwd: dir, chatId: 'chat', larkAppId: 'app', rootMessageId: 'root', ownerOpenId: 'owner' };
  return { dir, rolloutPath, binding, stateFile: join(dir, 'state.json'), cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}
describe('external Codex fork bridge', () => {
  it('does not replay history, retries a failed delivery with the same UUID, and deduplicates completion copies after restart', async () => {
    const f = fixture();
    const deliveries: Array<{ text: string; uuid: string }> = [];
    let failed = false;
    const deps = { reply: async (_: unknown, text: string, uuid: string) => {
      deliveries.push({ text, uuid });
      if (!failed) { failed = true; throw new Error('network'); }
    }, turn: async () => {}, error: () => {} };
    try {
      const bridge = new ExternalCodexBridge([f.binding], f.stateFile, deps);
      await bridge.tick();
      expect(deliveries).toEqual([]);
      const completed = event({ type: 'task_complete', turn_id: 'new', last_agent_message: '测试回复' });
      appendFileSync(f.rolloutPath, completed);
      await expect(bridge.tick()).rejects.toThrow('network');
      const restored = new ExternalCodexBridge([f.binding], f.stateFile, deps);
      await restored.tick();
      expect(deliveries).toHaveLength(2);
      expect(deliveries[0]).toEqual(deliveries[1]);
      appendFileSync(f.rolloutPath, completed);
      await restored.tick();
      expect(deliveries).toHaveLength(2);
    } finally { f.cleanup(); }
  });
  it('waits for the running UI turn, rejects other senders, and persists input deduplication', async () => {
    const f = fixture(); const turns: string[] = [];
    appendFileSync(f.rolloutPath, event({ type: 'task_started' }));
    const deps = { reply: async () => {}, turn: async (_: unknown, text: string, checkpoint: () => void) => { checkpoint(); turns.push(text); }, error: () => {} };
    try {
      const bridge = new ExternalCodexBridge([f.binding], f.stateFile, deps);
      expect(await bridge.receive('elsewhere', 'app', 'owner', 'm0', 'wrong')).toBe(false);
      await bridge.receive('root', 'app', 'stranger', 'm1', 'wrong');
      await bridge.receive('root', 'app', 'owner', 'm2', 'follow up');
      await bridge.tick(); expect(turns).toEqual([]);
      appendFileSync(f.rolloutPath, event({ type: 'task_complete', turn_id: 'ui' }));
      await bridge.tick(); expect(turns).toEqual(['follow up']);
      const restored = new ExternalCodexBridge([f.binding], f.stateFile, deps);
      await restored.receive('root', 'app', 'owner', 'm2', 'follow up');
      await restored.tick(); expect(turns).toHaveLength(1);
    } finally { f.cleanup(); }
  });
  it('does not resubmit an uncertain started input after restart', async () => {
    const f = fixture(); let calls = 0;
    const deps = { reply: async () => {}, turn: async (_: unknown, _text: string, checkpoint: () => void) => { calls++; checkpoint(); throw new Error('crash'); }, error: () => {} };
    try {
      const bridge = new ExternalCodexBridge([f.binding], f.stateFile, deps);
      await bridge.receive('root', 'app', 'owner', 'm', 'question');
      await expect(bridge.tick()).rejects.toThrow('crash');
      await new ExternalCodexBridge([f.binding], f.stateFile, deps).tick();
      expect(calls).toBe(1);
    } finally { f.cleanup(); }
  });
  it('preserves a split UTF-8 completion line and refuses mismatched metadata', async () => {
    const f = fixture(); const delivered: string[] = [];
    const deps = { reply: async (_: unknown, text: string) => { delivered.push(text); }, turn: async () => {}, error: () => {} };
    try {
      const bridge = new ExternalCodexBridge([f.binding], f.stateFile, deps);
      const data = Buffer.from(event({ type: 'task_complete', turn_id: 'unicode', last_agent_message: '中文' }));
      const cut = data.indexOf(Buffer.from('中文')) + 1;
      appendFileSync(f.rolloutPath, data.subarray(0, cut)); await bridge.tick(); expect(delivered).toEqual([]);
      appendFileSync(f.rolloutPath, data.subarray(cut)); await bridge.tick(); expect(delivered).toEqual(['中文']);
      expect(() => new ExternalCodexBridge([{ ...f.binding, threadId: 'original' }], f.stateFile, deps)).toThrow('metadata mismatch');
    } finally { f.cleanup(); }
  });
});

it('clears a timed-out submission only after its exact client receipt and matching turn completion',()=>{
 const state:ExternalCodexCursor={offset:0,carry:'',busy:false,outbox:[],received:[],pending:{messageId:'m',text:'same question',status:'started',clientUserMessageId:'receipt-id'}};
 consumeExternalCodex(state,event({type:'task_started',turn_id:'other'})+event({type:'user_message',message:'same question',client_id:'different-id'})+event({type:'task_complete',turn_id:'other',last_agent_message:'other result'}));
 expect(state.pending?.status).toBe('started');
 consumeExternalCodex(state,event({type:'task_started',turn_id:'late'})+event({type:'user_message',message:'same question',client_id:'receipt-id'}));
 expect(state.pending?.receiptTurnId).toBe('late');
 consumeExternalCodex(state,event({type:'task_complete',turn_id:'late',last_agent_message:'late result'}));expect(state.pending).toBeUndefined();
});

it('recovers an already-completed exact receipt on restart without resubmitting or replaying output',async()=>{
 const f=fixture();let calls=0;const deps={reply:async()=>{},turn:async()=>{calls++},error:()=>{}};
 try{
  appendFileSync(f.rolloutPath,event({type:'task_started',turn_id:'late'})+event({type:'user_message',message:'question',client_id:'receipt-id'})+event({type:'task_complete',turn_id:'late',last_agent_message:'done'}));
  const content=readFileSync(f.rolloutPath,'utf8');writeFileSync(f.stateFile,JSON.stringify({fork:{offset:Buffer.byteLength(content),carry:'',busy:false,outbox:[],received:['m'],pending:{messageId:'m',text:'question',status:'started',clientUserMessageId:'receipt-id'}}}));
  const bridge=new ExternalCodexBridge([f.binding],f.stateFile,deps);await bridge.tick();expect(calls).toBe(0);expect(JSON.parse(readFileSync(f.stateFile,'utf8')).fork.pending).toBeUndefined();
 }finally{f.cleanup()}
});

it('reports an uncertain owner failure once, retaining the original input without replay',async()=>{
 const f=fixture();let calls=0;const notices:string[]=[];
 const deps={reply:async(_:unknown,text:string)=>{notices.push(text)},turn:async(_:unknown,_text:string,checkpoint:()=>void)=>{calls++;checkpoint();throw Error('timeout')},error:()=>{}};
 try{const bridge=new ExternalCodexBridge([f.binding],f.stateFile,deps);await bridge.receive('root','app','owner','m','question');await expect(bridge.tick()).rejects.toThrow('timeout');await bridge.tick();await bridge.tick();expect(calls).toBe(1);expect(notices.filter(t=>t.includes('确认结果前不会重复提交'))).toHaveLength(1)}finally{f.cleanup()}
});

it('blocks a withdrawn output root once and resumes its queued public output on an explicit output-only target',async()=>{
 const f=fixture();let attempts=0;const targets:string[]=[];
 try{
  const deps={reply:async(b:any)=>{attempts++;targets.push(b.outputRootMessageId??b.rootMessageId);if(!b.outputRootMessageId){const e=new Error('withdrawn');e.name='MessageWithdrawnError';throw e}},turn:async()=>{},error:()=>{}};
  const bridge=new ExternalCodexBridge([f.binding],f.stateFile,deps);appendFileSync(f.rolloutPath,event({type:'task_complete',turn_id:'new',last_agent_message:'actual public result'}));
  await expect(bridge.tick()).rejects.toThrow('withdrawn');await bridge.tick();expect(attempts).toBe(1);
  const restored=new ExternalCodexBridge([{...f.binding,outputRootMessageId:'visible-topic'}],f.stateFile,deps);await restored.tick();expect(targets).toEqual(['root','visible-topic']);
  expect(await restored.receive('visible-topic','app','owner','m','do not route input')).toBe(false);expect(JSON.parse(readFileSync(f.stateFile,'utf8')).fork.outbox).toEqual([]);
 }finally{f.cleanup()}
});
