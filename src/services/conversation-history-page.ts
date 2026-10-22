/** 复用 secure-local-file-share 的会话摘录样式；正文只使用禁用原始 HTML 的 Markdown。 */
import MarkdownIt from 'markdown-it';
import { randomBytes } from 'node:crypto';
import type { ConversationHistory, HistoryMessage } from './conversation-history-store.js';
import { scrubSecrets } from './insight/scrub.js';
import { renderHistoryTurns } from './conversation-history-turns.js';

const css = `
:root{color-scheme:light;--bg:#f5f7fb;--fg:#202938;--muted:#637083;--line:#dce3ed;--panel:#fff;--blue:#174ea6;--blue-bg:#eaf1ff;--green:#176648;--green-bg:#eef8f2;--link:#205fbd}
:root[data-theme=dark]{color-scheme:dark;--bg:#171c24;--fg:#e1e7ef;--muted:#a5b0bf;--line:#384254;--panel:#202733;--blue:#adcaff;--blue-bg:#253751;--green:#a3dfbf;--green-bg:#21392f;--link:#a8c9ff}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI","Noto Sans CJK SC",sans-serif}
main{max-width:1000px;margin:0 auto;padding:16px 20px 28px}header{display:flex;align-items:center;gap:12px;margin:0 0 8px}header div{flex:1;min-width:0}h1{font-size:21px;line-height:1.35;margin:0 0 4px}header p{font-size:12px;color:var(--muted);margin:0}
button{border:1px solid var(--line);border-radius:6px;background:var(--panel);color:var(--fg);padding:5px 10px;cursor:pointer}article{overflow-wrap:anywhere}article>h1{display:none}article>p{margin:5px 0}article>h2{font-size:17px;line-height:1.4;margin:16px 0 6px;border-top:1px solid var(--line);padding-top:12px}
article>h3{font-size:13px;line-height:1.5;margin:5px 0;padding:5px 10px;color:var(--blue);background:var(--blue-bg);border-left:3px solid var(--blue);border-radius:3px}article>h3+p{padding:2px 10px 5px}
blockquote{margin:8px 0 0;padding:8px 11px;font-size:13px;line-height:1.55;color:var(--fg);background:var(--green-bg);border-left:3px solid var(--green);border-radius:3px}blockquote>p:first-child{color:var(--green)}blockquote p{margin:4px 0}blockquote ul,blockquote ol{padding-left:20px;margin:4px 0}li{margin:2px 0}li>p{margin:0}
details.history-progress{margin:8px 0;padding:8px 11px;background:var(--green-bg);border-left:3px solid var(--green);border-radius:3px;font-size:13px}details.history-progress>summary{cursor:pointer;color:var(--green)}.progress-label{font-size:12px}.progress-preview{display:block;white-space:pre-wrap;overflow-wrap:anywhere;color:var(--fg);margin-top:4px}.history-progress[open] .progress-preview{display:none}.progress-expanded blockquote{border-left:0;padding-left:0}
a{color:var(--link);text-decoration:none}a:hover{text-decoration:underline}code{font-size:.92em;background:var(--panel);padding:1px 3px;border-radius:3px}pre{overflow:auto;padding:8px;background:var(--panel)}pre code{padding:0}hr{display:none}img{max-width:100%}footer{margin-top:14px;font-size:11px;color:var(--muted)}
@media(max-width:640px){main{padding:12px 12px 24px}h1{font-size:19px}body{font-size:14px}article>h2{font-size:16px}blockquote{font-size:13px}}
`;

/** 文本进入标题、属性和状态页面前进行 HTML 转义。 */
export function escapeHistoryHtml(value: string): string {
  return value.replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]!));
}

/** 历史页面展示用户输入、阶段回复和最终回复，禁止加载正文提供的远程图片或本地文件。 */
export function renderConversationHistory(history: ConversationHistory, messages: HistoryMessage[], coverage?: { sourceCount: number; unavailableSources: number }, loading = false): { html: string; nonce: string } {
  const md = new MarkdownIt({ html: false, linkify: true });
  md.renderer.rules.image = (tokens, index) => escapeHistoryHtml(`[图片：${tokens[index].content || '附件'}]`);
  md.renderer.rules.link_open = (tokens, index, options, _env, renderer) => {
    const href = tokens[index].attrGet('href') ?? '';
    if (!/^(?:https?:\/\/|mailto:|#)/i.test(href)) tokens[index].attrSet('href', '#');
    tokens[index].attrSet('target', '_blank');
    tokens[index].attrSet('rel', 'noopener noreferrer');
    return renderer.renderToken(tokens, index, options);
  };
  const formatTime = (at: number) => new Date(at).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false });
  const body = renderHistoryTurns(messages, message => message.kind === 'user'
    ? `<h3>输入 · ${formatTime(message.at)}</h3>${md.render(message.content)}`
    : `<blockquote><p>${message.kind === 'assistant_progress' ? '阶段回复' : '当轮最后回复'} · ${formatTime(message.at)}</p>${md.render(message.content)}</blockquote>`, escapeHistoryHtml);
  const coverageText = `${messages.filter(item => item.kind === 'user').length} 条输入 · ${messages.filter(item => item.kind !== 'user').length} 条回复${coverage ? ` · ${coverage.sourceCount} 段关联会话` : ''}${messages.length ? ` · 起于 ${formatTime(messages[0].at)}` : ''}`;
  const missing = loading ? '<p id="history-loading" role="status">已显示最近记录，正在补齐完整历史…</p><noscript><p>请稍后刷新以查看完整历史。</p></noscript>'
    : coverage?.unavailableSources ? `<p>有 ${coverage.unavailableSources} 段会话的原始记录暂不可读，当前展示已恢复内容。</p>` : '';
  // 单次请求完成后再重试，避免并发轮询；失败保留已展示的正文并给出明确提示。
  const progressive = loading ? `;let tries=0;const load=async()=>{const status=document.getElementById('history-loading');if(!status)return;try{const response=await fetch(location.pathname+'?complete=1',{cache:'no-store'});if(response.status===202&&++tries<60){setTimeout(load,1000);return}if(!response.ok||response.status===202)throw Error();const doc=new DOMParser().parseFromString(await response.text(),'text/html');for(const selector of ['header>div','article','footer']){const next=doc.querySelector(selector);if(!next)throw Error();document.querySelector(selector).replaceWith(next)}}catch{status.textContent='完整历史暂未加载成功，请稍后刷新；当前内容已保留。'}};load()` : '';
  const title = escapeHistoryHtml(scrubSecrets(history.title || '对话历史'));
  const nonce = randomBytes(16).toString('base64url');
  return { nonce, html: `<!doctype html><html lang="zh-CN" data-theme="light"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title><style>${css}</style></head><body><main><header><div><h1>${title}</h1><p>有效期至 ${formatTime(history.expiresAt)} · 北京时间 · 新追问后续期一天</p><p>${coverageText}</p>${missing}</div><button id="theme" type="button" aria-label="切换深浅色">深色</button></header><article>${body || '<p>当前会话暂无已记录的输入或回复。</p>'}</article><footer>对话历史 · 蓝色为输入，绿色为阶段及最终回复；按明确引用关联旧会话。</footer></main><script nonce="${nonce}">(()=>{const r=document.documentElement,b=document.getElementById('theme');try{r.dataset.theme=localStorage.getItem('secure-md-theme')==='dark'?'dark':'light'}catch{}const s=()=>b.textContent=r.dataset.theme==='dark'?'浅色':'深色';b.onclick=()=>{r.dataset.theme=r.dataset.theme==='dark'?'light':'dark';try{localStorage.setItem('secure-md-theme',r.dataset.theme)}catch{}s()};s()${progressive}})()</script></body></html>` };
}
