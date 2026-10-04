/** Opt-in, per-session terminal gate. Passwords never leave the loopback HTTP service. */
import { createHash, randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, openSync, closeSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { WebSocket } from 'ws';
import { atomicWriteFileSync } from '../utils/atomic-write.js';

const digest = (s: string) => createHash('sha256').update(s).digest('hex');
const random = () => randomBytes(32).toString('base64url');
export const ENTRY_TTL = 10 * 60_000;
export const ACCESS_TTL = 5 * 60_000;
interface State {
  version: 1;
  sessionId: string;
  epoch: string;
  entryHash: string;
  entryExpires: number;
  salt?: string;
  passwordHash?: string;
  failures: number;
  blockedUntil: number;
}
function path(dir: string, id: string): string {
  return join(dir, 'terminal-access', digest(id) + '.json');
}
function read(dir: string, id: string): State | undefined {
  const file = path(dir, id);
  if (!existsSync(file)) return undefined;
  const state = JSON.parse(readFileSync(file, 'utf8')) as State;
  if (state.version !== 1 || state.sessionId !== id || !state.epoch ||
      typeof state.entryHash !== 'string' || !Number.isFinite(state.entryExpires) ||
      !Number.isFinite(state.failures) || !Number.isFinite(state.blockedUntil) ||
      (!!state.salt !== !!state.passwordHash)) throw new Error('terminal_access_state_invalid');
  return state;
}
function save(dir: string, id: string, state: State): void {
  mkdirSync(join(dir, 'terminal-access'), { recursive: true, mode: 0o700 });
  atomicWriteFileSync(path(dir, id), JSON.stringify(state), { mode: 0o600 });
}
function locked<T>(dir: string, id: string, fn: () => T): T {
  mkdirSync(join(dir, 'terminal-access'), { recursive: true, mode: 0o700 });
  const file = path(dir, id) + '.lock';
  const fd = openSync(file, 'wx', 0o600);
  try { return fn(); } finally { closeSync(fd); unlinkSync(file); }
}
/** Called only by the authenticated local CLI route. Also enables the gate. */
export function issueTerminalEntry(dir: string, id: string, now = Date.now()): { token: string; expiresAt: number } {
  return locked(dir, id, () => {
  const old = read(dir, id);
  const token = random();
  const state: State = old ?? { version: 1, sessionId: id, epoch: random(), entryHash: '', entryExpires: 0, failures: 0, blockedUntil: 0 };
  state.entryHash = digest(token);
  state.entryExpires = now + ENTRY_TTL;
  save(dir, id, state);
  return { token, expiresAt: state.entryExpires };
  });
}
export function terminalAccessEnabled(dir: string, id: string): boolean {
  // Existence alone is enough: malformed state must fail closed, never revert to legacy tokens.
  return existsSync(path(dir, id));
}
const loopback = (value = '') => ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(value);
export function terminalLocalRequest(req: IncomingMessage, requireOrigin: boolean): boolean {
  try {
    if (!loopback(req.socket.remoteAddress)) return false;
    const host = req.headers.host;
    if (!host || /[@\\/\s]/.test(host)) return false;
    const url = new URL('http://' + host);
    if (!['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) return false;
    if (req.headers.origin !== undefined && req.headers.origin !== url.origin) return false;
    return !requireOrigin || req.headers.origin === url.origin;
  } catch { return false; }
}
async function passwordHash(password: string, salt: string): Promise<string> {
  const derived = await new Promise<Buffer>((resolve, reject) => scrypt(password, salt, 32,
    { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 }, (error, key) => error ? reject(error) : resolve(key)));
  return derived.toString('hex');
}
function equalHex(a: string, b: string): boolean {
  const x = Buffer.from(a, 'hex'), y = Buffer.from(b, 'hex');
  return x.length === 32 && y.length === 32 && timingSafeEqual(x, y);
}
function reply(res: ServerResponse, code: number, data: unknown): void {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
  res.end(JSON.stringify(data));
}
async function body(req: IncomingMessage): Promise<Record<string, unknown>> {
  if (req.headers['content-type'] !== 'application/json') throw new Error('json_required');
  let value = '';
  for await (const chunk of req) {
    value += chunk;
    if (Buffer.byteLength(value) > 4096) throw new Error('body_too_large');
  }
  const parsed = JSON.parse(value);
  if (!parsed || Array.isArray(parsed) || typeof parsed !== 'object') throw new Error('bad_json');
  return parsed;
}

export class TerminalAccess {
  private grants = new Map<string, { expires: number; epoch: string }>();
  private sockets = new Map<WebSocket, IncomingMessage>();
  private busy = false;
  readonly cookieName: string;
  constructor(private dir: string, private id: string, private now = Date.now) {
    this.cookieName = 'botmux_terminal_' + digest(id).slice(0, 16);
  }
  enabled(): boolean { return terminalAccessEnabled(this.dir, this.id); }
  private cookie(req: IncomingMessage): string {
    const cookies = (req.headers.cookie ?? '').split(';').map(p => p.trim());
    return cookies.find(p => p.startsWith(this.cookieName + '='))?.slice(this.cookieName.length + 1) ?? '';
  }
  expiry(req: IncomingMessage): number {
    if (!terminalLocalRequest(req, false)) return 0;
    try {
      const grant = this.grants.get(digest(this.cookie(req)));
      const state = read(this.dir, this.id);
      return grant && state && grant.epoch === state.epoch && grant.expires > this.now() ? grant.expires : 0;
    } catch { return 0; }
  }
  authorize(req: IncomingMessage): boolean { return !!this.expiry(req); }
  watchSocket(ws: WebSocket, req: IncomingMessage): void {
    this.sockets.set(ws, req);
    const check = () => { if (this.enabled() && !this.authorize(req)) ws.close(1008, 'terminal_locked'); };
    const timer = setInterval(check, 500);
    timer.unref();
    ws.on('close', () => { clearInterval(timer); this.sockets.delete(ws); });
    check();
  }
  async handle(req: IncomingMessage, res: ServerResponse, pathname: string, approveHooks: () => unknown): Promise<boolean> {
    if (!this.enabled() || !pathname.startsWith('/.terminal-auth/')) return false;
    if (!terminalLocalRequest(req, req.method !== 'GET')) {
      reply(res, 403, { error: '请通过 localhost 或 SSH 隧道打开此终端。' }); return true;
    }
    try {
      const state = read(this.dir, this.id)!;
      const action = pathname.slice('/.terminal-auth/'.length);
      if (action === 'status' && req.method === 'GET') {
        reply(res, 200, { setup: !state.passwordHash, expiresAt: this.expiry(req), accessSeconds: ACCESS_TTL / 1000 }); return true;
      }
      if (req.method !== 'POST') { reply(res, 405, { error: 'method_not_allowed' }); return true; }
      const input = await body(req);
      if (action === 'lock') {
        this.grants.delete(digest(this.cookie(req)));
        for (const [ws, request] of this.sockets) if (!this.authorize(request)) ws.close(1008, 'terminal_locked');
        res.setHeader('Set-Cookie', `${this.cookieName}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0`);
        reply(res, 200, { ok: true }); return true;
      }
      if (action === 'hooks') {
        if (!this.authorize(req)) { reply(res, 401, { error: '请先解锁终端。' }); return true; }
        if (input.confirm !== true) { reply(res, 400, { error: 'confirmation_required' }); return true; }
        reply(res, 200, { ok: true, result: approveHooks() }); return true;
      }
      if (!['setup', 'unlock'].includes(action)) { reply(res, 404, { error: 'not_found' }); return true; }
      if (this.busy || state.blockedUntil > this.now()) {
        reply(res, 429, { error: '尝试过于频繁，请稍后重试。' }); return true;
      }
      // The entry token is required before expensive password work. Never sent in a query string.
      if (typeof input.entry !== 'string' || input.entry.length > 100 ||
          state.entryExpires <= this.now() || !equalHex(digest(input.entry), state.entryHash)) {
        reply(res, 401, { error: '链接已过期或已使用，请重新获取安全终端链接。' }); return true;
      }
      if (typeof input.password !== 'string' || input.password.length < 12 || input.password.length > 256) {
        reply(res, 400, { error: '密码需要 12 至 256 个字符。' }); return true;
      }
      if (action === 'setup' && (state.passwordHash || input.confirmPassword !== input.password)) {
        reply(res, 409, { error: '密码已设置，或两次密码不一致。' }); return true;
      }
      if (action === 'unlock' && !state.passwordHash) { reply(res, 409, { error: '请先设置密码。' }); return true; }
      this.busy = true;
      try {
        const salt = state.salt ?? random();
        const hash = await passwordHash(input.password, salt);
        return locked(this.dir, this.id, () => {
        const latest = read(this.dir, this.id)!;
        // A link rotation or another setup during scrypt invalidates this attempt.
        if (latest.entryHash !== state.entryHash || latest.epoch !== state.epoch || latest.passwordHash !== state.passwordHash || latest.entryExpires <= this.now()) {
          reply(res, 409, { error: '链接已更新，请使用最新链接。' }); return true;
        }
        if (action === 'unlock' && !equalHex(hash, state.passwordHash!)) {
          latest.failures++;
          latest.blockedUntil = this.now() + Math.min(60_000, 1000 * 2 ** Math.min(latest.failures, 6));
          save(this.dir, this.id, latest);
          reply(res, 401, { error: '密码不正确。' }); return true;
        }
        latest.passwordHash = hash;
        latest.salt = salt;
        latest.entryHash = '';
        latest.entryExpires = 0;
        latest.failures = 0;
        latest.blockedUntil = 0;
        save(this.dir, this.id, latest);
        const token = random(), expires = this.now() + ACCESS_TTL;
        for (const [key, grant] of this.grants) if (grant.expires <= this.now()) this.grants.delete(key);
        this.grants.set(digest(token), { expires, epoch: latest.epoch });
        res.setHeader('Set-Cookie', `${this.cookieName}=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${ACCESS_TTL / 1000}`);
        reply(res, 200, { ok: true, expiresAt: expires }); return true;
        });
      } finally { this.busy = false; }
    } catch {
      reply(res, 400, { error: '请求或本机安全配置无效。' }); return true;
    }
  }
}
