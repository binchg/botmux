/** Cursor-based local reads and per-link position; never submits model input. */
export const historyLiveScript = `
const status=document.getElementById('history-live'),viewKey='botmux-history-view:'+location.pathname;
const article=()=>document.querySelector('article'),previous=document.getElementById('load-previous'),next=document.getElementById('load-next');
let revision=document.documentElement.dataset.historyRevision,timer,stopped=false,ready=false,busy=false,wantLatest=false,saveTimer,initial;
try{initial=JSON.parse(localStorage.getItem(viewKey)||'null')}catch{}
try{history.scrollRestoration='manual'}catch{}
const nodes=()=>[...article().children].filter(n=>n.dataset.messageCursor);
const capture=()=>{
 const bottom=window.innerHeight+window.scrollY>=document.documentElement.scrollHeight-100;
 const top=document.querySelector('header').getBoundingClientRect().bottom+10;
 const node=nodes().find(n=>n.getBoundingClientRect().bottom>top);
 return {bottom,cursor:node?.dataset.messageCursor,anchor:node?.dataset.messageId,offset:node?.getBoundingClientRect().top,y:window.scrollY};
};
const remember=()=>{if(!ready)return;try{localStorage.setItem(viewKey,JSON.stringify(capture()))}catch{}};
const restore=position=>{
 if(!position||position.bottom){window.scrollTo(0,document.body.scrollHeight);return}
 const node=nodes().find(n=>n.dataset.messageCursor===position.cursor||n.dataset.messageId===position.anchor);
 window.scrollTo(0,node?window.scrollY+node.getBoundingClientRect().top-(position.offset||0):(position.y||0));
};
const controls=()=>{
 const a=article();previous.hidden=Number(a.dataset.start)<=0;next.hidden=Number(a.dataset.end)>=Number(a.dataset.total);
 const range=document.querySelector('header>div>p:nth-of-type(2)');
 if(range)range.textContent='显示第 '+(Number(a.dataset.total)?Number(a.dataset.start)+1:0)+'–'+a.dataset.end+' 条，共 '+a.dataset.total+' 条';
};
requestAnimationFrame(()=>restore(initial));
window.addEventListener('scroll',()=>{clearTimeout(saveTimer);saveTimer=setTimeout(remember,150)},{passive:true});
window.addEventListener('pagehide',remember);document.addEventListener('visibilitychange',()=>{if(document.hidden)remember()});
document.addEventListener('click',async event=>{
 const button=event.target.closest?.('[data-copy-code]');if(!button)return;
 const text=button.closest('.code-block').querySelector('code').textContent;
 try{
  if(navigator.clipboard&&window.isSecureContext)await navigator.clipboard.writeText(text);
  else{const input=document.createElement('textarea');input.className='clipboard-copy';input.value=text;input.readOnly=true;document.body.append(input);input.select();const ok=document.execCommand('copy');input.remove();if(!ok)throw Error()}
  button.textContent='已复制';setTimeout(()=>button.textContent='复制代码',1500);
 }catch{button.textContent='请选中代码复制'}
});
const load=async action=>{
 if(busy||stopped)return;
 if(document.hidden){timer=setTimeout(()=>load(action),3000);return}
 let direction=action||(!ready?(initial?.cursor&&!initial.bottom?'around':'latest'):'after');
 const all=nodes(),cursor=direction==='before'?all[0]?.dataset.messageCursor:direction==='around'?initial?.cursor:all.at(-1)?.dataset.messageCursor;
 if(!action&&ready&&article().dataset.hasNewer==='true'){status.textContent='按需加载 · 北京时间';timer=setTimeout(load,3000);return}
 if(direction!=='latest'&&!cursor)direction='latest';
 busy=true;previous.disabled=next.disabled=true;let delay=3000,retry;
 try{
  const query=direction==='latest'?'revision='+encodeURIComponent(revision):direction+'='+encodeURIComponent(cursor);
  const response=await fetch(location.pathname+'?complete=1&'+query,{cache:'no-store'});
  if([403,404,410].includes(response.status)){status.textContent=response.status===410?'链接已过期，请在原话题追问后重新打开。':'链接暂不可访问。';stopped=true;return}
  if(response.status===202){status.textContent='正在加载记录…';delay=1000;retry=action;return}
  if(response.status===409){initial={bottom:true};ready=false;retry='latest';delay=0;return}
  if(response.status===204){if(!ready){restore(initial);ready=true;remember()}status.textContent='自动更新 · 北京时间';return}
  if(!response.ok)throw Error();
  const doc=new DOMParser().parseFromString(await response.text(),'text/html'),incoming=doc.querySelector('article'),header=doc.querySelector('header>div');
  if(!incoming||!header)throw Error();
  if(window.getSelection()?.toString()){retry=action;return}
  const position=ready?capture():initial,a=article(),oldCount=nodes().length,parts=[...incoming.children];
  if(direction==='before'&&position)position.bottom=false;
  if(!action&&ready&&direction==='after'&&!position.bottom&&oldCount+parts.length>80){a.dataset.hasNewer='true';a.dataset.total=incoming.dataset.total;next.hidden=false;status.textContent='有新记录，点击加载后续';return}
  if(direction==='before'){
   a.prepend(...parts);a.dataset.start=incoming.dataset.start;a.dataset.end=String(Number(incoming.dataset.end)+oldCount);
  }else if(direction==='after'&&ready){
   if(!oldCount)a.replaceChildren();a.append(...parts);a.dataset.start=String(Number(incoming.dataset.start)-oldCount);a.dataset.end=incoming.dataset.end;
  }else{a.replaceChildren(...parts);a.dataset.start=incoming.dataset.start;a.dataset.end=incoming.dataset.end}
  a.dataset.total=incoming.dataset.total;
  while(nodes().length>80){if(direction==='before'){a.lastElementChild.remove();a.dataset.end=String(Number(a.dataset.end)-1)}else{a.firstElementChild.remove();a.dataset.start=String(Number(a.dataset.start)+1)}}
  a.dataset.hasOlder=String(Number(a.dataset.start)>0);a.dataset.hasNewer=String(Number(a.dataset.end)<Number(a.dataset.total));
  document.querySelector('header>div').replaceWith(header);revision=doc.documentElement.dataset.historyRevision;
  document.documentElement.dataset.historyRevision=revision;document.documentElement.dataset.historyLoading='false';
  controls();restore(position);ready=true;remember();status.textContent='自动更新 · 北京时间';
 }catch{status.textContent='连接暂不可用，将自动重试；已显示内容保留。';delay=15000;retry=action}
 finally{
  busy=false;previous.disabled=next.disabled=false;
  if(wantLatest){wantLatest=false;initial={bottom:true};ready=false;retry='latest';delay=0}
  if(!stopped){clearTimeout(timer);timer=setTimeout(()=>load(retry),delay)}
 }
};
previous.onclick=()=>{clearTimeout(timer);load('before')};next.onclick=()=>{clearTimeout(timer);load('after')};
document.getElementById('latest').onclick=()=>{initial={bottom:true};if(busy){wantLatest=true;return}ready=false;clearTimeout(timer);load('latest')};
load();
`;
