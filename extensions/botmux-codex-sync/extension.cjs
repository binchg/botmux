const vscode = require('vscode');
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const panels = new Map();
let rows = [], refreshing = false;
const changed = new vscode.EventEmitter();
const api = async (port, url, body) => {
  const response = await fetch(`http://127.0.0.1:${port}${url}`, {
    method: body ? 'POST' : 'GET', headers: { 'Content-Type': 'application/json' },
    ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(20000),
  });
  const result = await response.json();
  if (!response.ok) throw Error(result.error || result.status || `HTTP ${response.status}`);
  return result;
};
async function refresh() {
  if (refreshing) return;
  refreshing = true;
  try {
    const dir = path.join(vscode.workspace.getConfiguration('botmuxSync').get('dataDir'), 'dashboard-daemons');
    const descriptors = (await fs.readdir(dir)).filter(n => n.endsWith('.json'));
    const next = (await Promise.all(descriptors.map(async name => {
      try {
        const d = JSON.parse(await fs.readFile(path.join(dir, name), 'utf8'));
        if (!Number.isInteger(d.ipcPort) || d.ipcPort < 1 || d.ipcPort > 65535) return [];
        const result = await api(d.ipcPort, '/api/codex-sync/threads');
        return result.threads.map(t => ({ ...t, port: d.ipcPort, daemon: name, id: `${name}:${t.key}` }));
      } catch { return []; }
    }))).flat();
    rows = next;
    changed.fire();
    for (const row of rows) if (panels.has(row.id)) panels.get(row.id).row = row;
  } catch { /* A stopped daemon or reconnect must not discard open panels. */ }
  finally { refreshing = false; }
}
function html(webview) {
  const nonce = crypto.randomBytes(16).toString('hex');
  return `<!doctype html><html lang="zh"><head><meta charset="utf-8">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}';">
  <style nonce="${nonce}">
  body{font-family:var(--vscode-font-family);color:var(--vscode-foreground);padding:16px;max-width:1100px;margin:auto}
  #status,#stats{color:var(--vscode-descriptionForeground);white-space:pre-wrap;margin:8px 0}
  article{white-space:pre-wrap;overflow-wrap:anywhere;padding:10px 12px;margin:8px 0;border-left:3px solid var(--vscode-panel-border);background:var(--vscode-textBlockQuote-background)}
  article[data-kind=user]{border-color:var(--vscode-textLink-foreground)}article[data-kind=tool]{font-size:.9em;color:var(--vscode-descriptionForeground)}
  small{display:block;opacity:.7;margin-bottom:6px}textarea{box-sizing:border-box;width:100%;min-height:90px;background:var(--vscode-input-background);color:var(--vscode-input-foreground);border:1px solid var(--vscode-input-border);padding:10px}
  button{background:var(--vscode-button-background);color:var(--vscode-button-foreground);border:0;padding:8px 18px;margin:8px 0;cursor:pointer}
  #composer{position:sticky;bottom:0;background:var(--vscode-editor-background);padding-top:8px}
  </style></head><body><h2 id="title">Botmux 会话</h2><div id="status">连接中…</div><div id="stats"></div><main id="events"></main>
  <div id="composer"><textarea id="input" placeholder="向原会话追加问题（Ctrl / ⌘ + Enter 发送）"></textarea><button id="send">发送到原会话</button></div>
  <script nonce="${nonce}">
  const vscode=acquireVsCodeApi(), labels={user:'你的问题',progress:'执行进展',tool:'工具执行',final:'回答',status:'状态'};
  let seen=new Set(), pending=false, waiting=false;
  function send(){const input=document.getElementById('input');if(pending||!input.value.trim())return;pending=true;document.getElementById('send').disabled=true;vscode.postMessage({type:'send',text:input.value,requestId:crypto.randomUUID()});}
  document.getElementById('send').onclick=send;
  document.getElementById('input').onkeydown=e=>{if(e.key==='Enter'&&(e.ctrlKey||e.metaKey)){e.preventDefault();send();}};
  window.addEventListener('message',({data:m})=>{
    if(m.type==='events'){
      const nearBottom=window.innerHeight+window.scrollY>=document.body.scrollHeight-180;
      document.getElementById('title').textContent=m.title;
      document.getElementById('status').textContent=m.status;
      if(m.reset){seen.clear();document.getElementById('events').replaceChildren();}
      for(const e of m.events){if(seen.has(e.id))continue;seen.add(e.id);const a=document.createElement('article');a.dataset.kind=e.kind;const label=document.createElement('small');label.textContent=(labels[e.kind]||e.kind)+(e.at?' · '+new Date(e.at).toLocaleTimeString():'');a.append(label,document.createTextNode(e.text));document.getElementById('events').append(a);if(e.kind==='final'||e.kind==='user')waiting=false;}
      document.getElementById('stats').textContent=m.statistics||'';
      if(nearBottom)window.scrollTo(0,document.body.scrollHeight);
    }
    if(m.type==='sent'){pending=false;waiting=true;document.getElementById('send').disabled=false;document.getElementById('input').value='';document.getElementById('status').textContent='已提交，等待原会话执行…';}
    if(m.type==='error'){pending=false;document.getElementById('send').disabled=false;document.getElementById('status').textContent=m.text;}
  });vscode.postMessage({type:'ready'});
  </script></body></html>`;
}
function duration(ms) { const s = Math.max(0, Math.floor(ms/1000)); return `${Math.floor(s/3600)}时${Math.floor(s/60)%60}分${s%60}秒`; }
function statistics(s, createdAt) {
  if (!s) return '';
  const n = v => v === undefined ? '—' : v.toLocaleString();
  const created = Date.parse(createdAt) || s.createdAtMs;
  return `创建至今 ${created ? duration(Date.now()-created) : '—'} · 累计运行 ${duration(s.runningMs)}${s.incomplete?'（可用记录）':''}\nToken 输入 ${n(s.inputTokens)} / 输出 ${n(s.outputTokens)} · 缓存 ${n(s.cachedTokens)}（含于输入） · 工具 ${s.tools} 次`;
}
function open(row) {
  if (!row) return;
  if (panels.has(row.id)) return panels.get(row.id).panel.reveal();
  const panel = vscode.window.createWebviewPanel('botmuxSync.chat', `${row.bot} · ${row.title.slice(0,24)}`, vscode.ViewColumn.Active, { enableScripts: true, retainContextWhenHidden: true, localResourceRoots: [] });
  const state = { row, panel, cursor: 0, source: undefined, polling: false, ready: false, first: true };
  panels.set(row.id, state); panel.webview.html = html(panel.webview);
  async function poll() {
    if (!state.ready || state.polling) return;
    state.polling = true;
    try {
      let result = await api(state.row.port, `/api/codex-sync/${encodeURIComponent(row.key)}/events?cursor=${state.cursor}`);
      const switched = state.source !== undefined && result.source !== state.source;
      if (switched) result = await api(state.row.port, `/api/codex-sync/${encodeURIComponent(row.key)}/events?cursor=0`);
      state.cursor = result.cursor; state.source = result.source;
      await panel.webview.postMessage({ type:'events', title:`${state.row.bot} · ${state.row.title}`, status:`5090 · ${state.row.cwd || '/'} · 已连接 · ${result.waiting?'等待首次执行':'自动增量同步'}${result.truncated?' · 过程显示最近记录，累计统计包含全部可用记录':''}`,
        events: result.events, reset: state.first || switched || result.reset, statistics: statistics(result.statistics, result.createdAt) });
      state.first = false;
    } catch (e) { panel.webview.postMessage({ type:'error', text:`连接中断，自动重连：${e.message}` }); }
    finally { state.polling = false; }
  }
  panel.webview.onDidReceiveMessage(async m => {
    if (m.type === 'ready') { state.ready = true; return poll(); }
    if (m.type !== 'send' || typeof m.text !== 'string') return;
    try {
      await api(state.row.port, `/api/codex-sync/${encodeURIComponent(row.key)}/input`, { text:m.text, requestId:m.requestId });
      panel.webview.postMessage({type:'sent'}); await poll();
    } catch (e) { panel.webview.postMessage({type:'error', text:`提交未确认，请先核对会话再重试：${e.message}`}); }
  });
  const timer = setInterval(poll, 1000);
  panel.onDidDispose(() => { clearInterval(timer); panels.delete(row.id); });
}
exports.activate = context => {
  const provider = { onDidChangeTreeData: changed.event,
    getChildren: element => element ? rows.filter(r => r.bot === element.bot) : [...new Set(rows.map(r=>r.bot))].map(bot => ({group:true,bot})),
    getTreeItem: row => {
      if (row.group) { const item = new vscode.TreeItem(row.bot, vscode.TreeItemCollapsibleState.Expanded); item.id = `bot:${row.bot}`; return item; }
      const item = new vscode.TreeItem(row.title.replace(/\s+/g,' ').slice(0,100));
      item.id = row.id;
      item.description = `${row.kind==='native'?'Codex 原生':'Botmux'} · ${row.threadId?.slice(0,8)||row.key.slice(0,8)}`;
      item.tooltip = `${row.bot}\n${row.cwd||'/'}\n${row.title}\n点击查看实时过程并追问`;
      item.command = { command:'botmuxSync.open', title:'打开会话', arguments:[row] }; item.iconPath = new vscode.ThemeIcon('comment-discussion'); return item;
    } };
  context.subscriptions.push(changed, vscode.window.registerTreeDataProvider('botmuxSync.threads', provider),
    vscode.commands.registerCommand('botmuxSync.refresh', refresh), vscode.commands.registerCommand('botmuxSync.open', open));
  refresh(); const timer = setInterval(refresh, 3000); context.subscriptions.push({dispose:()=>{clearInterval(timer);for(const s of panels.values())s.panel.dispose();}});
};
