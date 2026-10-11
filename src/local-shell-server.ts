/** Independent local shell. No bot session, model runner, or IM integration. */
import { createServer, type Server, type IncomingMessage } from 'node:http';
import { execFileSync, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as pty from 'node-pty';
import { WebSocket, WebSocketServer } from 'ws';
import { TerminalAccess, issueTerminalEntry, terminalLocalRequest } from './services/terminal-access.js';
import { sendTerminalLockPage } from './utils/terminal-access-page.js';
import { localShellPage } from './utils/local-shell-page.js';

export interface LocalShellConfig {
  dataDir: string;
  id: string;
  port: number;
  cwd: string;
  shell: string;
  tmuxSocket: string;
  publicBaseUrl: string;
}

function shellEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined && !/^(BOTMUX_|CODEX_THREAD_ID$|CODEX_INTERNAL_ORIGINATOR_OVERRIDE$|TRAE_SESSION_ID$|TMUX$|TMUX_PANE$)/.test(key)) env[key] = value;
  }
  return { ...env, TERM: 'xterm-256color', COLORTERM: 'truecolor' };
}

export async function startLocalShell(config: LocalShellConfig): Promise<{ server: Server; port: number; close: () => Promise<void> }> {
  const access = new TerminalAccess(config.dataDir, config.id);
  if (!access.enabled()) throw new Error('Create a password-gated entry with --link before starting the shell service.');
  const tmuxArgs = ['-L', config.tmuxSocket, '-f', '/dev/null'];
  const env = shellEnv();
  function ensureShell(): void {
    if (spawnSync('tmux', [...tmuxArgs, 'has-session', '-t', 'main'], { env, stdio: 'ignore' }).status === 0) return;
    execFileSync('tmux', [...tmuxArgs, 'new-session', '-d', '-s', 'main', '-c', config.cwd, config.shell, '-l'], { env, stdio: 'ignore' });
    execFileSync('tmux', [...tmuxArgs, 'set-option', '-g', 'status', 'off'], { env, stdio: 'ignore' });
    execFileSync('tmux', [...tmuxArgs, 'set-option', '-g', 'history-limit', '5000'], { env, stdio: 'ignore' });
  }
  const server = createServer(async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Botmux-Local-Shell', '1');
    try {
      if (!access.enabled()) { res.writeHead(503); res.end('Terminal gate unavailable'); return; }
      const url = new URL(req.url ?? '/', 'http://localhost');
      // Hook consent belongs to the native CLI typed into the shell.
      if (url.pathname === '/.terminal-auth/hooks') { res.writeHead(404); res.end(); return; }
      if (await access.handle(req, res, url.pathname, () => { throw new Error('native_cli_only'); })) return;
      if (!terminalLocalRequest(req, false)) { res.writeHead(403); res.end('Trusted local gateway required'); return; }
      if (url.pathname !== '/') { res.writeHead(404); res.end(); return; }
      if (!access.authorize(req)) { sendTerminalLockPage(res); return; }
      const nonce = randomBytes(18).toString('base64url');
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Referrer-Policy': 'no-referrer',
        'X-Content-Type-Options': 'nosniff', 'X-Frame-Options': 'DENY',
        'Content-Security-Policy': `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'unsafe-inline'; connect-src 'self'; img-src data:; frame-ancestors 'none'; base-uri 'none'; form-action 'none'` });
      res.end(localShellPage(access.expiry(req), nonce));
    } catch { if (!res.headersSent) res.writeHead(503); res.end('Terminal unavailable'); }
  });
  const wss = new WebSocketServer({ server, maxPayload: 64 * 1024, verifyClient: ({ req }: { req: IncomingMessage }) =>
    access.enabled() && req.url?.split('?')[0] === '/' && terminalLocalRequest(req, true) && access.authorize(req) });
  wss.on('connection', (ws, req) => {
    access.watchSocket(ws, req);
    let terminal: pty.IPty | undefined;
    try {
      ensureShell();
      terminal = pty.spawn('tmux', [...tmuxArgs, 'attach-session', '-t', 'main'], { name: 'xterm-256color', cols: 100, rows: 30, cwd: config.cwd, env });
      terminal.onData(data => {
        if (ws.readyState !== WebSocket.OPEN) return;
        if (!access.enabled() || !access.authorize(req)) { ws.close(1008, 'terminal_locked'); return; }
        if (ws.bufferedAmount > 4 * 1024 * 1024) { ws.close(1013, 'client_too_slow'); return; }
        ws.send(JSON.stringify({ type: 'output', data }));
      });
      terminal.onExit(() => ws.close(1000, 'shell_detached'));
      ws.on('message', raw => {
        if (!access.enabled() || !access.authorize(req)) { ws.close(1008, 'terminal_locked'); return; }
        try {
          const msg = JSON.parse(raw.toString());
          if (msg.type === 'input' && typeof msg.data === 'string' && msg.data.length <= 32768) terminal?.write(msg.data);
          if (msg.type === 'resize' && Number.isInteger(msg.cols) && Number.isInteger(msg.rows)) terminal?.resize(Math.max(20, Math.min(500, msg.cols)), Math.max(5, Math.min(200, msg.rows)));
        } catch { ws.close(1003, 'invalid_message'); }
      });
    } catch { ws.close(1011, 'shell_unavailable'); }
    // Killing the tmux client detaches it; the independent shell keeps running.
    ws.on('close', () => { try { terminal?.kill(); } catch { /* already detached */ } });
  });
  await new Promise<void>((done, reject) => { server.once('error', reject); server.listen(config.port, '127.0.0.1', done); });
  return { server, port: (server.address() as { port: number }).port, close: async () => {
    for (const ws of wss.clients) ws.terminate();
    wss.close(); server.closeAllConnections();
    await new Promise<void>(done => server.close(() => done()));
  } };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const configPath = process.argv[process.argv.indexOf('--config') + 1];
  if (!process.argv.includes('--config') || !configPath) throw new Error('--config <file> required');
  const config = JSON.parse(readFileSync(configPath, 'utf8')) as LocalShellConfig;
  if (process.argv.includes('--link')) {
    const url = new URL(config.publicBaseUrl);
    if (url.protocol !== 'https:' && !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) throw new Error('HTTPS public URL required');
    const entry = issueTerminalEntry(config.dataDir, config.id);
    url.hash = 'entry=' + entry.token;
    console.log(JSON.stringify({ url: url.href, expiresAt: entry.expiresAt, accessSeconds: 300 }));
  } else {
    const service = await startLocalShell(config);
    console.log(`Local shell listening on 127.0.0.1:${service.port}`);
    for (const signal of ['SIGINT', 'SIGTERM'] as const) process.once(signal, () => { service.close().finally(() => process.exit(0)); });
  }
}
