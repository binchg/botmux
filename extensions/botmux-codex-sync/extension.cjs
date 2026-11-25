const vscode = require('vscode');
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const panels = new Map();
let rows = [], refreshing = false, panelStorage;
const changed = new vscode.EventEmitter();
const api = async (port, url, body) => {
  const response = await fetch(`http://127.0.0.1:${port}${url}`, {
    method: body ? 'POST' : 'GET', headers: { 'Content-Type': 'application/json' },
    ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(body ? 45000 : 10000),
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
function html(rowId) {
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
  <div id="composer"><div id="receipt" role="status"></div><textarea id="input" placeholder="向原会话追加问题（Ctrl / ⌘ + Enter 发送）"></textarea><button id="send">发送到原会话</button></div>
  <script nonce="${nonce}">
  const vscode=acquireVsCodeApi(), labels={user:'你的问题',progress:'执行进展',tool:'工具执行',final:'回答',status:'状态'};
  const rowId=${JSON.stringify(rowId)};
  const stored=vscode.getState()||{};
  const input=document.getElementById('input'), button=document.getElementById('send');
  const receipt=document.getElementById('receipt');
  let seen=new Set(), inFlight=false, submission=stored.submission||null;
  input.value=submission?.text ?? stored.draft ?? '';
  function persist(){vscode.setState({rowId,draft:input.value,submission});}
  function controls(){
    input.readOnly=!!submission;
    button.disabled=inFlight;
    button.textContent=submission?'核对 / 重试同一提交':'发送到原会话';
  }
  function send(){
    if(inFlight||!input.value.trim())return;
    if(!submission) submission={id:crypto.randomUUID(),text:input.value};
    persist(); controls(); inFlight=true; controls();
    receipt.textContent='核对 5090 的提交回执…';
    vscode.postMessage({type:'send',text:submission.text,requestId:submission.id});
  }
  button.onclick=send;
  input.oninput=persist;
  input.onkeydown=e=>{if(e.key==='Enter'&&(e.ctrlKey||e.metaKey)){e.preventDefault();send();}};
  if(submission)receipt.textContent='上次提交结果待核对；重试会使用同一个请求编号。';
  persist();controls();
  window.addEventListener('message',({data:m})=>{
    if(m.type==='events'){
      const nearBottom=window.innerHeight+window.scrollY>=document.body.scrollHeight-180;
      document.getElementById('title').textContent=m.title;
      document.getElementById('status').textContent=m.status;
      if(m.reset){seen.clear();document.getElementById('events').replaceChildren();}
      for(const e of m.events){if(seen.has(e.id))continue;seen.add(e.id);const a=document.createElement('article');a.dataset.kind=e.kind;const label=document.createElement('small');label.textContent=(labels[e.kind]||e.kind)+(e.at?' · '+new Date(e.at).toLocaleTimeString():'');a.append(label,document.createTextNode(e.text));document.getElementById('events').append(a);}
      document.getElementById('stats').textContent=m.statistics||'';
      if(nearBottom)window.scrollTo(0,document.body.scrollHeight);
    }
    if(m.type==='sent'){inFlight=false;submission=null;input.value='';persist();controls();receipt.textContent='5090 已记录这条追问。当前执行以会话状态为准。';}
    if(m.type==='error'){inFlight=false;controls();receipt.textContent=m.text;}
    if(m.type==='connection'){document.getElementById('status').textContent=m.text;}
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
const phases = {
  idle:'空闲', queued:'追问排队中', waiting_turn:'排队中 · 上轮尚未结束', protected:'原档受保护 · 未投递',
  waiting_owner:'原生会话不可用 · 尚未投递', retrying:'暂未投递 · 将自动重试', sending:'投递中',
  uncertain:'投递待确认', accepted:'已投递 · 等待开工确认', running:'执行中', finished:'本轮已结束', aborted:'本轮已中断',
};
function open(row, restoredPanel) {
  if (!row) return;
  if (panels.has(row.id)) return panels.get(row.id).panel.reveal();
  if (panelStorage) void panelStorage.update(`panel:${row.id}`, row);
  const panel = restoredPanel || vscode.window.createWebviewPanel('botmuxSync.chat', `${row.bot} · ${row.title.slice(0,24)}`, vscode.ViewColumn.Active, { enableScripts: true, retainContextWhenHidden: true, localResourceRoots: [] });
  panel.webview.options = { enableScripts: true, localResourceRoots: [] };
  const state = { row, panel, cursor: 0, source: undefined, polling: false, ready: false, first: true };
  panels.set(row.id, state); panel.webview.html = html(row.id);
  async function poll() {
    if (!state.ready || state.polling) return;
    state.polling = true;
    try {
      let result = await api(state.row.port, `/api/codex-sync/${encodeURIComponent(row.key)}/events?cursor=${state.cursor}`);
      const identity = `${result.source}:${result.epoch}`;
      const switched = state.source !== undefined && identity !== state.source;
      if (switched) result = await api(state.row.port, `/api/codex-sync/${encodeURIComponent(row.key)}/events?cursor=0`);
      state.cursor = result.cursor; state.source = `${result.source}:${result.epoch}`;
      const sync = result.sync;
      const status = result.waiting ? '等待首次执行' : phases[sync?.phase] ?? '连接正常 · 未报告执行状态';
      const details = sync?.queued ? ` · 队列 ${sync.queued} 条` : '';
      const checked = sync?.checkedAt ? ` · 最近确认 ${new Date(sync.checkedAt).toLocaleTimeString('zh-CN', {timeZone:'Asia/Shanghai'})}` : '';
      await panel.webview.postMessage({ type:'events', title:`${state.row.bot} · ${state.row.title}`, status:`5090 · ${status}${details}${checked}${result.truncated?' · 显示最近过程':''}`,
        events: result.events, reset: state.first || switched || result.reset, statistics: statistics(result.statistics, result.createdAt) });
      state.first = false;
    } catch (e) { panel.webview.postMessage({ type:'connection', text:`连接中断，自动重连：${e.message}` }); }
    finally { state.polling = false; }
  }
  panel.webview.onDidReceiveMessage(async m => {
    if (m.type === 'ready') { state.ready = true; return poll(); }
    if (m.type !== 'send' || typeof m.text !== 'string' || typeof m.requestId !== 'string') return;
    try {
      const route = `/api/codex-sync/${encodeURIComponent(row.key)}`;
      const existing = await api(state.row.port, `${route}/receipt?requestId=${encodeURIComponent(m.requestId)}`);
      if (existing.status === 'uncertain') throw Error('5090 正在核对原请求，尚未确认结果');
      await api(state.row.port, `${route}/input`, { text:m.text, requestId:m.requestId });
      panel.webview.postMessage({type:'sent'}); await poll();
    } catch (e) { panel.webview.postMessage({type:'error', text:`提交未确认，可核对同一请求：${e.message}`}); }
  });
  const timer = setInterval(poll, 1000);
  panel.onDidDispose(() => { clearInterval(timer); panels.delete(row.id); });
}
exports.activate = context => {
  panelStorage = context.workspaceState;
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
    vscode.window.registerWebviewPanelSerializer('botmuxSync.chat', {
      async deserializeWebviewPanel(panel, saved) {
        await refresh();
        const row = rows.find(item => item.id === saved?.rowId) ?? panelStorage.get(`panel:${saved?.rowId}`);
        if (row) open(row, panel);
        else panel.webview.html = '<p>5090 会话暂不可用。连接恢复后可从「Botmux 会话」重新打开。</p>';
      },
    }),
    vscode.commands.registerCommand('botmuxSync.refresh', refresh), vscode.commands.registerCommand('botmuxSync.open', async row => {
      if (!row) {
        await refresh();
        const selected = await vscode.window.showQuickPick(rows.map(row => ({ label:row.title, description:row.bot, detail:row.cwd, row })), { placeHolder:'选择原会话查看过程或继续追问' });
        row = selected?.row;
      }
      open(row);
    }));
  refresh(); const timer = setInterval(refresh, 3000); context.subscriptions.push({dispose:()=>{clearInterval(timer);for(const s of panels.values())s.panel.dispose();}});
};
