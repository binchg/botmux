/** Read-only live console for native Codex threads; shares history token protection. */
import { randomBytes } from 'node:crypto';
import type { HistoryMessage } from './conversation-history-store.js';
import { visibleHistoryText } from './conversation-history-store.js';

export function nativeTerminalText(messages: HistoryMessage[]): string {
  return messages.slice(-60).map(message => {
    const label = message.kind === 'user' ? '$ 用户' : message.kind === 'assistant_final' ? '> Codex' : '· 进展';
    const time = new Date(message.at).toLocaleTimeString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false });
    const content = visibleHistoryText(message.content, message.kind).slice(0, 6000);
    return `${label}  ${time}\n${content}`;
  }).join('\n\n') || '等待会话输出…';
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
}

export function renderNativeTerminalPage(messages: HistoryMessage[]): { html: string; nonce: string } {
  const nonce = randomBytes(16).toString('base64url');
  const output = escapeHtml(nativeTerminalText(messages));
  const html = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Codex Web 终端 · 只读</title><style>
:root{color-scheme:dark}*{box-sizing:border-box}body{margin:0;background:#10151c;color:#d5e0eb;font:14px ui-monospace,SFMono-Regular,Menlo,monospace}header{position:sticky;top:0;z-index:1;background:#172331;border-bottom:1px solid #345;padding:12px 16px}h1{margin:0;color:#7ce0a4;font-size:17px}small{color:#9fb3c5}main{max-width:1100px;margin:auto;padding:14px 16px 50px}pre{white-space:pre-wrap;overflow-wrap:anywhere;line-height:1.5;margin:0}#live{color:#7ce0a4;margin:0 0 14px}
</style></head><body><header><h1>Codex Web 终端</h1><small>原始会话公开输出 · 只读 · 自动更新</small></header><main><p id="live">● 已连接</p><pre id="console">${output}</pre></main><script nonce="${nonce}">(()=>{const out=document.getElementById('console'),live=document.getElementById('live');async function refresh(){try{const url=new URL(location.href);url.searchParams.set('format','json');const r=await fetch(url,{cache:'no-store'});if(!r.ok)throw Error(String(r.status));const data=await r.json();if(out.textContent!==data.text){const bottom=window.innerHeight+scrollY>=document.documentElement.scrollHeight-120;out.textContent=data.text;if(bottom)scrollTo(0,document.documentElement.scrollHeight)}live.textContent='● 已连接'}catch{live.textContent='● 连接中断，正在重试'}}setInterval(refresh,3000)})()</script></body></html>`;
  return { html, nonce };
}
