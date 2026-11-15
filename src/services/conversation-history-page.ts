/** 复用 secure-local-file-share 的会话摘录样式；正文只使用禁用原始 HTML 的 Markdown。 */
import MarkdownIt from 'markdown-it';
import { randomBytes, createHash } from 'node:crypto';
import { HISTORY_TTL_DAYS, type ConversationHistory, type HistoryMessage } from './conversation-history-store.js';
import { scrubSecrets } from './insight/scrub.js';
import { historyLiveScript } from './conversation-history-live-script.js';
import { historyMarkdown } from './conversation-history-markdown.js';
import { historyCursor, type historyWindow } from './conversation-history-window.js';
import { renderHistoryTurns } from './conversation-history-turns.js';

const css = `
:root{color-scheme:light;--bg:#fff;--fg:#282828;--muted:#5d5d5d;--line:#0000001a;--panel:#f9f9f9;--bubble:#f3f3f3;--link:#0285ff;--code-string:#067d17;--code-key:#0451a5;--code-number:#098658}
:root[data-theme=dark]{color-scheme:dark;--bg:#212121;--fg:#dcdcdc;--muted:#afafaf;--line:#ffffff1f;--panel:#181818;--bubble:#303030;--link:#99ceff;--code-string:#a5d6ff;--code-key:#7ee787;--code-number:#79c0ff}
*{box-sizing:border-box}html{scroll-padding-top:110px}body{margin:0;background:var(--bg);color:var(--fg);font:16px/1.75 "OpenAI Sans",-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;-webkit-font-smoothing:antialiased}
main{max-width:816px;margin:0 auto;padding:0 24px 80px}header{position:sticky;top:0;z-index:5;background:var(--bg);display:flex;align-items:center;gap:16px;padding:16px 0 12px;border-bottom:1px solid var(--line)}header>div{flex:1;min-width:0}h1{font-size:15px;font-weight:600;line-height:1.4;margin:0 0 4px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}header p{font-size:11px;line-height:1.5;color:var(--muted);margin:0}
button{border:1px solid var(--line);border-radius:999px;background:var(--bg);color:var(--fg);font:inherit;font-size:12px;line-height:1.4;padding:7px 12px;cursor:pointer}button:hover{background:var(--bubble)}button:focus-visible{outline:2px solid var(--link);outline-offset:3px}nav{display:flex;gap:6px;white-space:nowrap}#history-live{font-size:11px;color:var(--muted);margin:8px 0 22px}
article{overflow-wrap:anywhere}.message{margin:28px 0;min-width:0}.message-head{font-size:11px;line-height:1.5;color:var(--muted);margin-bottom:8px;display:flex;gap:8px;align-items:center}.message[data-kind=user]{display:flex;flex-direction:column;align-items:flex-end;margin:36px 0 28px}.message[data-kind=user] .message-body{background:var(--bubble);border-radius:22px;padding:12px 18px;max-width:90%;min-width:0}.message[data-kind=assistant_progress]{font-size:14px;color:var(--muted);margin:18px 0}.message[data-kind=assistant_progress] .message-head{margin-bottom:4px}.message-body>p:first-child{margin-top:0}.message-body>:last-child{margin-bottom:0}
p{margin:12px 0}h2{font-size:21px;line-height:1.4;font-weight:600;margin:28px 0 12px}h3{font-size:18px;line-height:1.45;font-weight:600;margin:24px 0 10px}h4{font-size:16px;margin:18px 0 8px}li{margin:4px 0}ul,ol{padding-left:24px;margin:12px 0}li>p{margin:6px 0}blockquote{margin:16px 0;padding:0 16px;border-left:3px solid var(--line);color:var(--muted)}blockquote p{margin:8px 0}a{color:var(--link);text-decoration:underline;text-underline-offset:3px}hr{border:0;border-top:1px solid var(--line);margin:24px 0}img{max-width:100%}
code{font: .9em/1.6 ui-monospace,"SFMono-Regular","SF Mono",Menlo,Consolas,"Liberation Mono",monospace;background:var(--bubble);padding:2px 5px;border-radius:5px}pre{overflow:auto;padding:16px;margin:0;font-size:13px;line-height:1.65;tab-size:4}pre code{font-size:inherit;padding:0;background:none;border-radius:0}.code-block{background:var(--panel);border:1px solid var(--line);border-radius:12px;overflow:hidden;margin:18px 0}.code-head{display:flex;justify-content:space-between;align-items:center;padding:8px 14px;font-size:12px;color:var(--muted);border-bottom:1px solid var(--line)}.code-head button{background:none;border:0;padding:3px 6px}.code-key{color:var(--code-key)}.code-string{color:var(--code-string)}.code-number{color:var(--code-number)}.clipboard-copy{position:fixed;left:-9999px;top:0}
#load-previous,#load-next{display:block;margin:16px auto}#load-previous[hidden],#load-next[hidden]{display:none}table{border-collapse:collapse;display:block;overflow-x:auto;width:max-content;max-width:100%;margin:18px 0;font-size:14px}td,th{border-bottom:1px solid var(--line);padding:10px 16px;text-align:left}th{font-weight:600;border-bottom:2px solid var(--line)}td:first-child,th:first-child{padding-left:0}.task-checkbox{accent-color:var(--fg);margin:0 7px 0 0;vertical-align:middle}math{font-size:1.08em}math[display=block]{overflow-x:auto;padding:16px 0;margin:8px 0}footer{margin-top:40px;font-size:11px;color:var(--muted);text-align:center}
@media(max-width:640px){main{padding:0 16px 56px}header{gap:8px;padding:12px 0 10px}header p{font-size:10px}h1{font-size:14px}nav{gap:4px}button{padding:7px 9px}.message[data-kind=user] .message-body{max-width:94%;padding:10px 15px}body{font-size:16px}.message{margin:24px 0}h2{font-size:20px}h3{font-size:17px}pre{padding:12px}td,th{padding:8px 12px}}

`;

/** 文本进入标题、属性和状态页面前进行 HTML 转义。 */
export function escapeHistoryHtml(value: string): string {
  return value.replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]!));
}

/** 历史页面展示用户输入、阶段回复和最终回复，禁止加载正文提供的远程图片或本地文件。 */
export function renderConversationHistory(history: ConversationHistory, messages: HistoryMessage[], coverage?: { sourceCount: number; unavailableSources: number }, loading = false, window?: ReturnType<typeof historyWindow>): { html: string; nonce: string; revision: string } {
  const md = new MarkdownIt({ html: false, linkify: true });
  historyMarkdown(md);
  md.renderer.rules.image = (tokens, index) => escapeHistoryHtml(`[图片：${tokens[index].content || '附件'}]`);
  md.renderer.rules.link_open = (tokens, index, options, _env, renderer) => {
    const href = tokens[index].attrGet('href') ?? '';
    if (!/^(?:https?:\/\/|mailto:|#)/i.test(href)) tokens[index].attrSet('href', '#');
    tokens[index].attrSet('target', '_blank');
    tokens[index].attrSet('rel', 'noopener noreferrer');
    return renderer.renderToken(tokens, index, options);
  };
  const formatTime = (at: number) => new Date(at).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false });
  const body = renderHistoryTurns(messages, message => {
    const label = message.kind === 'user' ? '原始追问' : message.kind === 'assistant_progress' ? '进展' : '最终回复';
    return `<section class="message" data-kind="${message.kind}" data-message-id="${escapeHistoryHtml(message.id)}" data-message-cursor="${historyCursor(message)}"><div class="message-head"><span>${label} · ${formatTime(message.at)}</span></div><div class="message-body">${md.render(message.content)}</div></section>`;
  }, escapeHistoryHtml, true);
  const coverageText = window ? `显示第 ${window.total ? window.start + 1 : 0}–${window.end} 条，共 ${window.total} 条` : `${messages.filter(item => item.kind === 'user').length} 条输入 · ${messages.filter(item => item.kind !== 'user').length} 条回复${coverage ? ` · ${coverage.sourceCount} 段关联会话` : ''}${messages.length ? ` · 起于 ${formatTime(messages[0].at)}` : ''}`;
  const missing = loading ? '<p id="history-loading" role="status">已显示最近记录，正在补齐完整历史…</p><noscript><p>请稍后刷新以查看完整历史。</p></noscript>'
    : coverage?.unavailableSources ? `<p>有 ${coverage.unavailableSources} 段会话的原始记录暂不可读，当前展示已恢复内容。</p>` : '';
  const revision = createHash('sha256').update(JSON.stringify([history.title, history.expiresAt, messages, coverage, loading, window?.start, window?.total])).digest('hex');
  const title = escapeHistoryHtml(scrubSecrets(history.title || '对话历史'));
  const nonce = randomBytes(16).toString('base64url');
  return { nonce, revision, html: `<!doctype html><html lang="zh-CN" data-theme="light" data-history-revision="${revision}" data-history-loading="${loading}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title><style>${css}</style></head><body><main><header><div><h1 title="${title}">${title}</h1><p>有效期至 ${formatTime(history.expiresAt)} · 新追问后续期 ${HISTORY_TTL_DAYS} 天</p><p>${coverageText}</p>${missing}</div><nav><button id="latest" type="button">到最新</button> <button id="theme" type="button" aria-label="切换深浅色">深色</button></nav></header><p id="history-live" role="status">自动更新 · 北京时间</p><button id="load-previous" type="button"${window?.hasOlder ? '' : ' hidden'}>加载更早记录</button><article data-start="${window?.start ?? 0}" data-end="${window?.end ?? messages.length}" data-total="${window?.total ?? messages.length}" data-has-older="${window?.hasOlder ?? false}" data-has-newer="${window?.hasNewer ?? false}">${body || '<p>当前会话暂无已记录的输入或回复。</p>'}</article><button id="load-next" type="button"${window?.hasNewer ? '' : ' hidden'}>加载后续记录</button><footer>原始追问 · 公开进展 · 最终回复</footer></main><script nonce="${nonce}">(()=>{const r=document.documentElement,b=document.getElementById('theme');try{r.dataset.theme=localStorage.getItem('secure-md-theme')||(matchMedia('(prefers-color-scheme:dark)').matches?'dark':'light')}catch{}const s=()=>b.textContent=r.dataset.theme==='dark'?'浅色':'深色';b.onclick=()=>{r.dataset.theme=r.dataset.theme==='dark'?'light':'dark';try{localStorage.setItem('secure-md-theme',r.dataset.theme)}catch{}s()};s();${historyLiveScript}})()</script></body></html>` };
}
