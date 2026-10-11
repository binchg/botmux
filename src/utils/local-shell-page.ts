import { privateTerminalHtml } from './terminal-access-page.js';

export function localShellPage(expiresAt: number, nonce: string): string {
  return privateTerminalHtml(`<!doctype html><html lang="zh-CN"><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<title>本机终端</title>
<link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/@xterm/xterm@5.5.0/css/xterm.css">
<style>
*{box-sizing:border-box}html,body{margin:0;width:100%;height:100%;overflow:hidden;background:#101827;color:#dfe8f4;font:14px system-ui}
body{display:flex;flex-direction:column;height:100dvh}header{display:flex;align-items:center;gap:10px;flex-wrap:wrap;padding:10px 12px;border-bottom:1px solid #35445b;flex:none}
header strong{font-size:15px}#status{font-size:12px;color:#a9bdd6}#remaining{margin-left:auto;font-variant-numeric:tabular-nums;color:#a9bdd6}
button{background:#213149;color:#e4edfa;border:1px solid #526783;border-radius:7px;padding:7px 10px;font:inherit;touch-action:manipulation}
#terminal{flex:1;min-height:0;padding:6px 4px 0}.xterm{height:100%}footer{display:flex;gap:6px;overflow-x:auto;flex:none;padding:8px 8px max(8px,env(safe-area-inset-bottom));border-top:1px solid #35445b}footer button{flex:none;min-width:38px}
@media(max-width:500px){header{gap:7px;padding:8px}header strong{font-size:14px}#status{max-width:90px}button{padding:7px 8px}}
</style>
<header><strong>本机终端</strong><span id="status">连接中</span><span id="remaining"></span><button id="lock">锁定</button></header>
<div id="terminal"></div><footer aria-label="终端快捷键"><button id="keyboard">键盘</button><button data-key="esc">Esc</button><button data-key="ctrl-c">Ctrl-C</button><button data-key="tab">Tab</button><button data-key="up">↑</button><button data-key="down">↓</button><button data-key="left">←</button><button data-key="right">→</button><button data-key="enter">↵</button></footer>
<script src="https://cdn.jsdelivr.net/npm/@xterm/xterm@5.5.0/lib/xterm.js"></script>
<script src="https://cdn.jsdelivr.net/npm/@xterm/addon-fit@0.10.0/lib/addon-fit.js"></script>
<script>
(()=>{
history.replaceState(null,'',location.pathname);
const base=location.pathname.replace(/\\/+$/,''),status=document.getElementById('status');
const term=new Terminal({cursorBlink:true,fontSize:innerWidth<500?12:14,fontFamily:'ui-monospace,Menlo,Consolas,monospace',theme:{background:'#101827',foreground:'#e4edfa'},scrollback:5000});
const fit=new FitAddon.FitAddon();term.loadAddon(fit);term.open(document.getElementById('terminal'));fit.fit();
const ws=new WebSocket((location.protocol==='https:'?'wss://':'ws://')+location.host+location.pathname);
const send=value=>{if(ws.readyState===WebSocket.OPEN)ws.send(JSON.stringify(value))};
function resize(){if(window.visualViewport)document.body.style.height=window.visualViewport.height+'px';fit.fit();send({type:'resize',cols:term.cols,rows:term.rows})}
ws.onopen=()=>{status.textContent='已连接';resize();term.focus()};
ws.onmessage=e=>{const m=JSON.parse(e.data);if(m.type==='output')term.write(m.data)};
ws.onclose=e=>{status.textContent=e.code===1008?'已锁定':'已断开';if(e.code===1008)location.reload()};
ws.onerror=()=>status.textContent='连接失败';
term.onData(data=>send({type:'input',data}));
new ResizeObserver(()=>{fit.fit();send({type:'resize',cols:term.cols,rows:term.rows})}).observe(document.getElementById('terminal'));
window.addEventListener('resize',resize);window.visualViewport?.addEventListener('resize',resize);
const keys={esc:'\\x1b','ctrl-c':'\\x03',tab:'\\t',up:'\\x1b[A',down:'\\x1b[B',left:'\\x1b[D',right:'\\x1b[C',enter:'\\r'};
document.querySelectorAll('[data-key]').forEach(b=>{b.onpointerdown=e=>e.preventDefault();b.onclick=()=>{send({type:'input',data:keys[b.dataset.key]});term.focus()}});
document.getElementById('keyboard').onclick=()=>term.focus();
document.getElementById('lock').onclick=async()=>{const r=await fetch(base+'/.terminal-auth/lock',{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'});if(r.ok){ws.close();location.reload()}else status.textContent='锁定失败'};
const end=${expiresAt};const timer=setInterval(()=>{const left=Math.max(0,Math.ceil((end-Date.now())/1000));document.getElementById('remaining').textContent=left+' 秒';if(!left){clearInterval(timer);ws.close();location.reload()}},500);
})();
</script></html>`, nonce);
}
