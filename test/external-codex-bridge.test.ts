import { describe, it, expect, vi } from 'vitest';
import { mkdtempSync, writeFileSync, appendFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ExternalCodexBridge, NativeOwnerUnavailable, consumeExternalCodex, type ExternalCodexCursor, type FollowupCard } from '../src/services/external-codex-bridge.js';

const event = (payload: unknown) => JSON.stringify({ type: 'event_msg', payload }) + '\n';

it('posts one immediate status card for an accepted native follow-up', async () => {
  const f = fixture();
  const received: string[] = [];
  const deps = { reply: async () => {}, received: async (_: unknown, messageId: string) => { received.push(messageId); }, turn: async () => {}, error: () => {} };
  try {
    const bridge = new ExternalCodexBridge([f.binding], f.stateFile, deps);
    await bridge.receive('root', 'app', 'stranger', 'unauthorized', 'ignored');
    await bridge.receive('root', 'app', 'owner', 'message-1', '检查');
    await bridge.receive('root', 'app', 'owner', 'message-1', '检查');
    expect(received).toEqual(['message-1']);
  } finally { f.cleanup(); }
});

it('retains an unanswered follow-up while the IDE owner is offline without rapid resubmission', async () => {
  const f = fixture(); let attempts = 0;
  const bridge = new ExternalCodexBridge([f.binding], f.stateFile, {
    reply: async () => {},
    turn: async () => { attempts++; throw new Error('IDE owner offline'); },
    error: () => {},
  });
  try {
    await bridge.receive('root', 'app', 'owner', 'offline-question', 'question');
    await expect(bridge.tick()).rejects.toThrow('IDE owner offline');
    await bridge.tick();
    const state = JSON.parse(readFileSync(f.stateFile, 'utf8')).fork;
    expect(attempts).toBe(1);
    expect(state.pending.messageId).toBe('offline-question');
    expect(state.pending.status).toBe('queued');
    expect(state.retryAfter).toBeGreaterThan(Date.now());
  } finally { f.cleanup(); }
});

it('updates one follow-up card from offline through recovery and the exact turn receipt', async () => {
  const f = fixture();
  const cards: Array<Readonly<FollowupCard>> = [];
  let online = false, submissions = 0, clientId: string | undefined;
  vi.useFakeTimers({ toFake: ['Date'] });
  const deps = {
    reply: async () => {},
    status: async (_: unknown, card: Readonly<FollowupCard>) => { cards.push(card); return 'same-card'; },
    turn: async (_binding: unknown, _text: string, checkpoint: () => void, id?: string) => {
      if (!online) throw new NativeOwnerUnavailable('offline');
      submissions++;
      clientId = id;
      checkpoint();
    },
    error: () => {},
  };
  try {
    const bridge = new ExternalCodexBridge([f.binding], f.stateFile, deps);
    await bridge.receive('root', 'app', 'owner', 'question-id', '训练情况');
    await expect(bridge.tick()).rejects.toThrow('offline');
    await bridge.tick();
    expect(cards.map(card => card.phase)).toEqual(['queued', 'waiting_owner']);

    online = true;
    vi.setSystemTime(Date.now() + 16_000);
    const restored = new ExternalCodexBridge([f.binding], f.stateFile, deps);
    await restored.tick();
    await restored.tick();
    expect(cards.at(-1)?.phase).toBe('accepted');
    expect(submissions).toBe(1);
    expect(clientId).toBeTruthy();

    appendFileSync(f.rolloutPath, event({ type: 'task_started', turn_id: 'other' }) +
      event({ type: 'user_message', client_id: 'different-id', message: '训练情况' }) +
      event({ type: 'task_complete', turn_id: 'other' }));
    await restored.tick();
    expect(cards.at(-1)?.phase).toBe('accepted');
    appendFileSync(f.rolloutPath, event({ type: 'task_started', turn_id: 'actual' }) +
      event({ type: 'user_message', client_id: clientId, message: '训练情况' }));
    await restored.tick();
    expect(cards.at(-1)?.phase).toBe('running');
    appendFileSync(f.rolloutPath, event({ type: 'task_complete', turn_id: 'actual', last_agent_message: '完成' }));
    await restored.tick();
    expect(cards.at(-1)?.phase).toBe('finished');
    expect(cards.slice(1).every(card => card.cardId === 'same-card')).toBe(true);
  } finally { vi.useRealTimers(); f.cleanup(); }
});

it('marks a turn completed when the exact acknowledgement arrives after the ending event', async () => {
  const f = fixture();
  const cards: Array<Readonly<FollowupCard>> = [];
  let acknowledge: (() => void) | undefined;
  try {
    const bridge = new ExternalCodexBridge([f.binding], f.stateFile, {
      reply: async () => {},
      status: async (_, card) => { cards.push(card); return 'card'; },
      turn: async (_, __, checkpoint) => {
        checkpoint();
        await new Promise<void>(resolve => { acknowledge = () => { checkpoint(true, 'receipt-turn'); resolve(); }; });
      },
      error: () => {},
    });
    await bridge.receive('root', 'app', 'owner', 'message', '追问');
    const dispatch = bridge.tick();
    appendFileSync(f.rolloutPath, event({ type: 'task_started', turn_id: 'receipt-turn' }) +
      event({ type: 'task_complete', turn_id: 'receipt-turn', last_agent_message: '回复' }));
    await bridge.tick();
    acknowledge!();
    await dispatch;
    await bridge.tick();
    expect(cards.at(-1)).toMatchObject({ phase: 'finished', turnId: 'receipt-turn', cardId: 'card' });
  } finally { f.cleanup(); }
});

it('gives concurrent Feishu inputs stable IDs in the shared proxy while the original is already running', async () => {
  const f = fixture();
  const proxyEnqueue = vi.fn(async () => {});
  const status = vi.fn(async () => 'card');
  try {
    const bridge = new ExternalCodexBridge([f.binding], f.stateFile, {
      reply: async () => {}, canProxy: () => true, proxyEnqueue, status, turn: async () => {}, error: () => {},
    });
    appendFileSync(f.rolloutPath, event({ type: 'task_started', turn_id: 'long-running' }));
    await bridge.tick();
    expect(bridge.isBusy('root', 'app')).toBe(true);
    await bridge.receive('root', 'app', 'owner', 'message-1', 'first');
    await bridge.receive('root', 'app', 'owner', 'message-2', 'second');
    await bridge.receive('root', 'app', 'owner', 'message-1', 'first');
    const state = JSON.parse(readFileSync(f.stateFile, 'utf8')).fork;
    expect(proxyEnqueue.mock.calls).toEqual([
      [f.binding, 'first', state.pending.clientUserMessageId],
      [f.binding, 'second', state.queued[0].clientUserMessageId],
    ]);
    expect(state.pending.clientUserMessageId).not.toEqual(state.queued[0].clientUserMessageId);
    await bridge.tick();
    expect(status).toHaveBeenCalledTimes(2);
    expect(status).not.toHaveBeenCalledWith(expect.anything(), expect.objectContaining({phase:'waiting_turn'}));
  } finally { f.cleanup(); }
});

it('keeps a protected original read only and shows the block on the queued follow-up', async () => {
  const f = fixture();
  const original = readFileSync(f.rolloutPath);
  const status = vi.fn(async () => 'card');
  const turn = vi.fn(async () => {});
  try {
    const bridge = new ExternalCodexBridge([f.binding], f.stateFile, {
      reply: async () => {}, status, turn, isProtected: () => true, error: () => {},
    });
    await bridge.receive('root', 'app', 'owner', 'message', '进展');
    await bridge.tick();
    await bridge.tick();
    expect(turn).not.toHaveBeenCalled();
    expect(status).toHaveBeenCalledTimes(1);
    expect(status).toHaveBeenCalledWith(f.binding, expect.objectContaining({ phase: 'protected' }));
    expect(readFileSync(f.rolloutPath)).toEqual(original);
    expect(JSON.parse(readFileSync(f.stateFile, 'utf8')).fork.pending.status).toBe('queued');
  } finally { f.cleanup(); }
});

it('resumes long public output at the failed card after restart, using the same retry UUID', async () => {
  const f = fixture();
  const deliveries: Array<{ text: string; uuid: string }> = [];
  let fail = true;
  const deps = { reply: async (_: unknown, text: string, uuid: string) => {
    deliveries.push({ text, uuid });
    if (deliveries.length === 2 && fail) throw new Error('offline');
  }, turn: async () => { throw new Error('must not submit input'); }, error: () => {} };
  try {
    const bridge = new ExternalCodexBridge([f.binding], f.stateFile, deps);
    const text = '真实公开长回复。'.repeat(1200);
    appendFileSync(f.rolloutPath, event({ type: 'task_complete', turn_id: 'long', last_agent_message: text }));
    await expect(bridge.tick()).rejects.toThrow('offline');
    fail = false;
    const restored = new ExternalCodexBridge([f.binding], f.stateFile, deps);
    await restored.tick();
    expect(deliveries[1]).toEqual(deliveries[2]);
    expect([deliveries[0], ...deliveries.slice(2)].map(d => d.text).join('')).toBe(text);
    const count = deliveries.length;
    await restored.tick();
    expect(deliveries).toHaveLength(count);
  } finally { f.cleanup(); }
});
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
