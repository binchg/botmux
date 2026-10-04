import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { createRequire } from 'node:module';
import type { ServerResponse } from 'node:http';

const require = createRequire(import.meta.url);
const assets = new Map<string, string>();
/** Protected terminals use lockfile-pinned local assets, never third-party scripts. */
export function privateTerminalHtml(html: string, nonce: string): string {
  return html.replace(/<script src="https:\/\/cdn\.jsdelivr\.net\/npm\/(@xterm\/[^@]+)@[^\"]+"><\/script>/g, (_tag, pkg: string) => {
    if (!assets.has(pkg)) assets.set(pkg, readFileSync(require.resolve(pkg), 'utf8').replace(/<\/script/gi, '<\\/script'));
    return `<script nonce="${nonce}">${assets.get(pkg)}</script>`;
  }).replace(/<link rel="stylesheet" href="https:\/\/cdn\.jsdelivr\.net\/npm\/@xterm\/xterm@[^\"]+">/g, () => {
    const key = 'xterm-css';
    if (!assets.has(key)) assets.set(key, readFileSync(join(dirname(require.resolve('@xterm/xterm')), '../css/xterm.css'), 'utf8'));
    return `<style>${assets.get(key)}</style>`;
  }).replace(/<script>/g, `<script nonce="${nonce}">`);
}

export function sendTerminalLockPage(res: ServerResponse): void {
  const nonce = randomBytes(18).toString('base64url');
  res.writeHead(200, {
    'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store',
    'Referrer-Policy': 'no-referrer', 'X-Content-Type-Options': 'nosniff',
    'Content-Security-Policy': `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'`,
  });
  res.end(`<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>安全终端 · 密码确认</title><style nonce="${nonce}">
*{box-sizing:border-box}body{margin:0;min-height:100dvh;display:grid;place-items:center;background:#101827;color:#e7edf6;font:16px system-ui;padding:22px}
main{width:min(440px,100%);padding:32px;background:#1b273b;border:1px solid #35445b;border-radius:20px;box-shadow:0 24px 90px #0005}
h1{font-size:25px;margin:12px 0}p{color:#b2c0d4;line-height:1.65}label{display:block;margin:20px 0 8px}input,button{width:100%;padding:13px;border-radius:9px;font:inherit}input{border:1px solid #52627c;background:#0e1727;color:white}button{margin-top:24px;border:0;background:#87b6ff;color:#101827;cursor:pointer}button:disabled{opacity:.5}#error{color:#ffc0b7;min-height:24px}small{color:#a4b5cd}#repeat[hidden]{display:none}
</style><main role="dialog" aria-modal="true" aria-labelledby="title"><small>本机安全终端</small><h1 id="title">密码确认</h1><p id="intro">首次使用请设置二次密码。每次解锁需要一次性链接和密码，操作权限 5 分钟后自动收回。</p>
<form id="form"><label for="password">二次密码</label><input id="password" name="password" type="password" minlength="12" maxlength="256" autocomplete="current-password" required>
<div id="repeat" hidden><label for="confirm">再次输入密码</label><input id="confirm" name="confirm" type="password" minlength="12" maxlength="256" autocomplete="new-password"></div>
<p id="error" role="alert"></p><button id="submit" disabled>确认并解锁 5 分钟</button></form><p><small>密码至少 12 个字符，仅保存加盐摘要。请勿在飞书消息中发送密码。</small></p></main>
<script nonce="${nonce}">
const base=location.pathname.replace(/\\/+$/,'');
let entry=new URLSearchParams(location.hash.slice(1)).get('entry')||'';
history.replaceState(null,'',location.pathname);
window.addEventListener('hashchange',()=>{if(location.hash)location.reload()});
const form=document.getElementById('form'),error=document.getElementById('error'),button=document.getElementById('submit');let setup=false;
fetch(base+'/.terminal-auth/status',{cache:'no-store'}).then(async r=>{const s=await r.json();if(!r.ok)throw Error(s.error);if(s.expiresAt){location.reload();return}setup=s.setup;document.getElementById('title').textContent=setup?'首次设置二次密码':'输入二次密码';document.getElementById('repeat').hidden=!setup;document.getElementById('confirm').required=setup;document.getElementById('password').autocomplete=setup?'new-password':'current-password';if(!entry)throw Error('请使用新的一次性安全终端链接打开。');button.disabled=false}).catch(e=>error.textContent=e.message);
form.addEventListener('submit',async e=>{e.preventDefault();button.disabled=true;error.textContent='';try{const password=document.getElementById('password').value,confirmPassword=document.getElementById('confirm').value;const r=await fetch(base+'/.terminal-auth/'+(setup?'setup':'unlock'),{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({entry,password,confirmPassword})});const v=await r.json();form.reset();if(!r.ok)throw Error(v.error);entry='';location.reload()}catch(e){error.textContent=e.message;button.disabled=false}});
</script></html>`);
}

export function terminalAccessControls(expiresAt: number): string {
  return `<style>body{padding-top:100px}#zoom-controls,#search-controls{top:62px}#secure-terminal-controls{position:fixed;left:0;right:0;top:0;z-index:200;background:#182238;color:#eef;padding:10px 16px;border-bottom:1px solid #456;font:13px system-ui;display:flex;align-items:center;gap:10px;flex-wrap:wrap}#secure-terminal-controls button{border:1px solid #597297;border-radius:7px;background:#253b59;color:#eef;padding:8px 12px;cursor:pointer}#secure-result{color:#a8dcba}@media(max-width:650px){body{padding-top:150px}#zoom-controls,#search-controls{top:110px}}</style><div id="secure-terminal-controls">
<span id="secure-remaining"></span> <button id="secure-hooks">同意本会话 Hooks</button> <button id="secure-lock">立即锁定</button><span id="secure-result" role="status"></span></div>
<script>(()=>{const base=location.pathname.replace(/\\/+$/,'');history.replaceState(null,'',location.pathname);const end=${expiresAt};
async function action(name,data){const r=await fetch(base+'/.terminal-auth/'+name,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(data)});const v=await r.json();if(!r.ok)throw Error(v.error);return v}
document.getElementById('secure-lock').onclick=async()=>{await action('lock',{});location.reload()};
document.getElementById('secure-hooks').onclick=async()=>{if(!confirm('允许本会话运行已启用的 Hooks？此设置从下一轮生效。'))return;try{await action('hooks',{confirm:true});document.getElementById('secure-result').textContent=' 已保存，下一轮生效'}catch(e){document.getElementById('secure-result').textContent=e.message}};
setInterval(()=>{const left=Math.max(0,Math.ceil((end-Date.now())/1000));document.getElementById('secure-remaining').textContent='授权剩余 '+left+' 秒';if(!left)location.reload()},500);
})();</script>`;
}
