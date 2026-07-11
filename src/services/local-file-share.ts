import { existsSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { isIP } from 'node:net';
import { parse as parseDotenv } from 'dotenv';
import { config } from '../config.js';

const FILE_SHARE_ENV_KEYS = [
  'BOTMUX_FILE_SHARE_ENABLED',
  'BOTMUX_FILE_SHARE_BASE_URL',
  'BOTMUX_FILE_SHARE_TTL_HOURS',
  'BOTMUX_FILE_SHARE_MAX_BYTES',
  'BOTMUX_FILE_SHARE_MD_MAX_BYTES',
  'BOTMUX_FILE_SHARE_RATE_LIMIT',
  'BOTMUX_FILE_SHARE_ROOTS',
  'BOTMUX_FILE_SHARE_ALLOW_PUBLIC',
  'BOTMUX_FILE_SHARE_CLI',
  'BOTMUX_FILE_SHARE_UPSTREAM_URL',
] as const;

type FileShareEnvKey = typeof FILE_SHARE_ENV_KEYS[number];

export interface RegisterLocalFileOptions {
  dataDir: string;
  roots: string[];
  baseUrl?: string;
  now?: number;
  ttlMs?: number;
  expiresAt?: number;
  maxBytes?: number;
}

export interface RewriteLocalFileLinksOptions extends RegisterLocalFileOptions {
  enabled?: boolean;
}

export interface RewriteLocalFileLinksResult {
  content: string;
  shared: Array<{ path: string; url: string; expiresAt?: number }>;
  skipped: Array<{ path: string; reason: string }>;
}

let dotEnvCache: { mtimeMs: number; values: Record<string, string> } | undefined;
function setting(name: FileShareEnvKey): string | undefined {
  if (process.env[name] != null) return process.env[name];
  const path = join(homedir(), '.botmux', '.env');
  try {
    const mtimeMs = statSync(path).mtimeMs;
    if (!dotEnvCache || dotEnvCache.mtimeMs !== mtimeMs) {
      dotEnvCache = { mtimeMs, values: parseDotenv(readFileSync(path, 'utf8')) };
    }
    return dotEnvCache.values[name];
  } catch { return undefined; }
}

function envBool(name: 'BOTMUX_FILE_SHARE_ENABLED' | 'BOTMUX_FILE_SHARE_ALLOW_PUBLIC', fallback: boolean): boolean {
  const value = setting(name);
  return value == null || value === '' ? fallback : value.toLowerCase() === 'true';
}

export function localFileShareEnabled(): boolean {
  return envBool('BOTMUX_FILE_SHARE_ENABLED', false);
}

export function localFileSharePolicyEnv(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const key of FILE_SHARE_ENV_KEYS) {
    const value = setting(key);
    if (value != null && value !== '') out[key] = value;
  }
  return out;
}

export function configuredFileShareRoots(primaryRoot?: string): string[] {
  const configured = (setting('BOTMUX_FILE_SHARE_ROOTS') ?? '')
    .split(process.platform === 'win32' ? ';' : ':')
    .map(value => value.trim())
    .filter(Boolean);
  return [primaryRoot ?? '', ...configured].filter(Boolean);
}

export function resolveLocalFileShareBaseUrl(): string {
  const explicit = setting('BOTMUX_FILE_SHARE_BASE_URL')?.trim();
  if (explicit) return explicit.replace(/\/$/, '');
  let port: string | number = config.dashboard.port;
  try {
    const persisted = readFileSync(join(homedir(), '.botmux', '.dashboard-port'), 'utf8').trim();
    if (/^\d+$/.test(persisted)) port = persisted;
  } catch {}
  return `http://${config.dashboard.externalHost}:${port}`;
}

function resolveCli(): string | null {
  const configured = setting('BOTMUX_FILE_SHARE_CLI')?.trim();
  if (configured) return existsSync(configured) ? configured : null;
  const candidates = [
    join(homedir(), '.local', 'bin', 'botmux-secure-local-file-share'),
    join(homedir(), '.local', 'bin', 'secure-local-file-share'),
    join(homedir(), 'workspace', 'd', 'irepo', 'subrepo', 'botmux-secure-local-file-share', 'dist', 'cli.mjs'),
  ].filter((value): value is string => !!value);
  return candidates.find(path => existsSync(path)) ?? null;
}

export function rewriteLocalFileLinks(input: string, opts: RewriteLocalFileLinksOptions): RewriteLocalFileLinksResult {
  const empty = { content: input, shared: [], skipped: [] };
  if (!(opts.enabled ?? localFileShareEnabled()) || !input) return empty;
  const cli = resolveCli();
  if (!cli) return { ...empty, skipped: [{ path: '', reason: 'file_share_cli_unavailable' }] };
  const command = [
    'rewrite',
    '--data-dir', opts.dataDir,
    '--roots-json', JSON.stringify(opts.roots),
    '--base-url', opts.baseUrl ?? resolveLocalFileShareBaseUrl(),
  ];
  if (opts.ttlMs) command.push('--ttl-hours', String(opts.ttlMs / 3_600_000));
  if (opts.maxBytes) command.push('--max-bytes', String(opts.maxBytes));
  const result = spawnSync(cli, command, {
    input: JSON.stringify({ content: input }),
    encoding: 'utf8',
    timeout: 10_000,
    maxBuffer: 4 * 1024 * 1024,
  });
  if (result.status !== 0) {
    const reason = result.error?.message || result.stderr.trim() || `exit_${result.status}`;
    return { ...empty, skipped: [{ path: '', reason: `file_share_cli_failed:${reason.slice(0, 300)}` }] };
  }
  try {
    return JSON.parse(result.stdout) as RewriteLocalFileLinksResult;
  } catch {
    return { ...empty, skipped: [{ path: '', reason: 'file_share_cli_invalid_json' }] };
  }
}

function privateAddress(input: string | undefined): boolean {
  if (!input) return false;
  const ip = input.replace(/^::ffff:/, '').replace(/%[^%]+$/, '').toLowerCase();
  if (isIP(ip) === 0) return false;
  if (ip === '::1' || ip === '127.0.0.1') return true;
  if (/^10\./.test(ip) || /^192\.168\./.test(ip) || /^169\.254\./.test(ip)) return true;
  const v4 = ip.match(/^(\d{1,3})\.(\d{1,3})\./);
  if (v4 && Number(v4[1]) === 172 && Number(v4[2]) >= 16 && Number(v4[2]) <= 31) return true;
  return ip.startsWith('fc') || ip.startsWith('fd') || ip.startsWith('fe80:');
}

function privateHost(hostHeader: string | undefined): boolean {
  if (!hostHeader) return false;
  const raw = hostHeader.trim().toLowerCase();
  if (raw === 'localhost' || raw.startsWith('localhost:')) return true;
  const host = raw.startsWith('[') ? raw.slice(1, raw.indexOf(']')) : raw.replace(/:\d+$/, '');
  return privateAddress(host);
}

function plain(res: ServerResponse, status: number, message: string): void {
  res.writeHead(status, {
    'content-type': 'text/plain; charset=utf-8',
    'cache-control': 'private, no-store, max-age=0',
    'x-content-type-options': 'nosniff',
    'x-frame-options': 'DENY',
    'referrer-policy': 'no-referrer',
  });
  res.end(message);
}

export function handleLocalFileShareRequest(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  opts: { dataDir: string; now?: number; enabled?: boolean },
): boolean {
  if (!url.pathname.startsWith('/f/')) return false;
  if (!(opts.enabled ?? localFileShareEnabled())) { plain(res, 404, 'Not found'); return true; }
  if (!envBool('BOTMUX_FILE_SHARE_ALLOW_PUBLIC', false)
    && !(privateAddress(req.socket.remoteAddress) && privateHost(req.headers.host))) {
    plain(res, 404, 'Not found');
    return true;
  }
  if (req.method !== 'GET' && req.method !== 'HEAD') { res.setHeader('allow', 'GET, HEAD'); plain(res, 405, 'Method not allowed'); return true; }

  const upstream = new URL(setting('BOTMUX_FILE_SHARE_UPSTREAM_URL') || 'http://127.0.0.1:7892');
  const target = new URL(`${url.pathname}${url.search}`, upstream);
  const transport = target.protocol === 'https:' ? httpsRequest : httpRequest;
  const proxy = transport(target, {
    method: req.method,
    headers: {
      host: upstream.host,
      'x-real-ip': req.socket.remoteAddress ?? '',
      'x-forwarded-proto': req.headers['x-forwarded-proto'] ?? 'http',
    },
  }, upstreamResponse => {
    res.writeHead(upstreamResponse.statusCode ?? 502, upstreamResponse.headers);
    upstreamResponse.pipe(res);
  });
  proxy.setTimeout(15_000, () => proxy.destroy(new Error('file share upstream timeout')));
  proxy.on('error', () => {
    if (!res.headersSent) plain(res, 502, '文件分享服务暂不可用');
    else res.destroy();
  });
  proxy.end();
  return true;
}

export function __testOnlyResetFileShareRateLimit(): void {
  dotEnvCache = undefined;
}
