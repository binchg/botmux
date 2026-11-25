import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { createServer } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';
import WebSocket from 'ws';

export interface CodexVscodeSshTarget {
  host: string;
  authority: string;
  debugPort: number;
}

interface DebugTarget { type: string; url: string; webSocketDebuggerUrl?: string }
interface ThreadIdentity { id?: string; path?: string; status?: { type?: string } }

export function findCodexVscodeFrame(targets: DebugTarget[], authority: string): DebugTarget | undefined {
  const frames = targets.filter(target => {
    if (target.type !== 'iframe' || !target.webSocketDebuggerUrl) return false;
    const url = new URL(target.url.replaceAll('&amp;', '&'));
    return url.protocol === 'vscode-webview:' && url.searchParams.get('extensionId') === 'openai.chatgpt' &&
      url.searchParams.get('remoteAuthority') === authority && url.searchParams.get('purpose') === 'webviewView';
  });
  return frames.length === 1 ? frames[0] : undefined;
}

export function sameCodexVscodeThread(actual: ThreadIdentity | undefined, threadId: string, rolloutPath: string): boolean {
  return actual?.id === threadId && typeof actual.path === 'string' &&
    realpathSync(actual.path) === realpathSync(rolloutPath);
}

async function reserveLocalPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const listener = createServer();
    listener.on('error', reject);
    listener.listen(0, '127.0.0.1', () => {
      const address = listener.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      listener.close(error => error ? reject(error) : resolve(port));
    });
  });
}

async function listTargets(port: number, isAlive: () => boolean): Promise<DebugTarget[]> {
  for (let attempt = 0; attempt < 16 && isAlive(); attempt++) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(500) });
      if (res.ok) return await res.json() as DebugTarget[];
    } catch { /* SSH may still be opening the local forward. */ }
    await delay(250);
  }
  return [];
}

function evaluate(socket: WebSocket, expression: string, timeoutMs: number): Promise<any> {
  return new Promise((resolve, reject) => {
    const id = 1;
    const dispose = () => {
      clearTimeout(timer);
      socket.off('message', onMessage);
      socket.off('close', onClose);
    };
    const onClose = () => { dispose(); reject(new Error('VS Code SSH webview disconnected')); };
    const onMessage = (data: WebSocket.RawData) => {
      let response: any;
      try { response = JSON.parse(data.toString()); } catch { return; }
      if (response.id !== id) return;
      dispose();
      if (response.error || response.result?.exceptionDetails) reject(new Error('VS Code SSH webview evaluation failed'));
      else resolve(response.result?.result?.value);
    };
    const timer = setTimeout(() => { dispose(); reject(new Error('VS Code SSH webview request timed out')); }, timeoutMs);
    socket.on('message', onMessage);
    socket.once('close', onClose);
    socket.send(JSON.stringify({ id, method: 'Runtime.evaluate', params: { expression, returnByValue: true, awaitPromise: true } }));
  });
}

function request(socket: WebSocket, method: string, params: object, timeoutMs = 8000): Promise<any> {
  const id = randomUUID();
  // This is the existing VS Code webview transport. Use the extension's app
  // server so the same window owns the request and receives turn notifications.
  return evaluate(socket, `(async () => {
    const view = document.querySelector("#active-frame")?.contentWindow;
    if (!view || typeof window.__vscode_post_message__ !== "function") return { unavailable: true };
    const id = ${JSON.stringify(id)};
    return await new Promise(resolve => {
      const finish = value => {
        clearTimeout(timer);
        view.removeEventListener("message", onMessage);
        resolve(value);
      };
      const onMessage = event => {
        const data = event.data;
        if (data?.type !== "mcp-response" || data.hostId !== "local" || data.message?.id !== id) return;
        const { result, error } = data.message;
        finish({ result: { thread: result?.thread && { id: result.thread.id, path: result.thread.path, status: result.thread.status },
          turnId: result?.turn?.id }, rejected: !!error });
      };
      const timer = setTimeout(() => finish({ timeout: true }), ${timeoutMs});
      view.addEventListener("message", onMessage);
      window.__vscode_post_message__("onmessage", { message: { type: "mcp-request", hostId: "local",
        request: { id, method: ${JSON.stringify(method)}, params: ${JSON.stringify(params)} } }, transfer: [] });
    });
  })()`, timeoutMs + 1000);
}

export async function submitToVscodeSsh(target: CodexVscodeSshTarget, threadId: string, rolloutPath: string, text: string,
  checkpoint: (submitted?: boolean) => void, clientUserMessageId?: string): Promise<boolean> {
  if (!/^[a-zA-Z0-9_.][a-zA-Z0-9_.-]{0,100}$/.test(target.host) || !target.authority.startsWith('ssh-remote+') ||
      !Number.isInteger(target.debugPort) || target.debugPort < 1 || target.debugPort > 65535) return false;
  const port = await reserveLocalPort();
  const ssh = spawn('ssh', ['-NT', '-oBatchMode=yes', '-oConnectTimeout=4', '-oExitOnForwardFailure=yes',
    '-L', `127.0.0.1:${port}:127.0.0.1:${target.debugPort}`, target.host], { stdio: 'ignore' });
  let alive = true;
  ssh.once('error', () => { alive = false; });
  ssh.once('exit', () => { alive = false; });
  let socket: WebSocket | undefined;
  try {
    const frame = findCodexVscodeFrame(await listTargets(port, () => alive), target.authority);
    if (!frame?.webSocketDebuggerUrl || !alive) return false;
    const endpoint = new URL(frame.webSocketDebuggerUrl);
    if (endpoint.protocol !== 'ws:' || !endpoint.pathname.startsWith('/devtools/page/')) return false;
    endpoint.hostname = '127.0.0.1';
    endpoint.port = String(port);
    const connection = socket = new WebSocket(endpoint, { handshakeTimeout: 3000 });
    connection.on('error', () => {});
    await new Promise<void>((resolve, reject) => {
      connection.once('open', resolve);
      connection.once('error', reject);
    });
    let preflight = await request(connection, 'thread/read', { threadId, includeTurns: false });
    if (!sameCodexVscodeThread(preflight?.result?.thread, threadId, rolloutPath)) return false;
    if (preflight.result.thread.status?.type === 'active') throw new Error('VS Code SSH is still working on this thread');
    if (preflight.result.thread.status?.type === 'notLoaded') {
      preflight = await request(connection, 'thread/resume', { threadId, excludeTurns: true, persistExtendedHistory: true }, 30_000);
      if (!sameCodexVscodeThread(preflight?.result?.thread, threadId, rolloutPath)) return false;
      if (preflight.result.thread.status?.type === 'active') throw new Error('VS Code SSH is still working on this thread');
    }
    checkpoint();
    const result = await request(connection, 'turn/start', {
      threadId, input: [{ type: 'text', text, text_elements: [] }], clientUserMessageId: clientUserMessageId ?? randomUUID(),
    }, 90_000);
    if (typeof result?.result?.turnId !== 'string') throw new Error('VS Code SSH did not confirm the original turn; follow-up retained');
    return true;
  } finally {
    socket?.close();
    if (alive) ssh.kill();
  }
}
