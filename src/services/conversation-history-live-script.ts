/** Local transcript refresh only: no model calls, no overlapping requests. */
export const historyLiveScript = `
const status=document.getElementById('history-live');
let revision=document.documentElement.dataset.historyRevision,timer,stopped=false;
document.getElementById('latest').onclick=()=>window.scrollTo({top:document.body.scrollHeight,behavior:'smooth'});
const load=async()=>{
  if(document.hidden){timer=setTimeout(load,3000);return}
  let delay=3000;
  try{
    const response=await fetch(location.pathname+'?complete=1&revision='+encodeURIComponent(revision),{cache:'no-store'});
    if([403,404,410].includes(response.status)){status.textContent=response.status===410?'链接已过期，请在原话题追问后重新打开。':'链接暂不可访问。';stopped=true;return}
    if(response.status===202){status.textContent='正在补齐记录…';delay=1000;return}
    if(response.status===204){status.textContent='自动更新 · 北京时间';return}
    if(!response.ok)throw Error();
    const doc=new DOMParser().parseFromString(await response.text(),'text/html');
    const article=doc.querySelector('article'),header=doc.querySelector('header>div');
    if(!article||!header)throw Error();
    if(window.getSelection()?.toString()){delay=3000;return}
    const follow=window.innerHeight+window.scrollY>=document.documentElement.scrollHeight-100;
    if(document.querySelector('article').innerHTML!==article.innerHTML)document.querySelector('article').replaceWith(article);
    document.querySelector('header>div').replaceWith(header);
    revision=doc.documentElement.dataset.historyRevision;
    document.documentElement.dataset.historyRevision=revision;
    if(follow)window.scrollTo(0,document.body.scrollHeight);
    status.textContent='自动更新 · 北京时间';
  }catch{status.textContent='连接暂不可用，将自动重试；已显示内容保留。';delay=15000}
  finally{if(!stopped)timer=setTimeout(load,delay)}
};
load();
`;
