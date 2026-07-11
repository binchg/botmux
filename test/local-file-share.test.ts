import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  __testOnlyResetFileShareRateLimit,
  handleLocalFileShareRequest,
  rewriteLocalFileLinks,
} from '../src/services/local-file-share.js';

describe('external secure file share adapter', () => {
  let root: string;
  const servers: Server[] = [];

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'botmux-file-share-adapter-'));
    process.env.BOTMUX_FILE_SHARE_ENABLED = 'true';
    delete process.env.BOTMUX_FILE_SHARE_CLI;
    delete process.env.BOTMUX_FILE_SHARE_UPSTREAM_URL;
    __testOnlyResetFileShareRateLimit();
  });

  afterEach(async () => {
    await Promise.all(servers.splice(0).map(server => new Promise<void>(resolve => server.close(() => resolve()))));
    delete process.env.BOTMUX_FILE_SHARE_ENABLED;
    delete process.env.BOTMUX_FILE_SHARE_CLI;
    delete process.env.BOTMUX_FILE_SHARE_UPSTREAM_URL;
    rmSync(root, { recursive: true, force: true });
  });

  async function listen(server: Server): Promise<string> {
    servers.push(server);
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('missing address');
    return `http://127.0.0.1:${address.port}`;
  }

  it('delegates Markdown link rewriting to the packaged CLI', () => {
    const fake = join(root, 'secure-local-file-share');
    writeFileSync(fake, `#!/usr/bin/env node
let input='';process.stdin.on('data',c=>input+=c);process.stdin.on('end',()=>{
 const body=JSON.parse(input);process.stdout.write(JSON.stringify({content:body.content.replace('/tmp/report.md','https://devbox/f/token'),shared:[{path:'/tmp/report.md',url:'https://devbox/f/token'}],skipped:[]}));
});
`);
    chmodSync(fake, 0o755);
    process.env.BOTMUX_FILE_SHARE_CLI = fake;
    const result = rewriteLocalFileLinks('[文档标题](/tmp/report.md)', {
      dataDir: join(root, 'data'),
      roots: ['/tmp'],
      baseUrl: 'https://devbox',
      enabled: true,
    });
    expect(result.content).toBe('[文档标题](https://devbox/f/token)');
    expect(result.shared).toHaveLength(1);
  });

  it('does not fall back to an in-process implementation when the CLI is missing', () => {
    process.env.BOTMUX_FILE_SHARE_CLI = join(root, 'missing');
    const result = rewriteLocalFileLinks('[报告](/tmp/report.md)', {
      dataDir: join(root, 'data'), roots: ['/tmp'], enabled: true,
    });
    expect(result.content).toBe('[报告](/tmp/report.md)');
    expect(result.skipped[0].reason).toBe('file_share_cli_unavailable');
  });

  it('proxies legacy dashboard /f links to the standalone loopback service', async () => {
    const upstream = await listen(createServer((req, res) => {
      if (req.url?.includes('/expired')) {
        res.writeHead(410, { 'content-type': 'text/html' }).end('<h1>链接已过期</h1>');
      } else {
        res.writeHead(200, { 'content-type': 'text/html' }).end('<h1>独立服务</h1>');
      }
    }));
    process.env.BOTMUX_FILE_SHARE_UPSTREAM_URL = upstream;
    const dashboard = await listen(createServer((req, res) => {
      const url = new URL(req.url ?? '/', `http://${req.headers.host}`);
      if (!handleLocalFileShareRequest(req, res, url, { dataDir: join(root, 'data'), enabled: true })) res.writeHead(404).end();
    }));
    const ok = await fetch(`${dashboard}/f/token`);
    expect(ok.status).toBe(200);
    expect(await ok.text()).toContain('独立服务');
    const legacy = await fetch(`${dashboard}/f/token/v-token.md`);
    expect(legacy.status).toBe(200);
    expect(await legacy.text()).toContain('独立服务');
    const expired = await fetch(`${dashboard}/f/expired`);
    expect(expired.status).toBe(410);
    expect(await expired.text()).toContain('链接已过期');
  });
});
