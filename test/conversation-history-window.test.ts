import {expect,it} from 'vitest';
import {historyCursor,historyWindow} from '../src/services/conversation-history-window.js';
const messages=Array.from({length:155},(_,i)=>({id:String(i),kind:'user' as const,content:'question '+i,at:1000+i}));
it('initial request returns only the latest 40 messages; cursors page both ways without overlap',()=>{
 const latest=historyWindow(messages);expect(latest.messages).toHaveLength(40);expect(latest.start).toBe(115);expect(latest.hasOlder).toBe(true);expect(latest.hasNewer).toBe(false);
 const older=historyWindow(messages,{before:historyCursor(latest.messages[0])});expect(older.start).toBe(75);expect(older.end).toBe(latest.start);
 const newer=historyWindow(messages,{after:historyCursor(older.messages.at(-1)!)});expect(newer.messages).toEqual(latest.messages);
});
it('restores an earlier anchor with a bounded window, and append cursors stay stable',()=>{
 const cursor=historyCursor(messages[30]),window=historyWindow(messages,{around:cursor});expect(window.messages).toHaveLength(40);expect(window.messages).toContain(messages[30]);
 const last=historyCursor(messages.at(-1)!);expect(historyWindow([...messages,{id:'new',kind:'user',content:'new',at:9999}],{after:last}).messages.map(m=>m.id)).toEqual(['new']);
 expect(historyWindow(messages,{after:last}).messages).toEqual([]);expect(()=>historyWindow(messages,{before:'unknown'})).toThrow('cursor');
});
it('code and task Markdown keep literal code, escape injected tags and render real checkboxes',async()=>{
 const {renderConversationHistory}=await import('../src/services/conversation-history-page.js');
 const h={title:'test',expiresAt:10000} as any;
 const m={id:'m',kind:'assistant_final' as const,at:1000,content:'- [x] done\n- [ ] waiting\n\n```json\n{"key":"<script>","count":3}\n```'};
 const html=renderConversationHistory(h,[m]).html;
 expect(html).toContain('type="checkbox" disabled checked');expect(html).toContain('code-key');expect(html).toContain('&lt;script&gt;');expect(html).not.toContain('<script>');expect(html).toContain('data-copy-code');
});
it('history copies do not duplicate a question, while later identical human questions remain visible',async()=>{
 const {mkdtempSync,writeFileSync,rmSync}=await import('node:fs');const {join}=await import('node:path');const {tmpdir}=await import('node:os');const {readHistoryBundle}=await import('../src/services/conversation-history-reader.js');
 const dir=mkdtempSync(join(tmpdir(),'history-copies-'));try{
  const row=(at:number)=>JSON.stringify({type:'response_item',timestamp:new Date(at).toISOString(),payload:{type:'message',role:'user',content:[{type:'input_text',text:'继续'}]}})+'\n';
  const a=join(dir,'a.jsonl'),b=join(dir,'b.jsonl');writeFileSync(a,row(1000));writeFileSync(b,row(1000)+row(2000));
  const history={source:{},messages:[]} as any;const result=await readHistoryBundle(history,dir,{sources:[{path:a,kind:'codex',signature:'a'},{path:b,kind:'codex',signature:'b'}],unavailableSources:0});expect(result.messages.map(m=>m.at)).toEqual([1000,2000]);
 }finally{rmSync(dir,{recursive:true,force:true})}
});
