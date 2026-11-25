const { randomBytes } = require('node:crypto');

module.exports = function sidebarHtml() {
  const nonce = randomBytes(16).toString('hex');
  return `<!doctype html>
<html lang="zh">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}';">
<style nonce="${nonce}">
*{box-sizing:border-box}
[hidden]{display:none!important}
body{margin:0;height:100vh;display:flex;flex-direction:column;font:var(--vscode-font-weight) var(--vscode-font-size)/1.5 var(--vscode-font-family);color:var(--vscode-foreground);background:var(--vscode-sideBar-background)}
button{font:inherit;color:var(--vscode-button-secondaryForeground);background:var(--vscode-button-secondaryBackground);border:1px solid transparent;border-radius:3px;padding:4px 8px;cursor:pointer}
button:hover{background:var(--vscode-button-secondaryHoverBackground)}
button:disabled{cursor:default;opacity:.7}
button:focus-visible,input:focus-visible,textarea:focus-visible{outline:1px solid var(--vscode-focusBorder);outline-offset:-1px}
header,.composer{padding:10px 12px;border-bottom:1px solid var(--vscode-panel-border)}
.bar{display:flex;align-items:center;justify-content:space-between;gap:5px}
.brand{font-weight:600;color:var(--vscode-textLink-foreground)}
.muted,small,summary,#receipt{color:var(--vscode-descriptionForeground)}
h1{font-size:1em;line-height:1.35;margin:8px 0 3px;overflow-wrap:anywhere}
#status{margin:0;overflow-wrap:anywhere}
#events,#history{min-height:0;overflow:auto;flex:1;padding:4px 12px}
#history input,textarea{width:100%;font:inherit;color:var(--vscode-input-foreground);background:var(--vscode-input-background);border:1px solid var(--vscode-input-border);padding:7px;border-radius:3px}
#history input{position:sticky;top:0;margin:6px 0}
.session{display:block;text-align:left;width:100%;padding:6px;margin:5px 0;overflow-wrap:anywhere}
.session small{display:block}
.session[aria-current=true]{border-color:var(--vscode-focusBorder)}
article{white-space:pre-wrap;overflow-wrap:anywhere;padding:7px 8px;margin:7px 0;border-left:2px solid var(--vscode-panel-border)}
article small{display:block;margin-bottom:4px}
article[data-kind=user]{border-color:var(--vscode-textLink-foreground);background:var(--vscode-textBlockQuote-background)}
article[data-kind=tool],article[data-kind=status]{color:var(--vscode-descriptionForeground);font-size:.92em}
.composer{border-top:1px solid var(--vscode-panel-border);border-bottom:0;padding-top:7px}
textarea{display:block;resize:vertical;min-height:64px;max-height:20vh}
#send{background:var(--vscode-button-background);color:var(--vscode-button-foreground);margin-top:6px}
#send:hover{background:var(--vscode-button-hoverBackground)}
#receipt{margin-bottom:4px;overflow-wrap:anywhere}
#stats{white-space:pre-wrap}
</style>
</head>
<body>
<header>
  <div class="bar"><span class="brand">Botmux · 5090</span><div><button id="history-button">会话列表</button> <button id="latest">最新消息</button></div></div>
  <h1 id="title">打开会话</h1>
  <div id="status" class="muted" role="status">连接 5090…</div>
</header>
<section id="history" hidden><input id="filter" type="search" placeholder="按标题或会话 ID 查找" aria-label="筛选会话"><div id="sessions"></div></section>
<main id="events" aria-label="会话消息"></main>
<section id="composer" class="composer" hidden>
  <div id="receipt" role="status"></div>
  <textarea id="input" placeholder="给原会话发消息" aria-label="追问"></textarea>
  <div class="bar"><small>Enter 发送 · Shift+Enter 换行</small><button id="send">发送</button></div>
  <details><summary>执行统计</summary><small id="stats"></small></details>
</section>
<script nonce="${nonce}">
const vscode = acquireVsCodeApi();
const get = id => document.getElementById(id);
const labels = {user:'你的问题',progress:'执行进展',tool:'工具执行',final:'回答',status:'状态'};
const drafts = new Map(Object.entries(vscode.getState()?.drafts ?? {}));
const active = new Set();
let rowId, sessions = [], seen = new Set(), history = false;
const input = get('input');
const currentDraft = () => drafts.get(rowId) ?? {draft:''};
function persist() { vscode.setState({drafts:Object.fromEntries(drafts)}); }
function controls() {
  const {submission} = currentDraft();
  input.readOnly = !!submission;
  get('send').disabled = !rowId || active.has(rowId) || !input.value.trim();
  get('send').textContent = submission ? '核对 / 重试' : '发送';
}
function bottom() { const events = get('events'); events.scrollTop = events.scrollHeight; }
function renderSessions() {
  const filter = get('filter').value.trim().toLowerCase();
  const list = get('sessions');
  list.replaceChildren();
  for (const item of sessions) {
    if (filter && ![item.title,item.bot,item.threadId].some(value => value?.toLowerCase().includes(filter))) continue;
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'session';
    button.setAttribute('aria-current', String(item.id === rowId));
    button.textContent = item.title;
    const detail = document.createElement('small');
    detail.textContent = item.bot + ' · ' + (item.threadId?.slice(0,8) ?? '会话');
    button.append(detail);
    button.onclick = () => vscode.postMessage({type:'select',rowId:item.id});
    list.append(button);
  }
  if (!list.childElementCount) list.textContent = filter ? '没有匹配会话。' : '暂未找到会话，连接后会自动刷新。';
}
function showHistory(show) {
  history = show;
  get('history').hidden = !show;
  get('events').hidden = show;
  get('composer').hidden = show || !rowId;
  get('history-button').textContent = show && rowId ? '返回会话' : '会话列表';
  if (show) { renderSessions(); get('filter').focus(); }
}
function select(m) {
  if (rowId !== m.rowId) {
    rowId = m.rowId;
    seen = new Set();
    get('events').replaceChildren();
    get('stats').textContent = '';
    if (m.draft && !drafts.has(rowId)) { drafts.set(rowId, m.draft); persist(); }
    input.value = currentDraft().submission?.text ?? currentDraft().draft;
    get('receipt').textContent = currentDraft().submission ? '上次提交待核对。' : '';
  }
  get('title').textContent = m.title;
  get('status').textContent = '连接 5090…';
  showHistory(!rowId);
  controls();
}
function send() {
  if (!rowId || active.has(rowId) || !input.value.trim()) return;
  const submission = currentDraft().submission ?? {id:crypto.randomUUID(),text:input.value};
  drafts.set(rowId, {draft:submission.text,submission});
  persist();
  active.add(rowId);
  controls();
  get('receipt').textContent = '正在核对提交回执…';
  vscode.postMessage({type:'send',rowId,text:submission.text,requestId:submission.id});
}
get('history-button').onclick = () => showHistory(!history || !rowId);
get('filter').oninput = renderSessions;
get('latest').onclick = () => { if (rowId) { showHistory(false); bottom(); } };
get('send').onclick = send;
input.oninput = () => { drafts.set(rowId, {draft:input.value}); persist(); controls(); };
input.onkeydown = e => {
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing && e.keyCode !== 229) { e.preventDefault(); send(); }
};
window.addEventListener('message', ({data:m}) => {
  if (m.type === 'sessions') { sessions = m.items; if (history) renderSessions(); return; }
  if (m.type === 'show-history') { showHistory(true); return; }
  if (m.type === 'session') { select(m); return; }
  if (m.type === 'sent' || m.type === 'error') {
    active.delete(m.rowId);
    if (m.type === 'sent' && drafts.get(m.rowId)?.submission?.id === m.requestId) { drafts.delete(m.rowId); persist(); }
    if (m.rowId === rowId) {
      if (m.type === 'sent') input.value = currentDraft().draft;
      get('receipt').textContent = m.type === 'sent' ? '5090 已记录这条追问。' : m.text;
      controls();
    }
    return;
  }
  if (m.rowId !== rowId) return;
  if (m.type === 'connection') { get('status').textContent = m.text; return; }
  if (m.type !== 'events') return;
  const list = get('events');
  const nearBottom = list.scrollTop + list.clientHeight >= list.scrollHeight - 100;
  get('status').textContent = m.status;
  get('stats').textContent = m.statistics || '';
  if (m.reset) { seen.clear(); list.replaceChildren(); }
  const fragment = document.createDocumentFragment();
  for (const event of m.events) {
    if (seen.has(event.id)) continue;
    seen.add(event.id);
    const item = document.createElement('article');
    item.dataset.kind = event.kind;
    const caption = document.createElement('small');
    caption.textContent = labels[event.kind] ?? event.kind;
    item.append(caption, document.createTextNode(event.text));
    fragment.append(item);
  }
  list.append(fragment);
  if (nearBottom || m.reset) bottom();
});
showHistory(true);
vscode.postMessage({type:'ready'});
</script>
</body></html>`;
};
