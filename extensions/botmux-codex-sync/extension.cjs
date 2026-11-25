const vscode = require('vscode');
const fs = require('node:fs/promises');
const { request } = require('node:http');
const path = require('node:path');
const sidebarHtml = require('./sidebar.cjs');

const VIEW = 'botmuxSync.sidebar';
const changed = new vscode.EventEmitter();
let rows = [], proxies = [], refreshing, selected, sidebar, storage;

function parseResponse(status, value) {
  if (status !== 200) throw Error(value.error || value.status || `HTTP ${status}`);
  return value;
}

function proxySocket() {
  return process.platform === 'linux' && process.getuid
    ? path.join('/run/user', String(process.getuid()), 'botmux-codex-thread-proxy.sock')
    : undefined;
}

function callProxy(route, body) {
  const socketPath = proxySocket();
  if (!socketPath) return Promise.reject(Error('5090 进程代理不可用'));
  return new Promise((resolve, reject) => {
    const req = request({socketPath, path:route, method:body ? 'POST' : 'GET',
      headers:{'Content-Type':'application/json'}, timeout:10000}, res => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('error', reject);
      res.on('end', () => {
        try { resolve(parseResponse(res.statusCode, JSON.parse(Buffer.concat(chunks).toString('utf8')))); }
        catch (error) { reject(error); }
      });
    });
    req.once('error', reject);
    req.once('timeout', () => req.destroy(Error('5090 进程代理响应超时')));
    req.end(body ? JSON.stringify(body) : undefined);
  });
}

async function callBotmux(port, route, body) {
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw Error('Botmux 本地地址不可用');
  const response = await fetch(`http://127.0.0.1:${port}${route}`, {
    method:body ? 'POST' : 'GET', headers:{'Content-Type':'application/json'},
    body:body ? JSON.stringify(body) : undefined, signal:AbortSignal.timeout(body ? 45000 : 10000),
  });
  return parseResponse(response.status, await response.json());
}

function call(row, suffix, body) {
  const route = `/api/codex-sync/${encodeURIComponent(row.key)}${suffix}`;
  return row.proxy ? callProxy(route, body) : callBotmux(row.port, route, body);
}

async function discoverBotmux() {
  const data = vscode.workspace.getConfiguration('botmuxSync').get('dataDir');
  const directory = path.join(data, 'dashboard-daemons');
  const descriptors = (await fs.readdir(directory)).filter(name => name.endsWith('.json'));
  const sources = await Promise.all(descriptors.map(async name => {
    try {
      const desc = JSON.parse(await fs.readFile(path.join(directory, name), 'utf8'));
      const result = await callBotmux(desc.ipcPort, '/api/codex-sync/threads');
      return result.threads.map(thread => ({...thread, port:desc.ipcPort, id:`${name}:${thread.key}`}));
    } catch { return []; }
  }));
  return sources.flat();
}

function sameRow(query, candidate) {
  if (!query || !candidate) return false;
  return query.id === candidate.id || (query.kind === 'native' && candidate.kind === 'native' &&
    typeof query.threadId === 'string' && query.threadId === candidate.threadId);
}

function postSessions() {
  if (!sidebar?.ready) return;
  void sidebar.view.webview.postMessage({type:'sessions', items:rows.map(({id,title,bot,threadId})=>({id,title,bot,threadId}))});
}

function refresh() {
  if (refreshing) return refreshing;
  refreshing = (async () => {
    const [proxy, botmux] = await Promise.allSettled([callProxy('/api/codex-sync/threads'), discoverBotmux()]);
    if (proxy.status === 'fulfilled') {
      proxies = proxy.value.threads.map(thread => ({...thread,id:`native:${thread.threadId}`,proxy:true}));
      void storage.update('processProxyThreads', proxies);
    }
    const others = botmux.status === 'fulfilled' ? botmux.value : rows.filter(row => !row.proxy);
    rows = [...proxies, ...others.filter(row => !proxies.some(candidate => sameRow(row, candidate)))];
    const matching = rows.find(row => sameRow(selected, row));
    if (matching) {
      if (matching.id !== selected.id) selectRow(matching);
      else selected = matching;
    }
    changed.fire();
    postSessions();
  })().finally(() => { refreshing = undefined; });
  return refreshing;
}

const phases = {
  idle:'空闲', queued:'追问排队中', waiting_turn:'排队中 · 上轮尚未结束', protected:'原档受保护 · 未投递',
  waiting_owner:'等待 5090 执行进程 · 尚未投递', retrying:'暂未投递 · 将自动重试', sending:'投递中',
  uncertain:'投递待确认', accepted:'已投递 · 等待开工确认', running:'执行中', finished:'本轮已结束', aborted:'本轮已中断',
};
function duration(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(s / 3600)}时${Math.floor(s / 60) % 60}分${s % 60}秒`;
}
function statistics(stats) {
  if (!stats) return '';
  const n = value => value === undefined ? '—' : value.toLocaleString();
  return `累计运行 ${duration(stats.runningMs)} · 工具 ${stats.tools} 次\nToken 输入 ${n(stats.inputTokens)} / 输出 ${n(stats.outputTokens)}`;
}
function statusText(result) {
  const sync = result.sync;
  const phase = result.waiting ? '等待首次执行' : phases[sync?.phase] ?? '连接正常 · 未报告执行状态';
  const queue = sync?.queued ? ` · 队列 ${sync.queued} 条` : '';
  const time = sync?.checkedAt ? ` · ${new Date(sync.checkedAt).toLocaleTimeString('zh-CN', {timeZone:'Asia/Shanghai'})}` : '';
  return `5090 · ${phase}${queue}${time}${result.truncated ? ' · 显示最近过程' : ''}`;
}

function selectRow(row, migratedDraft) {
  if (!row) return;
  selected = row;
  void storage.update('sidebar.selected', row);
  if (!sidebar?.ready) return;
  sidebar.selection = {id:row.id, cursor:0, first:true, polling:false};
  void sidebar.view.webview.postMessage({type:'session', rowId:row.id, title:`${row.bot} · ${row.title}`, draft:migratedDraft});
  void poll(sidebar);
}

async function poll(panel) {
  const row = selected, state = panel.selection;
  if (panel !== sidebar || !panel.ready || !panel.view.visible || !row || !state || state.polling) return;
  state.polling = true;
  try {
    let result = await call(row, `/events?cursor=${state.cursor}`);
    const identity = `${result.source}:${result.epoch}`;
    const switched = state.source !== undefined && identity !== state.source;
    if (switched) result = await call(row, '/events?cursor=0');
    if (panel !== sidebar || state !== panel.selection) return;
    const posted = await panel.view.webview.postMessage({type:'events',rowId:row.id,status:statusText(result),
      events:result.events,reset:state.first || switched || result.reset,statistics:statistics(result.statistics)});
    if (posted) {
      state.cursor = result.cursor;
      state.source = `${result.source}:${result.epoch}`;
      state.first = false;
    }
  } catch {
    if (panel === sidebar && state === panel.selection) void panel.view.webview.postMessage({
      type:'connection',rowId:row.id,text:'5090 暂不可达，会自动重连。',
    });
  } finally { state.polling = false; }
}

async function send(panel, message) {
  const row = selected;
  if (row?.id !== message.rowId || typeof message.text !== 'string' || !message.text.trim() ||
      message.text.length > 100_000 || !/^[\w-]{8,100}$/.test(message.requestId ?? '')) return;
  const correlation = {rowId:row.id, requestId:message.requestId};
  try {
    const receipt = await call(row, `/receipt?requestId=${encodeURIComponent(message.requestId)}`);
    if (receipt.status === 'uncertain') throw Error('5090 正在核对同一请求');
    await call(row, '/input', {text:message.text,requestId:message.requestId});
    void panel.view.webview.postMessage({type:'sent', ...correlation});
    void poll(panel);
  } catch (error) {
    void panel.view.webview.postMessage({type:'error', ...correlation, text:`提交待确认：${error.message}`});
  }
}

function reveal() {
  if (sidebar?.view.visible) sidebar.view.show(false);
  else return vscode.commands.executeCommand(`${VIEW}.focus`);
}

exports.activate = context => {
  storage = context.workspaceState;
  proxies = storage.get('processProxyThreads', []);
  selected = storage.get('sidebar.selected');
  const provider = {
    onDidChangeTreeData:changed.event,
    getChildren:element => element ? rows.filter(row => row.bot === element.bot) :
      [...new Set(rows.map(row => row.bot))].map(bot => ({group:true,bot})),
    getTreeItem:row => {
      if (row.group) return new vscode.TreeItem(row.bot, vscode.TreeItemCollapsibleState.Expanded);
      const item = new vscode.TreeItem(row.title.replace(/\s+/g,' ').slice(0,100));
      item.id = row.id;
      item.description = row.proxy ? '5090 进程代理' : 'Botmux';
      item.tooltip = row.threadId ?? row.title;
      item.command = {command:'botmuxSync.open',title:'打开会话',arguments:[row]};
      return item;
    },
  };
  context.subscriptions.push(changed, vscode.window.registerTreeDataProvider('botmuxSync.threads', provider),
    vscode.window.registerWebviewViewProvider(VIEW, {
      resolveWebviewView(view) {
        const panel = {view, ready:false, selection:undefined};
        sidebar = panel;
        view.webview.options = {enableScripts:true, localResourceRoots:[]};
        view.webview.onDidReceiveMessage(message => {
          if (message.type === 'ready') {
            panel.ready = true;
            postSessions();
            selectRow(selected, storage.get(selected ? `migration:${selected.id}` : 'migration:none'));
          } else if (message.type === 'select') {
            selectRow(rows.find(row => row.id === message.rowId));
          } else if (message.type === 'send') {
            void send(panel, message);
          }
        });
        view.onDidChangeVisibility(() => void poll(panel));
        view.onDidDispose(() => { if (sidebar === panel) sidebar = undefined; });
        view.webview.html = sidebarHtml();
      },
    }, {webviewOptions:{retainContextWhenHidden:true}}),
    vscode.window.registerWebviewPanelSerializer('botmuxSync.chat', {
      async deserializeWebviewPanel(panel, previous) {
        await refresh();
        const old = storage.get(`panel:${previous?.rowId}`);
        const row = rows.find(item => item.id === previous?.rowId || sameRow(old, item)) ?? old;
        if (row) {
          const draft = {draft:previous?.draft ?? '',submission:previous?.submission};
          if (draft.draft || draft.submission) await storage.update(`migration:${row.id}`, draft);
          selectRow(row, draft);
        }
        panel.dispose();
        await reveal();
      },
    }),
    vscode.commands.registerCommand('botmuxSync.refresh', refresh),
    vscode.commands.registerCommand('botmuxSync.open', async row => {
      if (row) selectRow(rows.find(item => sameRow(row, item)));
      await reveal();
      if (!row) void sidebar?.view.webview.postMessage({type:'show-history'});
    }));
  void refresh();
  const discover = setInterval(refresh, 3000);
  const events = setInterval(() => { if (sidebar) void poll(sidebar); }, 1000);
  context.subscriptions.push({dispose:()=>{clearInterval(discover);clearInterval(events);}});
};
