import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SharedBotContext, readSharedVisibleTail, sameSharedTopic } from '../src/services/shared-bot-context.js';
import type { Session } from '../src/types.js';

/** 只用临时目录和合成可见消息测试共享边界，不访问本机真实 rollout 或记忆。 */
const finders = vi.hoisted(() => ({ codex: vi.fn(), traex: vi.fn() }));
vi.mock('../src/services/codex-transcript.js', () => ({ findCodexRolloutBySessionId: finders.codex }));
vi.mock('../src/services/traex-transcript.js', () => ({ findTraexRolloutBySessionId: finders.traex }));
const roots: string[] = [];
const temp = () => { const p = mkdtempSync(join(tmpdir(),'bot-shared-')); roots.push(p); return p; };
beforeEach(() => { vi.resetAllMocks(); vi.stubEnv('BOT_SHARED_MEMORY_FILE', ''); });
afterEach(() => { vi.unstubAllEnvs(); for (const p of roots.splice(0)) rmSync(p,{recursive:true,force:true}); });
const session = (patch: Partial<Session> = {}): Session => ({sessionId:'a',chatId:'chat',rootMessageId:'topic',scope:'thread',title:'task',status:'active',createdAt:'2026-10-11',workingDir:tmpdir(),ownerUnionId:'owner',...patch});
const row = (role: string, text: string, phase?: string, timestamp = '2026-10-11') => ({ type:'response_item', timestamp,
  payload:{ type:'message', role, phase, content:[{type:role==='user'?'input_text':'output_text',text}] } });

/** 构造显式成员与会话表，数组形式允许验证持久数据重复记录时的去重。 */
function writeGroup(dir: string, peers: Session[], own = session({larkAppId:'cli_a'}), members = ['cli_a','cli_b']) {
  mkdirSync(join(dir,'shared-bot-context','paired'),{recursive:true});
  writeFileSync(join(dir,'shared-bot-context','paired','members.json'),JSON.stringify(members));
  writeFileSync(join(dir,'sessions-cli_a.json'),JSON.stringify([own]));
  writeFileSync(join(dir,'sessions-cli_b.json'),JSON.stringify(peers));
}

/** 写入合成运行回执并固定更新时间，避免真实进程或文件发现影响排序测试。 */
function writeRuntime(dir: string, sessionId: string, updatedAt: string, executor?: string, phase = 'running') {
  mkdirSync(join(dir,'session-models'),{recursive:true});
  const name = createHash('sha256').update(sessionId).digest('hex') + '.runtime.json';
  writeFileSync(join(dir,'session-models',name),JSON.stringify({sessionId,protocol:4,pid:process.pid,threadId:'thread-'+sessionId,
    phase,updatedAt,selection:executor ? {executor,model:'synthetic',effort:'high'} : undefined}));
}

/** 从带明确数据边界的快照中读取 JSON，断言不依赖真实提示词或文件系统。 */
const snapshotData = (context: SharedBotContext) => JSON.parse(context.snapshot().split('\n')[2]);

describe('paired bot context', () => {
  it('shares only the same topic and owner; chat scope is explicit', () => {
    const a=session();
    expect(sameSharedTopic(a,session())).toBe(true);
    expect(sameSharedTopic(a,session({rootMessageId:'different'}))).toBe(false);
    expect(sameSharedTopic(a,session({chatId:'different'}))).toBe(false);
    expect(sameSharedTopic(a,session({ownerUnionId:'other-owner'}))).toBe(false);
    for (const ownerUnionId of [undefined, '', '   ']) {
      expect(sameSharedTopic(a,session({ownerUnionId}))).toBe(false);
      expect(sameSharedTopic(session({ownerUnionId}),a)).toBe(false);
      expect(sameSharedTopic(session({ownerUnionId}),session({ownerUnionId}))).toBe(false);
    }
    expect(sameSharedTopic(a,session({scope:'chat'}))).toBe(false);
    expect(sameSharedTopic(session({scope:'chat'}),session({scope:'chat',rootMessageId:'another'}))).toBe(true);
  });
  it('reads visible progress and decisions, excluding reasoning/tool output and nested snapshots', () => {
    const path=join(temp(),'rollout.jsonl');
    writeFileSync(path,[row('developer','system secret'),row('user','<botmux_shared_context>old snapshot</botmux_shared_context><user_message>new request</user_message>'),row('assistant','hidden reasoning','analysis'),row('assistant','progress confirmed','commentary'),{type:'response_item',payload:{type:'function_call_output',output:'tool credentials'}},row('assistant','final decision','final_answer')].map(x=>JSON.stringify(x)).join('\n'));
    expect(readSharedVisibleTail(path).map(x=>x.text)).toEqual(['new request','progress confirmed','final decision']);
  });
  it('requires explicit membership and never indexes unrelated topics or owners', () => {
    const dir=temp(), own=session({larkAppId:'cli_a'});
    const peer=session({sessionId:'b',larkAppId:'cli_b',title:'same topic'});
    const other=session({sessionId:'c',larkAppId:'cli_b',rootMessageId:'other',title:'other task'});
    const stranger=session({sessionId:'d',larkAppId:'cli_b',rootMessageId:'other',ownerUnionId:'stranger',title:'private stranger task'});
    const noOwner=session({sessionId:'missing',larkAppId:'cli_b',ownerUnionId:undefined,title:'missing owner task'});
    const elsewhere=session({sessionId:'elsewhere',larkAppId:'cli_b',workingDir:dir,title:'different checkout'});
    writeGroup(dir,[peer,other,stranger,noOwner,elsewhere],own);
    writeFileSync(join(dir,'sessions-cli_unrelated.json'),JSON.stringify({e:session({sessionId:'e',larkAppId:'cli_unrelated',title:'unrelated secret'})}));
    const context=new SharedBotContext(dir,'a','paired','/memory');
    const text=context.snapshot();
    expect(text).toContain('same topic'); expect(text).not.toContain('other task');
    expect(text).not.toContain('stranger'); expect(text).not.toContain('unrelated');
    expect(text).not.toContain('missing owner task'); expect(text).not.toContain('different checkout');
    expect(text).not.toContain('historyIndex');
    expect(context.instructions()).toContain('/memory');
    expect(context.instructions()).not.toContain('botmux history');
    expect(new SharedBotContext(dir,'e','paired').snapshot()).toBe('');
    // 双向读取复用同一 allowlist，不建立第二份对话或记忆副本。
    expect(new SharedBotContext(dir,'b','paired').snapshot()).toContain('"sessionId":"a"');
  });

  it('fails closed when the current owner or member configuration is missing', () => {
    const dir=temp();
    writeGroup(dir,[session({sessionId:'b',larkAppId:'cli_b'})],session({larkAppId:'cli_a',ownerUnionId:undefined}));
    expect(new SharedBotContext(dir,'a','paired').snapshot()).toBe('');
    writeFileSync(join(dir,'shared-bot-context','paired','members.json'),JSON.stringify(['cli_a',42]));
    expect(() => new SharedBotContext(dir,'a','paired').snapshot()).toThrow('invalid_shared_context_members');
    expect(() => new SharedBotContext(dir,'a','../other')).toThrow('invalid_shared_context_group');
  });

  it('selects the newest peers by runtime/input time and deduplicates session records', () => {
    const dir=temp(), peer=(sessionId: string, patch: Partial<Session> = {}) => session({sessionId,larkAppId:'cli_b',...patch});
    writeGroup(dir,[peer('older'),peer('newest',{lastMessageAt:'2026-11-10',title:'latest input'}),
      peer('recent'),peer('newest',{lastMessageAt:'2026-10-01',title:'stale duplicate'})],undefined,['cli_a','cli_b','cli_b']);
    writeRuntime(dir,'recent','2026-11-09','codex-app');
    writeRuntime(dir,'older','2026-11-01','codex-app');
    const data=snapshotData(new SharedBotContext(dir,'a','paired'));
    expect(data.progress.map((x: any) => x.sessionId)).toEqual(['newest','recent']);
    expect(data.progress[0].title).toBe('latest input');
    expect(data.peersTruncated).toBe(true);
  });

  it('never discovers a Codex rollout for a missing or unknown executor', () => {
    const dir=temp();
    writeGroup(dir,[session({sessionId:'b',larkAppId:'cli_b',cliSessionId:'legacy-thread'})]);
    const context=new SharedBotContext(dir,'a','paired');
    for (const executor of [undefined,'unknown']) {
      writeRuntime(dir,'b','2026-11-10',executor);
      expect(snapshotData(context).progress[0].messages).toEqual([]);
    }
    expect(finders.codex).not.toHaveBeenCalled(); expect(finders.traex).not.toHaveBeenCalled();
  });

  it('uses only the explicitly selected executor and deduplicates visible text across peers', () => {
    const dir=temp(), path=join(dir,'synthetic.jsonl');
    writeFileSync(path,JSON.stringify(row('assistant','shared safe progress','commentary')));
    writeGroup(dir,[session({sessionId:'b',larkAppId:'cli_b'}),session({sessionId:'c',larkAppId:'cli_b',title:'contact: user@example.invalid'})]);
    writeRuntime(dir,'b','2026-11-10','codex-app'); writeRuntime(dir,'c','2026-11-09','traex');
    finders.codex.mockReturnValue(path); finders.traex.mockReturnValue(path);
    const data=snapshotData(new SharedBotContext(dir,'a','paired'));
    expect(finders.codex).toHaveBeenCalledWith('thread-b'); expect(finders.traex).toHaveBeenCalledWith('thread-c');
    expect(data.progress[0].messages.map((x: any) => x.text)).toEqual(['shared safe progress']);
    expect(data.progress[1].messages).toEqual([]); expect(data.progress[1].title).toBeUndefined();
  });

  it('omits entire credential/email/identity messages before truncation', () => {
    const path=join(temp(),'synthetic.jsonl');
    const sensitive=['user@example.invalid','token=synthetic-secret','"app_secret": "synthetic-secret"',
      'OPENAI_API_KEY=synthetic-secret','AWS_SECRET_ACCESS_KEY=synthetic-secret','secret=synthetic-secret',
      'Authorization: Bearer synthetic-secret','sk-'+ 'synthetic'.repeat(4),'ghp_'+ 'synthetic'.repeat(4),
      'eyJsynthetic.eyJsynthetic.signature','-----BEGIN OPENSSH PRIVATE KEY-----\nsynthetic\n-----END OPENSSH PRIVATE KEY-----',
      'https://synthetic:password@example.invalid/path','身份证：11010119900101001X','11010119900101001X',
      '138-0013-8000','真实姓名：测试用户','姓名：测试用户','证件号：synthetic-identity','地址：合成地址',
      'ou_'+ 'a'.repeat(32),'ownerUnionId=synthetic-owner',
      'password=synthetic-secret\n'+'safe-looking tail'.repeat(200)];
    writeFileSync(path,[...sensitive.map(text=>row('assistant',text,'commentary')),row('assistant','safe progress','commentary')].map(x=>JSON.stringify(x)).join('\n'));
    expect(readSharedVisibleTail(path).map(x=>x.text)).toEqual(['safe progress']);
  });

  it('retains only the latest repeated content and marks text/history truncation', () => {
    const path=join(temp(),'synthetic.jsonl');
    writeFileSync(path,[row('user','duplicate',undefined,'2026-10-01'),row('assistant','between','commentary'),
      row('assistant','duplicate','commentary','2026-10-12')].map(x=>JSON.stringify(x)).join('\n'));
    expect(readSharedVisibleTail(path).map(x=>[x.text,x.at])).toEqual([['between','2026-10-11'],['duplicate','2026-10-12']]);
    writeFileSync(path,Array.from({length:10},(_,i)=>row('assistant',i===9?'x'.repeat(2000):'progress '+i,'commentary')).map(x=>JSON.stringify(x)).join('\n'));
    const messages=readSharedVisibleTail(path);
    expect(messages).toHaveLength(8); expect(messages[0].text).toBe('progress 2');
    expect(messages[0].truncated).toBe(true); expect(messages[7].truncated).toBe(true);
    expect(messages[7].text).toHaveLength(1800);
  });

  it('marks the bounded file window and skips a partial JSON line', () => {
    const path=join(temp(),'synthetic.jsonl');
    writeFileSync(path,[row('assistant','x'.repeat(600*1024),'analysis'),row('assistant','safe tail','commentary')].map(x=>JSON.stringify(x)).join('\n'));
    expect(readSharedVisibleTail(path)).toEqual([{role:'assistant',text:'safe tail',at:'2026-10-11',truncated:true}]);
  });

  it('bounds visible titles and rejects arbitrary timestamp/phase metadata', () => {
    const dir=temp(), path=join(dir,'synthetic.jsonl');
    writeFileSync(path,JSON.stringify(row('assistant','safe progress','commentary','token=synthetic-secret')));
    expect(readSharedVisibleTail(path)[0].at).toBeUndefined();
    writeGroup(dir,[session({sessionId:'b',larkAppId:'cli_b',title:'t'.repeat(200)})]);
    writeRuntime(dir,'b','token=synthetic-secret',undefined,'token=synthetic-secret');
    const data=snapshotData(new SharedBotContext(dir,'a','paired'));
    expect(data.progress[0].title).toHaveLength(160); expect(data.progress[0].titleTruncated).toBe(true);
    expect(data.progress[0].updatedAt).toBeUndefined();
    expect(data.progress[0].phase).toBeUndefined();
  });

  it('prefers the single approved note from the runner environment without scanning the directory', () => {
    vi.stubEnv('BOT_SHARED_MEMORY_FILE',' /approved/nonexistent-note.md ');
    const context=new SharedBotContext(temp(),'a','paired','/private/full-memory');
    expect(context.memoryFile).toBe('/approved/nonexistent-note.md');
    const instructions=context.instructions();
    expect(instructions).toContain('/approved/nonexistent-note.md');
    expect(instructions).toContain('不得扫描其父目录或其它记忆文件');
    expect(instructions).not.toContain('/private/full-memory');
    expect(instructions).not.toContain('memory_summary.md'); expect(instructions).not.toContain('MEMORY.md');
    expect(instructions).toContain('不是文件权限强隔离');
  });

  it('keeps legacy directory guidance explicit about authorization and weak isolation', () => {
    const context=new SharedBotContext(temp(),'a','paired','/legacy-memory');
    expect(context.instructions()).toContain('memory_summary.md');
    expect(context.instructions()).toContain('不是权限强隔离');
    expect(context.instructions()).toContain('不代表获准读取所有历史文件');
    expect(new SharedBotContext(temp(),'a','paired','/legacy-memory','/approved/note.md').instructions()).not.toContain('/legacy-memory');
  });
});
