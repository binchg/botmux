import type { IncomingMessage, ServerResponse } from 'node:http';
import type { SessionModelDisplay } from '../services/session-model-display.js';

const escapeHtml = (text: string) => text.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));

export function terminalModelHeader(display: SessionModelDisplay | null): string {
  return `<div id="model-display" role="status" aria-live="polite"${display ? '' : ' hidden'}>${escapeHtml(display?.label ?? '')}</div>`;
}

/** 与终端本身使用相同鉴权；只返回展示字段，不返回 PID、路径或凭据。 */
export function serveTerminalModelDisplay(req: IncomingMessage, res: ServerResponse, pathname: string,
  authorized: boolean, readDisplay: () => SessionModelDisplay | null): boolean {
  if (pathname !== '/api/model-display') return false;
  const code = !authorized ? 401 : req.method !== 'GET' ? 405 : 200;
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
  res.end(JSON.stringify(code === 200 ? { ok: true, display: readDisplay() } : { ok: false, error: code === 401 ? 'terminal_locked' : 'method_not_allowed' }));
  return true;
}

export const terminalModelStyle = `
#model-display{flex:none;padding:8px 12px;color:#7dcfff;background:#15161e;border-bottom:1px solid #33467c;
  font:13px/1.5 monospace;overflow-wrap:anywhere;padding-top:calc(8px + env(safe-area-inset-top,0px))}
#model-display[hidden]{display:none}
body.has-model-display #zoom-controls,body.has-model-display #search-controls{top:calc(var(--model-display-height,60px) + 8px)}
body.has-model-display #readonly-banner,body.has-model-display #login-banner{top:calc(var(--model-display-height,60px) + 56px)}
body.has-model-display #session-events{top:calc(var(--model-display-height,60px) + 96px)}
@media(max-width:640px){body.has-model-display #readonly-banner,body.has-model-display #login-banner{top:calc(var(--model-display-height,60px) + 76px)}
body.has-model-display #search-controls{top:calc(var(--model-display-height,60px) + 112px)}
body.has-model-display #session-events{top:calc(var(--model-display-height,60px) + 160px)}}
`;

/** 初次打开、重连和可见时刷新；同源请求复用 cookie/token，失败不保留假实时状态。 */
export const terminalModelScript = `
var modelDisplayBusy=false,modelDisplayDefaultTitle=document.title;
function updateModelDisplay(display){
  var node=document.getElementById('model-display');
  node.hidden=!display;node.textContent=display?display.label:'';
  document.body.classList.toggle('has-model-display',!!display);
  document.title=display?display.label:modelDisplayDefaultTitle;
  document.body.style.setProperty('--model-display-height',node.offsetHeight+'px');
  if(typeof fit!=='undefined'&&typeof fixedSize!=='undefined'&&!fixedSize){try{fit.fit();if(typeof sendResize==='function')sendResize()}catch(e){}}
}
async function refreshModelDisplay(){
  if(modelDisplayBusy||document.hidden)return;
  modelDisplayBusy=true;var controller=new AbortController(),timer=setTimeout(function(){controller.abort()},4000);
  try{
    var base=location.pathname.replace(/\\/+$/,'');
    var response=await fetch(base+'/api/model-display'+location.search,{credentials:'same-origin',cache:'no-store',signal:controller.signal});
    if(response.status===401||response.status===403){updateModelDisplay(null);return;}
    if(!response.ok)throw new Error('model_unavailable');
    var payload=await response.json();if(!payload.ok)throw new Error('model_unavailable');
    updateModelDisplay(payload.display);
  }catch(e){var node=document.getElementById('model-display');if(!node.hidden)updateModelDisplay({label:'模型状态暂不可用'});}
  finally{clearTimeout(timer);modelDisplayBusy=false;}
}
document.body.classList.toggle('has-model-display',!document.getElementById('model-display').hidden);
document.body.style.setProperty('--model-display-height',document.getElementById('model-display').offsetHeight+'px');
window.addEventListener('resize',refreshModelDisplay);
refreshModelDisplay();setInterval(refreshModelDisplay,2000);
document.addEventListener('visibilitychange',refreshModelDisplay);
`;
