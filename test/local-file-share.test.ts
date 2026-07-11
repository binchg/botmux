import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createServer, request, type Server } from 'node:http';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  __testOnlyResetFileShareRateLimit,
  handleLocalFileShareRequest,
  registerLocalFile,
  rewriteLocalFileLinks,
} from '../src/services/local-file-share.js';

describe('secure local file share', () => {
  let root: string;
  let dataDir: string;
  let server: Server | undefined;
  let now = Date.now();

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'botmux-file-share-'));
    dataDir = join(root, 'data');
    mkdirSync(dataDir);
    now = Date.now();
    __testOnlyResetFileShareRateLimit();
  });

  afterEach(async () => {
    if (server) await new Promise<void>(resolve => server!.close(() => resolve()));
    server = undefined;
    rmSync(root, { recursive: true, force: true });
  });

  async function listen(): Promise<string> {
    server = createServer((req, res) => {
      const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
      if (!handleLocalFileShareRequest(req, res, url, { dataDir, now, enabled: true })) {
        res.writeHead(404).end();
      }
    });
    await new Promise<void>(resolve => server!.listen(0, '127.0.0.1', () => resolve()));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('missing address');
    return `http://127.0.0.1:${address.port}`;
  }

  async function statusWithHost(target: URL, host: string): Promise<number> {
    return await new Promise<number>((resolve, reject) => {
      const req = request({
        hostname: target.hostname,
        port: target.port,
        path: target.pathname,
        method: 'GET',
        headers: { host },
      }, res => {
        res.resume();
        res.on('end', () => resolve(res.statusCode ?? 0));
      });
      req.on('error', reject);
      req.end();
    });
  }

  it('rewrites only explicit markdown links under an allowed root', () => {
    const report = join(root, 'report.md');
    const outsideDir = mkdtempSync(join(tmpdir(), 'botmux-file-share-outside-'));
    const outside = join(outsideDir, 'outside.md');
    writeFileSync(report, '# Report');
    writeFileSync(outside, '# Outside');
    try {
      const result = rewriteLocalFileLinks(
        `[报告](${report}:12) [越界](${outside}) \`${outside}\``,
        { dataDir, roots: [root], baseUrl: 'http://10.0.0.1:8802', enabled: true, now },
      );
      expect(result.shared).toHaveLength(1);
      expect(result.skipped).toEqual([{ path: outside, reason: 'outside_allowed_roots' }]);
      expect(result.content).toMatch(/\[报告\]\(http:\/\/10\.0\.0\.1:8802\/f\/[A-Za-z0-9_-]{43}\/v-[^)]+\.md\)/);
      expect(result.content).toContain(`[越界](${outside})`);
      expect(result.content).toContain(`\`${outside}\``);
      expect(result.content).not.toContain('report.md:12');
      expect(result.shared[0].url).not.toContain(encodeURIComponent(root));
      expect(result.shared[0].url).not.toContain('report');
    } finally {
      rmSync(outsideDir, { recursive: true, force: true });
    }
  });

  it('rejects secret-looking files, directories, and oversized files', () => {
    const envFile = join(root, '.env');
    const dir = join(root, 'folder');
    const large = join(root, 'large.bin');
    writeFileSync(envFile, 'TOKEN=secret');
    mkdirSync(dir);
    writeFileSync(large, Buffer.alloc(32));
    expect(registerLocalFile(envFile, { dataDir, roots: [root] })).toEqual({ reason: 'sensitive_name' });
    expect(registerLocalFile(dir, { dataDir, roots: [root] })).toEqual({ reason: 'not_a_file' });
    expect(registerLocalFile(large, { dataDir, roots: [root], maxBytes: 8 })).toEqual({ reason: 'file_too_large' });
  });

  it('renders markdown tables and same-directory images with a strict browser policy', async () => {
    const base = await listen();
    const image = join(root, 'chart.png');
    const report = join(root, 'report.md');
    writeFileSync(image, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    writeFileSync(report, [
      '# 安全报告',
      '',
      '| 项目 | 结果 |',
      '|---|---|',
      '| 表格 | 通过 |',
      '',
      '![趋势图](chart.png)',
      '',
      '<script>globalThis.pwned=true</script>',
    ].join('\n'));
    const registered = registerLocalFile(report, { dataDir, roots: [root], baseUrl: base, now });
    if ('reason' in registered) throw new Error(registered.reason);

    const response = await fetch(registered.url);
    const html = await response.text();
    expect(response.status).toBe(200);
    expect(response.headers.get('content-security-policy')).toContain("default-src 'none'");
    const scriptNonce = response.headers.get('content-security-policy')?.match(/script-src 'nonce-([^']+)'/)?.[1];
    expect(scriptNonce).toBeTruthy();
    expect(html).toContain(`<html lang="zh-CN" data-theme="light">`);
    expect(html).toContain(`id="theme-toggle"`);
    expect(html).toContain(`localStorage.getItem('botmux-md-theme')`);
    expect(html).toContain(`localStorage.setItem('botmux-md-theme',next)`);
    expect(html).toContain(`:root[data-theme="dark"]`);
    expect(html).not.toContain('prefers-color-scheme:dark');
    expect(html).toContain('max-width:864px');
    expect(html).toContain('font:16px/1.75');
    expect(html).toContain('article h1{font-size:28px');
    expect(html).toContain('color:var(--link)');
    expect(html.match(new RegExp(`<script nonce="${scriptNonce}"`, 'g'))).toHaveLength(2);
    expect(response.headers.get('x-content-type-options')).toBe('nosniff');
    expect(response.headers.get('x-frame-options')).toBe('DENY');
    expect(html).toContain('<table>');
    expect(html).toContain('表格');
    expect(html).toContain('&lt;script&gt;globalThis.pwned=true&lt;/script&gt;');
    expect(html).not.toContain('<script>globalThis.pwned=true</script>');
    const imagePath = html.match(/<img src="(\/f\/[^"]+)"/)?.[1];
    expect(imagePath).toBeTruthy();
    const imageResponse = await fetch(new URL(imagePath!, base));
    expect(imageResponse.status).toBe(200);
    expect(imageResponse.headers.get('content-type')).toBe('image/png');
  });

  it('supports HEAD and refuses unknown tokens, traversal, and non-read methods', async () => {
    const base = await listen();
    const file = join(root, 'report.md');
    writeFileSync(file, '# ok');
    const registered = registerLocalFile(file, { dataDir, roots: [root], baseUrl: base, now });
    if ('reason' in registered) throw new Error(registered.reason);

    const head = await fetch(registered.url, { method: 'HEAD' });
    expect(head.status).toBe(200);
    expect(await head.text()).toBe('');
    expect((await fetch(`${base}/f/${'a'.repeat(43)}/v-dead.md`)).status).toBe(404);
    expect((await fetch(`${base}/f/../../../etc/passwd`)).status).toBe(404);
    expect((await fetch(registered.url, { method: 'POST' })).status).toBe(405);
    expect(await statusWithHost(new URL(registered.url), 'public.example.com')).toBe(404);
    expect(await statusWithHost(new URL(registered.url), '10.evil.example.com')).toBe(404);
  });

  it('expires capability links and detects a symlink swap after registration', async () => {
    const base = await listen();
    const outsideDir = mkdtempSync(join(tmpdir(), 'botmux-file-share-swap-'));
    const outside = join(outsideDir, 'secret.txt');
    const file = join(root, 'safe.txt');
    writeFileSync(outside, 'secret');
    writeFileSync(file, 'safe');
    try {
      const short = registerLocalFile(file, { dataDir, roots: [root], baseUrl: base, now, ttlMs: 10 });
      if ('reason' in short) throw new Error(short.reason);
      now += 11;
      expect((await fetch(short.url)).status).toBe(404);

      now += 1;
      writeFileSync(file, 'safe-again');
      const swapped = registerLocalFile(file, { dataDir, roots: [root], baseUrl: base, now });
      if ('reason' in swapped) throw new Error(swapped.reason);
      unlinkSync(file);
      symlinkSync(outside, file);
      expect((await fetch(swapped.url)).status).toBe(404);
    } finally {
      rmSync(outsideDir, { recursive: true, force: true });
    }
  });

  it('persists only opaque token filenames with private permissions', () => {
    const file = join(root, 'notes.txt');
    writeFileSync(file, 'hello');
    const registered = registerLocalFile(file, { dataDir, roots: [root], baseUrl: 'http://host:8802', now });
    if ('reason' in registered) throw new Error(registered.reason);
    const fp = join(dataDir, 'file-shares', `${registered.record.token}.json`);
    expect(readFileSync(fp, 'utf-8')).toContain(file);
    expect(registered.url).not.toContain('notes');
  });
});
