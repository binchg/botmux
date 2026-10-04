import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createServer, request, type Server } from 'node:http';
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WebSocket, WebSocketServer } from 'ws';
import { ACCESS_TTL, ENTRY_TTL, issueTerminalEntry, TerminalAccess, terminalLocalRequest } from '../src/services/terminal-access.js';
import { sendTerminalLockPage } from '../src/utils/terminal-access-page.js';

describe('password-protected terminal boundary', () => {
  let dir: string, server: Server, wss: WebSocketServer, access: TerminalAccess, base: string;
  let now: number, entry: string;
  const hooks = vi.fn(() => ({ appliesTo: 'next_turn' }));
  const password = 'test-only-strong-password-42';
  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'botmux-terminal-'));
    now = Date.now();
    access = new TerminalAccess(dir, 'session-a', () => now);
    entry = issueTerminalEntry(dir, 'session-a', now).token;
    hooks.mockClear();
    server = createServer(async (req, res) => {
      if (await access.handle(req, res, new URL(req.url!, base).pathname, hooks)) return;
      if (!access.authorize(req)) { sendTerminalLockPage(res); return; }
      res.end('protected-output');
    });
    wss = new WebSocketServer({ server, verifyClient: info => terminalLocalRequest(info.req, true) && access.authorize(info.req) });
    wss.on('connection', (ws, req) => {
      access.watchSocket(ws, req);
      ws.on('message', data => { if (access.authorize(req)) ws.send(data); else ws.close(1008); });
    });
    await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  });
  afterEach(async () => {
    for (const ws of wss.clients) ws.terminate();
    wss.close();
    server.closeAllConnections();
    await new Promise<void>(r => server.close(() => r()));
    rmSync(dir, { recursive: true, force: true });
  });
  async function post(action: string, data: unknown, cookie = '', origin = base) {
    return fetch(`${base}/.terminal-auth/${action}`, { method: 'POST', headers: {
      'Content-Type': 'application/json', Origin: origin, Cookie: cookie,
    }, body: JSON.stringify(data) });
  }
  async function setup() {
    const result = await post('setup', { entry, password, confirmPassword: password });
    expect(result.status).toBe(200);
    expect(result.headers.get('set-cookie')).toContain('HttpOnly; SameSite=Strict');
    return result.headers.get('set-cookie')!.split(';')[0];
  }
  async function rejectedSocket(cookie = '', origin = base, extra: Record<string, string> = {}) {
    return new Promise<number>((resolve, reject) => {
      const ws = new WebSocket(base.replace('http:', 'ws:') + '/?token=legacy-token', { headers: { Cookie: cookie, Origin: origin, ...extra } });
      ws.on('unexpected-response', (_req, res) => { res.resume(); ws.terminate(); resolve(res.statusCode!); });
      ws.on('open', () => { ws.terminate(); reject(Error('unauthorized websocket opened')); });
      ws.on('error', () => {});
    });
  }
  it('keeps output, websocket and hooks locked before owner setup, including legacy credentials', async () => {
    const r = await fetch(base + '/?token=legacy-token', { headers: { 'x-botmux-role': 'owner' } });
    const html = await r.text();
    expect(html).toContain('type="password"');
    expect(html).not.toContain('protected-output');
    expect(r.headers.get('content-security-policy')).toContain("frame-ancestors 'none'");
    expect(await rejectedSocket('', base, { 'x-botmux-role': 'owner' })).toBe(401);
    expect((await post('hooks', { confirm: true })).status).toBe(401);
    expect(hooks).not.toHaveBeenCalled();
  });
  it('requires matching confirmation and a valid one-time entry; stores only a private salted hash', async () => {
    expect((await post('setup', { entry, password, confirmPassword: 'different-password' })).status).toBe(409);
    expect((await post('setup', { entry: 'wrong', password, confirmPassword: password })).status).toBe(401);
    const cookie = await setup();
    expect(await (await fetch(base, { headers: { Cookie: cookie } })).text()).toBe('protected-output');
    expect((await post('unlock', { entry, password })).status).toBe(401);
    const file = join(dir, 'terminal-access', readdirSync(join(dir, 'terminal-access'))[0]);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(readFileSync(file, 'utf8')).not.toContain(password);
    expect(readFileSync(file, 'utf8')).not.toContain(entry);
  });
  it('rejects cross-origin requests, non-loopback hosts, and missing WS origin even with a valid grant', async () => {
    const cookie = await setup();
    expect((await post('hooks', { confirm: true }, cookie, 'https://evil.example')).status).toBe(403);
    expect(await rejectedSocket(cookie, 'https://evil.example')).toBe(401);
    expect(await rejectedSocket(cookie, '')).toBe(401);
    const status = await new Promise<number>((resolve, reject) => {
      const req = request(base + '/.terminal-auth/status', { headers: { Host: 'evil.example', Cookie: cookie } }, res => { res.resume(); resolve(res.statusCode!); });
      req.on('error', reject); req.end();
    });
    expect(status).toBe(403);
    expect(hooks).not.toHaveBeenCalled();
  });
  it('requires password again on a fresh entry and rate limits incorrect passwords durably', async () => {
    await setup();
    entry = issueTerminalEntry(dir, 'session-a', now).token;
    expect((await post('unlock', { entry, password: 'incorrect-long-password' })).status).toBe(401);
    access = new TerminalAccess(dir, 'session-a', () => now);
    expect((await post('unlock', { entry, password })).status).toBe(429);
    now += 2001;
    expect((await post('unlock', { entry, password })).status).toBe(200);
  });
  it('expires entries and active grants without sliding renewal', async () => {
    now += ENTRY_TTL;
    expect((await post('setup', { entry, password, confirmPassword: password })).status).toBe(401);
    entry = issueTerminalEntry(dir, 'session-a', now).token;
    const cookie = await setup();
    now += ACCESS_TTL;
    expect((await post('hooks', { confirm: true }, cookie)).status).toBe(401);
    expect(await rejectedSocket(cookie)).toBe(401);
  });
  it('closes connected sockets on logout and requires explicit hooks confirmation', async () => {
    const cookie = await setup();
    expect((await post('hooks', {}, cookie)).status).toBe(400);
    expect((await post('hooks', { confirm: true }, cookie)).status).toBe(200);
    expect(hooks).toHaveBeenCalledTimes(1);
    const ws = new WebSocket(base.replace('http:', 'ws:'), { headers: { Origin: base, Cookie: cookie } });
    await new Promise<void>((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
    const closed = new Promise<number>(resolve => ws.once('close', resolve));
    expect((await post('lock', {}, cookie)).status).toBe(200);
    expect(await closed).toBe(1008);
    expect((await post('hooks', { confirm: true }, cookie)).status).toBe(401);
  });
  it('closes an already connected socket when its grant expires', async () => {
    const cookie = await setup();
    const ws = new WebSocket(base.replace('http:', 'ws:'), { headers: { Origin: base, Cookie: cookie } });
    await new Promise<void>((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
    const closed = new Promise<number>(resolve => ws.once('close', resolve));
    now += ACCESS_TTL;
    ws.send('must-not-execute');
    expect(await closed).toBe(1008);
  });
  it('does not reuse grants across sessions or process restarts and fails closed on damaged state', async () => {
    const cookie = await setup();
    access = new TerminalAccess(dir, 'session-a', () => now);
    expect(await rejectedSocket(cookie)).toBe(401);
    const file = join(dir, 'terminal-access', readdirSync(join(dir, 'terminal-access'))[0]);
    writeFileSync(file, '{broken');
    expect(access.enabled()).toBe(true);
    expect(await rejectedSocket(cookie)).toBe(401);
    expect((await post('unlock', { entry, password })).status).toBe(400);
  });
  it('allows only one simultaneous setup and preserves the first chosen password', async () => {
    const results = await Promise.all([
      post('setup', { entry, password, confirmPassword: password }),
      post('setup', { entry, password: 'competing-password-42', confirmPassword: 'competing-password-42' }),
    ]);
    expect(results.map(r => r.status).sort()).toEqual([200, 429]);
    entry = issueTerminalEntry(dir, 'session-a', now).token;
    expect((await post('unlock', { entry, password })).status).toBe(200);
  });
});
