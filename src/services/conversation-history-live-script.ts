/** Cursor-based local reads and per-link position; never submits model input. */
export const historyLiveScript = `
const status=document.getElementById('history-live'),viewKey='botmux-history-view:'+location.pathname;
const article=()=>document.querySelector('article'),previous=document.getElementById('load-previous'),next=document.getElementById('load-next'),last=document.getElementById('last-position');
let revision=document.documentElement.dataset.historyRevision,timer,stopped=false,ready=false,busy=false,wantLatest=false,saveTimer,saved,followLatest=true;
try{saved=JSON.parse(localStorage.getItem(viewKey)||sessionStorage.getItem(viewKey)||'null')}catch{}
if(saved?.bottom||!saved?.cursor)saved=null;
last.hidden=!saved;
try{history.scrollRestoration='manual'}catch{}
const nodes=()=>[...article().children].filter(n=>n.dataset.messageCursor);
const scroller=()=>document.scrollingElement||document.documentElement;
const atBottom=()=>scroller().scrollHeight-scroller().clientHeight-scroller().scrollTop<=100;
const scrollBottom=()=>{scroller().scrollTop=scroller().scrollHeight};
const capture=()=>{
 const bottom=atBottom();
 const top=document.querySelector('header').getBoundingClientRect().bottom+10;
 const node=nodes().find(n=>n.getBoundingClientRect().bottom>top);
 return {bottom,cursor:node?.dataset.messageCursor,anchor:node?.dataset.messageId,offset:node?.getBoundingClientRect().top,y:scroller().scrollTop};
};
const remember=()=>{if(!ready)return;const position=capture();if(position.bottom||!position.cursor)return;saved=position;last.hidden=false;try{localStorage.setItem(viewKey,JSON.stringify(position))}catch{}try{sessionStorage.setItem(viewKey,JSON.stringify(position))}catch{}};
const restore=position=>{
 if(!position||position.bottom){scrollBottom();return}
 const node=nodes().find(n=>n.dataset.messageCursor===position.cursor||n.dataset.messageId===position.anchor);
 window.scrollTo(0,node?window.scrollY+node.getBoundingClientRect().top-(position.offset||0):(position.y||0));
};
const controls=()=>{
 const a=article();previous.hidden=Number(a.dataset.start)<=0;next.hidden=Number(a.dataset.end)>=Number(a.dataset.total);
 const range=document.querySelector('header>div>p:nth-of-type(2)');
 if(range)range.textContent='显示第 '+(Number(a.dataset.total)?Number(a.dataset.start)+1:0)+'–'+a.dataset.end+' 条，共 '+a.dataset.total+' 条';
};
requestAnimationFrame(scrollBottom);
if(window.ResizeObserver)new ResizeObserver(()=>{if(followLatest)requestAnimationFrame(scrollBottom)}).observe(article());
window.addEventListener('scroll',()=>{if(!ready)return;if(!atBottom())followLatest=false;else followLatest=true;clearTimeout(saveTimer);saveTimer=setTimeout(remember,150)},{passive:true});
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
 let direction=action||(!ready?'latest':'after');
 const all=nodes(),cursor=direction==='before'?all[0]?.dataset.messageCursor:direction==='around'?saved?.cursor:all.at(-1)?.dataset.messageCursor;
 if(!action&&ready&&article().dataset.hasNewer==='true'){status.textContent='按需加载 · 北京时间';timer=setTimeout(load,3000);return}
 if(direction!=='latest'&&!cursor)direction='latest';
 busy=true;previous.disabled=next.disabled=true;let delay=3000,retry;
 try{
  const query=direction==='latest'?'revision='+encodeURIComponent(revision):direction+'='+encodeURIComponent(cursor);
  const response=await fetch(location.pathname+'?complete=1&'+query,{cache:'no-store'});
  if([403,404,410].includes(response.status)){status.textContent=response.status===410?'链接已过期，请在原话题追问后重新打开。':'链接暂不可访问。';stopped=true;return}
  if(response.status===202){status.textContent='正在加载记录…';delay=1000;retry=action;return}
  if(response.status===409){if(direction==='around'){saved=null;last.hidden=true;try{localStorage.removeItem(viewKey);sessionStorage.removeItem(viewKey)}catch{}}followLatest=true;ready=false;retry='latest';delay=0;return}
  if(response.status===204){if(!ready){scrollBottom();followLatest=true;ready=true}status.textContent='自动更新 · 北京时间';return}
  if(!response.ok)throw Error();
  const doc=new DOMParser().parseFromString(await response.text(),'text/html'),incoming=doc.querySelector('article'),header=doc.querySelector('header>div');
  if(!incoming||!header)throw Error();
  if(window.getSelection()?.toString()){retry=action;return}
  const position=direction==='around'?saved:ready?capture():{bottom:true},a=article(),oldCount=nodes().length,parts=[...incoming.children];
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
  controls();followLatest=!!position?.bottom;restore(position);ready=true;status.textContent='自动更新 · 北京时间';
 }catch{status.textContent='连接暂不可用，将自动重试；已显示内容保留。';delay=15000;retry=action}
 finally{
  busy=false;previous.disabled=next.disabled=false;
  if(wantLatest){wantLatest=false;followLatest=true;ready=false;retry='latest';delay=0}
  if(!stopped){clearTimeout(timer);timer=setTimeout(()=>load(retry),delay)}
 }
};
previous.onclick=()=>{clearTimeout(timer);load('before')};next.onclick=()=>{clearTimeout(timer);load('after')};
last.onclick=()=>{if(!saved||busy)return;followLatest=false;clearTimeout(timer);load('around')};
document.getElementById('latest').onclick=()=>{followLatest=true;if(busy){wantLatest=true;return}ready=false;clearTimeout(timer);load('latest')};
load();
`;
