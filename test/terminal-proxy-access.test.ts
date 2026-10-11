import { afterEach, expect, it } from 'vitest';
import { createServer, request, type IncomingMessage, type Server } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { networkInterfaces, tmpdir } from 'node:os';
import { join } from 'node:path';
import { WebSocket } from 'ws';
import { issueTerminalEntry, terminalProxyRequestAllowed } from '../src/services/terminal-access.js';
import { startTerminalProxy, type TerminalProxyHandle } from '../src/core/terminal-proxy.js';

const remote = Object.values(networkInterfaces()).flat().find(i => i?.family === 'IPv4' && !i.internal)?.address;
let dir: string | undefined, proxy: TerminalProxyHandle | undefined, upstream: Server | undefined;
afterEach(async () => {
  await proxy?.close();
  if (upstream) await new Promise<void>(resolve => upstream!.close(() => resolve()));
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = undefined; proxy = undefined; upstream = undefined;
});

it('checks the original peer, host and origin only for protected sessions', () => {
  dir = mkdtempSync(join(tmpdir(), 'terminal-proxy-access-'));
  const req = { method: 'GET', socket: { remoteAddress: '10.0.0.4' },
    headers: { host: 'localhost:8805', origin: 'http://localhost:8805', 'x-forwarded-for': '127.0.0.1' } };
  const allowed = () => terminalProxyRequestAllowed(dir!, 'protected', req as unknown as IncomingMessage);
  expect(allowed()).toBe(true);
  issueTerminalEntry(dir, 'protected');
  expect(allowed()).toBe(false);
  req.socket.remoteAddress = '127.0.0.1';
  expect(allowed()).toBe(true);
  req.headers.origin = 'http://attacker.invalid';
  expect(allowed()).toBe(false);
});

it.skipIf(!remote)('blocks remote HTTP and WebSocket requests with spoofed localhost headers after gate activation', async () => {
  dir = mkdtempSync(join(tmpdir(), 'terminal-proxy-access-'));
  let forwarded = 0;
  upstream = createServer((_req, res) => { forwarded++; res.end('upstream'); });
  await new Promise<void>(resolve => upstream!.listen(0, '127.0.0.1', resolve));
  const workerPort = (upstream.address() as { port: number }).port;
  proxy = await startTerminalProxy({ port: 0, host: '0.0.0.0', resolvePort: () => workerPort,
    authorizeRequest: (id, req) => terminalProxyRequestAllowed(dir!, id, req) });
  const headers = { Host: `localhost:${proxy.port}`, Origin: `http://localhost:${proxy.port}`,
    'X-Forwarded-For': '127.0.0.1', 'X-Forwarded-Proto': 'https' };
  const get = (host: string) => new Promise<number>((resolve, reject) => {
    request({ host, port: proxy!.port, path: '/s/protected/.terminal-auth/status', headers }, res => {
      res.resume(); res.on('end', () => resolve(res.statusCode!));
    }).on('error', reject).end();
  });
  expect(await get(remote!)).toBe(200);
  issueTerminalEntry(dir, 'protected');
  expect(await get(remote!)).toBe(403);
  expect(await get('127.0.0.1')).toBe(200);
  expect(forwarded).toBe(2);
  const status = await new Promise<number>((resolve, reject) => {
    const ws = new WebSocket(`ws://${remote}:${proxy!.port}/s/protected/`, { headers, handshakeTimeout: 3000 });
    ws.on('unexpected-response', (_req, res) => { res.resume(); ws.terminate(); resolve(res.statusCode!); });
    ws.on('open', () => { ws.terminate(); reject(new Error('remote WebSocket passed proxy')); });
    ws.on('error', () => {});
  });
  expect(status).toBe(403);
  expect(forwarded).toBe(2);
});
