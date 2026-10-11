import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import { SharedBotContext, readSharedVisibleTail, sameSharedTopic } from '../src/services/shared-bot-context.js';
import type { Session } from '../src/types.js';

const roots: string[] = [];
const temp = () => { const p = mkdtempSync(join(tmpdir(),'bot-shared-')); roots.push(p); return p; };
afterEach(() => { for (const p of roots.splice(0)) rmSync(p,{recursive:true,force:true}); });
const session = (patch: Partial<Session> = {}): Session => ({sessionId:'a',chatId:'chat',rootMessageId:'topic',scope:'thread',title:'task',status:'active',createdAt:'2026-10-11',workingDir:tmpdir(),ownerUnionId:'owner',...patch});

describe('paired bot context', () => {
  it('shares only the same topic and owner; chat scope is explicit', () => {
    const a=session();
    expect(sameSharedTopic(a,session())).toBe(true);
    expect(sameSharedTopic(a,session({rootMessageId:'different'}))).toBe(false);
    expect(sameSharedTopic(a,session({chatId:'different'}))).toBe(false);
    expect(sameSharedTopic(a,session({ownerUnionId:'other-owner'}))).toBe(false);
    expect(sameSharedTopic(a,session({scope:'chat'}))).toBe(false);
    expect(sameSharedTopic(session({scope:'chat'}),session({scope:'chat',rootMessageId:'another'}))).toBe(true);
  });
  it('reads visible progress and decisions, excluding reasoning/tool output and nested snapshots', () => {
    const path=join(temp(),'rollout.jsonl');
    const row=(role:string,text:string,phase?:string) => ({type:'response_item',timestamp:'2026-10-11',payload:{type:'message',role,phase,content:[{type:role==='user'?'input_text':'output_text',text}]}});
    writeFileSync(path,[row('developer','system secret'),row('user','<botmux_shared_context>old snapshot</botmux_shared_context><user_message>new request</user_message>'),row('assistant','hidden reasoning','analysis'),row('assistant','progress confirmed','commentary'),{type:'response_item',payload:{type:'function_call_output',output:'tool credentials'}},row('assistant','final decision','final_answer')].map(x=>JSON.stringify(x)).join('\n'));
    expect(readSharedVisibleTail(path).map(x=>x.text)).toEqual(['new request','progress confirmed','final decision']);
  });
  it('requires explicit membership and keeps unrelated topics as an owner-scoped index only', () => {
    const dir=temp(), own=session({larkAppId:'cli_a'});
    const peer=session({sessionId:'b',larkAppId:'cli_b',title:'same topic'});
    const other=session({sessionId:'c',larkAppId:'cli_b',rootMessageId:'other',title:'other task'});
    const stranger=session({sessionId:'d',larkAppId:'cli_b',rootMessageId:'other',ownerUnionId:'stranger',title:'private stranger task'});
    mkdirSync(join(dir,'shared-bot-context','paired'),{recursive:true});
    writeFileSync(join(dir,'shared-bot-context','paired','members.json'),JSON.stringify(['cli_a','cli_b']));
    writeFileSync(join(dir,'sessions-cli_a.json'),JSON.stringify({a:own}));
    writeFileSync(join(dir,'sessions-cli_b.json'),JSON.stringify({b:peer,c:other,d:stranger}));
    writeFileSync(join(dir,'sessions-cli_unrelated.json'),JSON.stringify({e:session({sessionId:'e',larkAppId:'cli_unrelated',title:'unrelated secret'})}));
    const context=new SharedBotContext(dir,'a','paired','/memory');
    const text=context.snapshot();
    expect(text).toContain('same topic'); expect(text).toContain('other task');
    expect(text).not.toContain('stranger'); expect(text).not.toContain('unrelated');
    expect(context.instructions()).toContain('/memory');
    expect(new SharedBotContext(dir,'e','paired').snapshot()).toBe('');
    // Bidirectional access uses the same allowlist rather than duplicating state.
    expect(new SharedBotContext(dir,'b','paired').snapshot()).toContain('"sessionId":"a"');
  });
});
