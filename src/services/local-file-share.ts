import { createReadStream, existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, statSync, unlinkSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { randomBytes } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { isIP } from 'node:net';
import MarkdownIt from 'markdown-it';
import type Token from 'markdown-it/lib/token.mjs';
import { parse as parseDotenv } from 'dotenv';
import { atomicWriteFileSync } from '../utils/atomic-write.js';
import { config } from '../config.js';

const SHARE_VERSION = 1;
const TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;
const DEFAULT_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const DEFAULT_MAX_BYTES = 50 * 1024 * 1024;
const DEFAULT_MD_MAX_BYTES = 5 * 1024 * 1024;
const RATE_WINDOW_MS = 60_000;
const DEFAULT_RATE_LIMIT = 120;
const MAX_LOCAL_MD_ASSETS = 64;

const MARKDOWN_LINK_RE = /(!?\[[^\]\n]*\]\()(<(?:file:\/\/)?\/[^>\n]+>|(?:file:\/\/)?\/[^\s)\n]+)((?:\s+["'][^"'\n]*["'])?)\)/g;

const INLINE_MIME: Record<string, string> = {
  '.txt': 'text/plain; charset=utf-8',
  '.log': 'text/plain; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.xml': 'application/xml; charset=utf-8',
  '.csv': 'text/csv; charset=utf-8',
  '.pdf': 'application/pdf',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
};

const SENSITIVE_BASENAMES = new Set([
  '.env', 'id_rsa', 'id_dsa', 'id_ecdsa', 'id_ed25519',
  'credentials', 'credentials.json', 'secrets.json',
]);
const SENSITIVE_EXTENSIONS = new Set(['.pem', '.key', '.p12', '.pfx', '.jks', '.keystore']);
const SENSITIVE_SEGMENTS = new Set(['.git', '.ssh', '.botmux']);
const FILE_SHARE_ENV_KEYS = [
  'BOTMUX_FILE_SHARE_ENABLED',
  'BOTMUX_FILE_SHARE_BASE_URL',
  'BOTMUX_FILE_SHARE_TTL_HOURS',
  'BOTMUX_FILE_SHARE_MAX_BYTES',
  'BOTMUX_FILE_SHARE_MD_MAX_BYTES',
  'BOTMUX_FILE_SHARE_RATE_LIMIT',
  'BOTMUX_FILE_SHARE_ROOTS',
  'BOTMUX_FILE_SHARE_ALLOW_PUBLIC',
] as const;

export interface LocalFileShareRecord {
  version: 1;
  token: string;
  realPath: string;
  root: string;
  createdAt: number;
  expiresAt: number;
  size: number;
  mtimeMs: number;
}

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
  shared: Array<{ path: string; url: string }>;
  skipped: Array<{ path: string; reason: string }>;
}

let dotEnvCache: { mtimeMs: number; values: Record<string, string> } | undefined;
function localFileShareSetting(name: typeof FILE_SHARE_ENV_KEYS[number]): string | undefined {
  if (process.env[name] != null) return process.env[name];
  const fp = join(homedir(), '.botmux', '.env');
  try {
    const mtimeMs = statSync(fp).mtimeMs;
    if (!dotEnvCache || dotEnvCache.mtimeMs !== mtimeMs) {
      dotEnvCache = { mtimeMs, values: parseDotenv(readFileSync(fp, 'utf-8')) };
    }
    return dotEnvCache.values[name];
  } catch {
    return undefined;
  }
}

export function localFileSharePolicyEnv(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const key of FILE_SHARE_ENV_KEYS) {
    const value = localFileShareSetting(key);
    if (value != null && value !== '') out[key] = value;
  }
  return out;
}

function envBool(name: 'BOTMUX_FILE_SHARE_ENABLED' | 'BOTMUX_FILE_SHARE_ALLOW_PUBLIC', fallback: boolean): boolean {
  const value = localFileShareSetting(name);
  return value == null || value === '' ? fallback : value.toLowerCase() === 'true';
}

export function localFileShareEnabled(): boolean {
  return envBool('BOTMUX_FILE_SHARE_ENABLED', false);
}

function positiveEnvNumber(name: string, fallback: number): number {
  const n = Number(localFileShareSetting(name as typeof FILE_SHARE_ENV_KEYS[number]));
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function expandHome(input: string): string {
  if (input === '~') return homedir();
  if (input.startsWith(`~${sep}`)) return join(homedir(), input.slice(2));
  return input;
}

function canonicalDir(input: string): string | null {
  try {
    const rp = realpathSync(resolve(expandHome(input)));
    return statSync(rp).isDirectory() ? rp : null;
  } catch {
    return null;
  }
}

function isInside(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel === '' || (!rel.startsWith('..' + sep) && rel !== '..' && !isAbsolute(rel));
}

function sensitiveReason(realPath: string, root: string): string | null {
  const name = basename(realPath).toLowerCase();
  if (SENSITIVE_BASENAMES.has(name) || name.startsWith('.env.')) return 'sensitive_name';
  if (SENSITIVE_EXTENSIONS.has(extname(name))) return 'sensitive_extension';
  // Inspect the full canonical path, not only the root-relative suffix. A
  // session accidentally started *inside* ~/.botmux or ~/.ssh must not turn
  // that sensitive directory itself into an allowed root.
  if (realPath.split(/[\\/]+/).some(part => SENSITIVE_SEGMENTS.has(part.toLowerCase()))) return 'sensitive_directory';
  return null;
}

function shareDir(dataDir: string): string {
  return join(dataDir, 'file-shares');
}

let lastCleanupAt = 0;
function cleanupExpiredRecords(dataDir: string, now: number): void {
  if (now - lastCleanupAt < 60 * 60 * 1000) return;
  lastCleanupAt = now;
  try {
    let inspected = 0;
    for (const name of readdirSync(shareDir(dataDir))) {
      if (inspected++ >= 500 || !/^[A-Za-z0-9_-]{43}\.json$/.test(name)) continue;
      const fp = join(shareDir(dataDir), name);
      try {
        const record = JSON.parse(readFileSync(fp, 'utf-8')) as Partial<LocalFileShareRecord>;
        if (typeof record.expiresAt !== 'number' || record.expiresAt <= now) unlinkSync(fp);
      } catch {
        // Corrupt registry files are not useful capabilities. Removing only a
        // strict token-shaped filename keeps cleanup from touching neighbours.
        try { unlinkSync(fp); } catch { /* best effort */ }
      }
    }
  } catch { /* registry does not exist yet */ }
}

function recordPath(dataDir: string, token: string): string {
  return join(shareDir(dataDir), `${token}.json`);
}

function obscureSlug(token: string, realPath: string): string {
  const ext = extname(realPath).toLowerCase().replace(/[^.a-z0-9]/g, '').slice(0, 12);
  return `v-${token.slice(0, 10)}${ext}`;
}

function shareUrl(baseUrl: string, token: string, realPath: string): string {
  return `${baseUrl.replace(/\/$/, '')}/f/${token}/${encodeURIComponent(obscureSlug(token, realPath))}`;
}

function resolveCandidate(pathText: string): string {
  const trimmed = pathText.startsWith('<') && pathText.endsWith('>')
    ? pathText.slice(1, -1)
    : pathText;
  if (trimmed.startsWith('file://')) {
    try { return decodeURIComponent(new URL(trimmed).pathname); } catch { return trimmed; }
  }
  try { return decodeURIComponent(trimmed); } catch { return trimmed; }
}

function stripSourceLocation(candidate: string): string {
  if (existsSync(candidate)) return candidate;
  const match = candidate.match(/^(.*?):\d+(?::\d+)?$/);
  return match && existsSync(match[1]) ? match[1] : candidate;
}

export function resolveLocalFileShareBaseUrl(): string {
  const explicit = localFileShareSetting('BOTMUX_FILE_SHARE_BASE_URL')?.trim();
  if (explicit) return explicit.replace(/\/$/, '');
  let port: string | number = config.dashboard.port;
  try {
    const persisted = readFileSync(join(homedir(), '.botmux', '.dashboard-port'), 'utf-8').trim();
    if (/^\d+$/.test(persisted)) port = persisted;
  } catch { /* dashboard may not have started yet */ }
  // Deliberately do not use buildDashboardUrl(): when remote platform access
  // is enabled it can return a public machine subdomain. Local files must stay
  // on the direct intranet dashboard endpoint unless the owner explicitly
  // overrides BOTMUX_FILE_SHARE_BASE_URL.
  return `http://${config.dashboard.externalHost}:${port}`;
}

export function configuredFileShareRoots(primaryRoot?: string): string[] {
  const configured = (localFileShareSetting('BOTMUX_FILE_SHARE_ROOTS') ?? '')
    .split(process.platform === 'win32' ? ';' : ':')
    .map(s => s.trim())
    .filter(Boolean);
  return [primaryRoot ?? '', ...configured].filter(Boolean);
}

export function registerLocalFile(filePath: string, opts: RegisterLocalFileOptions): { url: string; record: LocalFileShareRecord } | { reason: string } {
  const now = opts.now ?? Date.now();
  cleanupExpiredRecords(opts.dataDir, now);
  let realPath: string;
  let st;
  try {
    realPath = realpathSync(resolve(expandHome(filePath)));
    st = statSync(realPath);
  } catch {
    return { reason: 'not_found' };
  }
  if (!st.isFile()) return { reason: 'not_a_file' };

  const roots = opts.roots.map(canonicalDir).filter((v): v is string => !!v);
  const root = roots.find(r => isInside(r, realPath));
  if (!root) return { reason: 'outside_allowed_roots' };
  const sensitive = sensitiveReason(realPath, root);
  if (sensitive) return { reason: sensitive };

  const maxBytes = opts.maxBytes ?? positiveEnvNumber('BOTMUX_FILE_SHARE_MAX_BYTES', DEFAULT_MAX_BYTES);
  const mdLimit = positiveEnvNumber('BOTMUX_FILE_SHARE_MD_MAX_BYTES', DEFAULT_MD_MAX_BYTES);
  const extension = extname(realPath).toLowerCase();
  const effectiveMax = extension === '.md' || extension === '.markdown' ? Math.min(maxBytes, mdLimit) : maxBytes;
  if (st.size > effectiveMax) return { reason: 'file_too_large' };

  const token = randomBytes(32).toString('base64url');
  const ttlMs = opts.ttlMs ?? positiveEnvNumber('BOTMUX_FILE_SHARE_TTL_HOURS', DEFAULT_TTL_MS / 3_600_000) * 3_600_000;
  const record: LocalFileShareRecord = {
    version: SHARE_VERSION,
    token,
    realPath,
    root,
    createdAt: now,
    expiresAt: opts.expiresAt ?? now + ttlMs,
    size: st.size,
    mtimeMs: st.mtimeMs,
  };
  const dir = shareDir(opts.dataDir);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  atomicWriteFileSync(recordPath(opts.dataDir, token), JSON.stringify(record), { mode: 0o600 });
  return { url: shareUrl(opts.baseUrl ?? '', token, realPath), record };
}

export function rewriteLocalFileLinks(input: string, opts: RewriteLocalFileLinksOptions): RewriteLocalFileLinksResult {
  const shared: RewriteLocalFileLinksResult['shared'] = [];
  const skipped: RewriteLocalFileLinksResult['skipped'] = [];
  if (!(opts.enabled ?? localFileShareEnabled()) || !input) return { content: input, shared, skipped };

  const content = input.replace(MARKDOWN_LINK_RE, (whole, prefix: string, rawDest: string, suffix: string) => {
    const candidate = stripSourceLocation(resolveCandidate(rawDest));
    const result = registerLocalFile(candidate, opts);
    if ('reason' in result) {
      skipped.push({ path: candidate, reason: result.reason });
      return whole;
    }
    shared.push({ path: result.record.realPath, url: result.url });
    return `${prefix}${result.url}${suffix})`;
  });
  return { content, shared, skipped };
}

function loadRecord(dataDir: string, token: string, now: number): LocalFileShareRecord | null {
  if (!TOKEN_RE.test(token)) return null;
  try {
    const parsed = JSON.parse(readFileSync(recordPath(dataDir, token), 'utf-8')) as LocalFileShareRecord;
    if (parsed.version !== SHARE_VERSION || parsed.token !== token || parsed.expiresAt <= now) return null;
    const root = realpathSync(parsed.root);
    const current = realpathSync(parsed.realPath);
    const st = statSync(current);
    if (!st.isFile() || !isInside(root, current) || sensitiveReason(current, root)) return null;
    return { ...parsed, root, realPath: current, size: st.size, mtimeMs: st.mtimeMs };
  } catch {
    return null;
  }
}

const rateByIp = new Map<string, { start: number; count: number }>();
function rateAllowed(req: IncomingMessage, now: number): boolean {
  const ip = req.socket.remoteAddress ?? 'unknown';
  const limit = positiveEnvNumber('BOTMUX_FILE_SHARE_RATE_LIMIT', DEFAULT_RATE_LIMIT);
  const current = rateByIp.get(ip);
  if (!current || now - current.start >= RATE_WINDOW_MS) {
    if (rateByIp.size > 10_000) {
      for (const [key, value] of rateByIp) {
        if (now - value.start >= RATE_WINDOW_MS) rateByIp.delete(key);
      }
    }
    rateByIp.set(ip, { start: now, count: 1 });
    return true;
  }
  current.count++;
  return current.count <= limit;
}

function securityHeaders(contentType: string): Record<string, string> {
  return {
    'content-type': contentType,
    'cache-control': 'private, no-store, max-age=0',
    'x-content-type-options': 'nosniff',
    'x-frame-options': 'DENY',
    'referrer-policy': 'no-referrer',
    'permissions-policy': 'camera=(), microphone=(), geolocation=(), payment=()',
    'cross-origin-resource-policy': 'same-origin',
  };
}

function genericError(res: ServerResponse, status: number, message: string): void {
  res.writeHead(status, securityHeaders('text/plain; charset=utf-8'));
  res.end(message);
}

function privateAddress(input: string | undefined): boolean {
  if (!input) return false;
  const ip = input.replace(/^::ffff:/, '').replace(/%[^%]+$/, '').toLowerCase();
  if (isIP(ip) === 0) return false;
  if (ip === '::1' || ip === '127.0.0.1') return true;
  if (/^10\./.test(ip) || /^192\.168\./.test(ip) || /^169\.254\./.test(ip)) return true;
  const v4 = ip.match(/^(\d{1,3})\.(\d{1,3})\./);
  if (v4) {
    const a = Number(v4[1]);
    const b = Number(v4[2]);
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 100 && b >= 64 && b <= 127) return true;
  }
  return ip.startsWith('fc') || ip.startsWith('fd') || ip.startsWith('fe80:');
}

function privateHostHeader(hostHeader: string | undefined): boolean {
  if (!hostHeader) return false;
  const raw = hostHeader.trim().toLowerCase();
  if (raw === 'localhost' || raw.startsWith('localhost:')) return true;
  const host = raw.startsWith('[')
    ? raw.slice(1, raw.indexOf(']'))
    : raw.replace(/:\d+$/, '');
  return privateAddress(host);
}

function intranetRequestAllowed(req: IncomingMessage): boolean {
  if (envBool('BOTMUX_FILE_SHARE_ALLOW_PUBLIC', false)) return true;
  // Check the actual socket peer and Host. We intentionally ignore
  // X-Forwarded-For: it is spoofable on a direct listener. Requiring a private
  // Host also prevents the public machine-subdomain reverse proxy (whose peer
  // may be loopback) from becoming an accidental file tunnel.
  return privateAddress(req.socket.remoteAddress) && privateHostHeader(req.headers.host);
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]!));
}

const relativeAssetCache = new Map<string, { url: string; expiresAt: number }>();

function markdownPage(record: LocalFileShareRecord, dataDir: string, now: number): { html: string; scriptNonce: string } {
  const source = readFileSync(record.realPath, 'utf-8');
  // markdown-it gives us a maintained CommonMark-compatible parser instead of
  // a home-grown Markdown grammar. Raw HTML stays escaped because these pages
  // can expose arbitrary workspace reports through a capability URL.
  const md = new MarkdownIt({ html: false, linkify: true, breaks: false, typographer: false });
  let localAssetCount = 0;

  const rewriteRelative = (raw: string): string => {
    if (!raw || raw.startsWith('#') || /^[a-z][a-z0-9+.-]*:/i.test(raw) || raw.startsWith('//')) return raw;
    if (localAssetCount >= MAX_LOCAL_MD_ASSETS) return '#blocked-local-asset-limit';
    let decoded: string;
    try { decoded = decodeURIComponent(raw.split('#')[0].split('?')[0]); } catch { return '#blocked-invalid-path'; }
    const candidate = resolve(dirname(record.realPath), decoded);
    const cacheKey = `${record.token}\0${candidate}`;
    const cached = relativeAssetCache.get(cacheKey);
    if (cached && cached.expiresAt > now) {
      localAssetCount++;
      return cached.url;
    }
    const child = registerLocalFile(candidate, {
      dataDir,
      roots: [dirname(record.realPath)],
      baseUrl: '',
      now,
      expiresAt: record.expiresAt,
    });
    if ('reason' in child) return '#blocked-local-path';
    localAssetCount++;
    relativeAssetCache.set(cacheKey, { url: child.url, expiresAt: record.expiresAt });
    if (relativeAssetCache.size > 2_048) relativeAssetCache.delete(relativeAssetCache.keys().next().value!);
    return child.url;
  };

  const defaultLinkOpen = md.renderer.rules.link_open
    ?? ((tokens: Token[], idx: number, options, _env, self) => self.renderToken(tokens, idx, options));
  md.renderer.rules.link_open = (tokens, idx, options, env, self) => {
    const href = tokens[idx].attrGet('href');
    if (href) tokens[idx].attrSet('href', rewriteRelative(href));
    tokens[idx].attrSet('target', '_blank');
    tokens[idx].attrSet('rel', 'noopener noreferrer');
    return defaultLinkOpen(tokens, idx, options, env, self);
  };
  const defaultImage = md.renderer.rules.image
    ?? ((tokens: Token[], idx: number, options, env, self) => self.renderToken(tokens, idx, options));
  md.renderer.rules.image = (tokens, idx, options, env, self) => {
    const src = tokens[idx].attrGet('src');
    if (src) tokens[idx].attrSet('src', rewriteRelative(src));
    tokens[idx].attrSet('loading', 'lazy');
    return defaultImage(tokens, idx, options, env, self);
  };

  const body = md.render(source);
  const title = escapeHtml(basename(record.realPath));
  const scriptNonce = randomBytes(16).toString('base64url');
  const html = `<!doctype html><html lang="zh-CN" data-theme="light"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title><script nonce="${scriptNonce}">(()=>{try{document.documentElement.dataset.theme=localStorage.getItem('botmux-md-theme')==='dark'?'dark':'light'}catch{document.documentElement.dataset.theme='light'}})();</script><style>
:root{color-scheme:light;--bg:#fff;--fg:#1f2329;--muted:#646a73;--line:#dee0e3;--panel:#f5f6f7;--panel-strong:#eff0f1;--link:#3370ff;--quote:#f2f3f5;--button:#fff;--button-hover:#f5f6f7}:root[data-theme="dark"]{color-scheme:dark;--bg:#1f2023;--fg:#e5e6eb;--muted:#9ca2ad;--line:#41434a;--panel:#292b30;--panel-strong:#32343a;--link:#6b91ff;--quote:#292b30;--button:#292b30;--button-hover:#32343a}*{box-sizing:border-box}html{-webkit-text-size-adjust:100%}body{margin:0;background:var(--bg);color:var(--fg);font:16px/1.75 -apple-system,BlinkMacSystemFont,"Segoe UI","Helvetica Neue","PingFang SC","Microsoft YaHei",Arial,sans-serif;letter-spacing:.01em;transition:background-color .16s ease,color .16s ease}.page{max-width:864px;margin:0 auto;padding:32px 24px 80px}.top{display:flex;align-items:flex-start;gap:16px;border-bottom:1px solid var(--line);margin-bottom:36px;padding:0 0 18px}.top-copy{min-width:0;flex:1}.top h1{font-size:14px;font-weight:600;line-height:1.5;margin:0;word-break:break-all}.top p{color:var(--muted);font-size:12px;margin:5px 0 0}.theme-toggle{flex:none;border:1px solid var(--line);border-radius:7px;background:var(--button);color:var(--fg);cursor:pointer;font:500 13px/1 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;padding:9px 12px}.theme-toggle:hover{background:var(--button-hover)}.theme-toggle:focus-visible{outline:2px solid var(--link);outline-offset:2px}article{overflow-wrap:anywhere}article> :first-child{margin-top:0}article> :last-child{margin-bottom:0}article p{margin:8px 0 16px}article h1,article h2,article h3,article h4,article h5,article h6{color:var(--fg);font-weight:600;line-height:1.4;margin:30px 0 12px}article h1{font-size:28px;margin-top:0}article h2{font-size:24px}article h3{font-size:20px}article h4{font-size:18px}article h5{font-size:16px}article h6{color:var(--muted);font-size:15px}article ul,article ol{margin:8px 0 16px;padding-left:28px}article li{padding-left:2px}article li+li{margin-top:4px}article li>p{margin:4px 0}a{color:var(--link);text-decoration:none}a:hover{text-decoration:underline}strong{font-weight:600}pre{background:var(--panel);border:1px solid var(--line);border-radius:6px;font:14px/1.65 ui-monospace,SFMono-Regular,Menlo,Monaco,Consolas,"Liberation Mono",monospace;margin:16px 0;padding:14px 16px;overflow:auto;tab-size:2}code{background:var(--panel-strong);border-radius:4px;font:85%/1.6 ui-monospace,SFMono-Regular,Menlo,Monaco,Consolas,"Liberation Mono",monospace;padding:2px 5px}pre code{background:none;border-radius:0;font-size:inherit;padding:0}blockquote{background:var(--quote);border-left:3px solid #8f959e;border-radius:0 6px 6px 0;color:var(--muted);margin:16px 0;padding:10px 16px}blockquote>:first-child{margin-top:0}blockquote>:last-child{margin-bottom:0}table{border:1px solid var(--line);border-radius:6px;border-spacing:0;display:block;max-width:100%;overflow:auto;margin:16px 0;width:max-content}th,td{border-bottom:1px solid var(--line);border-right:1px solid var(--line);min-width:88px;padding:8px 12px;text-align:left;vertical-align:top}th:last-child,td:last-child{border-right:0}tr:last-child td{border-bottom:0}th{background:var(--panel);font-weight:600}tbody tr:hover{background:color-mix(in srgb,var(--panel) 60%,transparent)}img{display:block;max-width:100%;height:auto;margin:20px auto;border-radius:6px}hr{border:0;border-top:1px solid var(--line);margin:28px 0}@media(max-width:640px){.page{padding:20px 16px 48px}.top{gap:10px;margin-bottom:28px}article h1{font-size:25px}article h2{font-size:22px}.theme-toggle{padding:8px 10px}}
</style></head><body><main class="page"><header class="top"><div class="top-copy"><h1>${title}</h1><p>botmux 安全文件查看 · 链接到期后自动失效</p></div><button class="theme-toggle" id="theme-toggle" type="button" aria-pressed="false">深色</button></header><article>${body}</article></main><script nonce="${scriptNonce}">(()=>{const root=document.documentElement;const button=document.getElementById('theme-toggle');if(!button)return;const sync=()=>{const dark=root.dataset.theme==='dark';button.textContent=dark?'浅色':'深色';button.setAttribute('aria-pressed',String(dark));button.setAttribute('aria-label',dark?'切换到浅色主题':'切换到深色主题')};button.addEventListener('click',()=>{const next=root.dataset.theme==='dark'?'light':'dark';root.dataset.theme=next;try{localStorage.setItem('botmux-md-theme',next)}catch{}sync()});sync()})();</script></body></html>`;
  return { html, scriptNonce };
}

export function handleLocalFileShareRequest(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  opts: { dataDir: string; now?: number; enabled?: boolean },
): boolean {
  if (!url.pathname.startsWith('/f/')) return false;
  if (!(opts.enabled ?? localFileShareEnabled())) {
    genericError(res, 404, 'Not found');
    return true;
  }
  if (!intranetRequestAllowed(req)) {
    genericError(res, 404, 'Not found');
    return true;
  }
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.setHeader('allow', 'GET, HEAD');
    genericError(res, 405, 'Method not allowed');
    return true;
  }
  const now = opts.now ?? Date.now();
  if (!rateAllowed(req, now)) {
    genericError(res, 429, 'Too many requests');
    return true;
  }
  const match = url.pathname.match(/^\/f\/([^/]+)\/[^/]+$/);
  const record = match ? loadRecord(opts.dataDir, match[1], now) : null;
  if (!record) {
    genericError(res, 404, 'Not found');
    return true;
  }

  const maxBytes = positiveEnvNumber('BOTMUX_FILE_SHARE_MAX_BYTES', DEFAULT_MAX_BYTES);
  const mdLimit = positiveEnvNumber('BOTMUX_FILE_SHARE_MD_MAX_BYTES', DEFAULT_MD_MAX_BYTES);
  const ext = extname(record.realPath).toLowerCase();
  if (record.size > maxBytes || (ext === '.md' && record.size > mdLimit)) {
    genericError(res, 413, 'File too large');
    return true;
  }

  if (ext === '.md' || ext === '.markdown') {
    const { html, scriptNonce } = markdownPage(record, opts.dataDir, now);
    const headers = {
      ...securityHeaders('text/html; charset=utf-8'),
      'content-security-policy': `default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${scriptNonce}'; img-src 'self' data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`,
      'content-length': String(Buffer.byteLength(html)),
    };
    res.writeHead(200, headers);
    if (req.method === 'HEAD') {
      res.end();
      return true;
    }
    res.end(html);
    return true;
  }

  const mime = INLINE_MIME[ext] ?? 'application/octet-stream';
  const inline = ext in INLINE_MIME;
  const headers = {
    ...securityHeaders(mime),
    'content-length': String(record.size),
    'content-disposition': `${inline ? 'inline' : 'attachment'}; filename="${obscureSlug(record.token, record.realPath)}"`,
    'content-security-policy': "default-src 'none'; sandbox; frame-ancestors 'none'",
  };
  res.writeHead(200, headers);
  if (req.method === 'HEAD') {
    res.end();
    return true;
  }
  createReadStream(record.realPath).pipe(res);
  return true;
}

export function __testOnlyResetFileShareRateLimit(): void {
  rateByIp.clear();
  relativeAssetCache.clear();
}
