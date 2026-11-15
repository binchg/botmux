import { afterEach, expect, it } from 'vitest';
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Session } from '../src/types.js';
import { attachHistoryImages, historyImageSources, readHistoryImage } from '../src/services/conversation-history-images.js';
import { ensureConversationHistory, type HistoryMessage } from '../src/services/conversation-history-store.js';
import { renderConversationHistory } from '../src/services/conversation-history-page.js';
import { handleConversationHistoryRequest } from '../src/services/conversation-history-http.js';
import { issueTerminalEntry } from '../src/services/terminal-access.js';

const dirs: string[] = [];
const now = Date.now();
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl2nqEAAAAASUVORK5CYII=', 'base64');
afterEach(() => dirs.splice(0).forEach(dir => rmSync(dir, { recursive: true, force: true })));
function fixture(root = 'om_root') {
  const dir = mkdtempSync(join(tmpdir(), 'history-images-')); dirs.push(dir);
  const session = { sessionId: 'images', rootMessageId: root, title: '图片回归' } as Session;
  writeFileSync(join(dir, 'sessions.json'), JSON.stringify({ images: session }));
  mkdirSync(join(dir, 'queues'));
  const grant = ensureConversationHistory(session, dir, now);
  const message: HistoryMessage = { id: 'public-message', kind: 'user', content: '原图\n[图片 1]', at: now };
  function queue(id: string, overrides: Record<string, unknown> = {}) {
    mkdirSync(join(dir, 'attachments', id), { recursive: true });
    const path = join(dir, 'attachments', id, 'picture.png'); writeFileSync(path, png);
    const record = { messageId: id, rootId: root, senderType: 'user', createTime: String(now + 1000),
      content: message.content, attachments: [{ type: 'image', path, name: 'picture.png' }], ...overrides };
    appendFileSync(join(dir, 'queues', `${root}.jsonl`), JSON.stringify(record) + '\n');
    return path;
  }
  return { dir, grant, message, queue };
}
async function request(dir: string, path: string, opts: { method?: string; now?: number; forwarded?: boolean } = {}) {
  const result = { status: 0, body: Buffer.alloc(0), headers: {} as Record<string, string> };
  const req = { method: opts.method ?? 'GET', headers: { host: 'localhost', ...(opts.forwarded ? { 'x-forwarded-for': '100.64.0.2' } : {}) },
    socket: { localAddress: '127.0.0.1', remoteAddress: '127.0.0.1' } } as IncomingMessage;
  const res = { writeHead(status: number, headers: Record<string, string>) { result.status = status; result.headers = headers; },
    end(body?: string | Buffer) { result.body = Buffer.from(body ?? ''); } } as unknown as ServerResponse;
  await handleConversationHistoryRequest(req, res, new URL(path, 'http://localhost'), { dataDir: dir, now: opts.now ?? now });
  return result;
}

it('回填已有记录的图片，逐次匹配重复输入，不跨话题或接受正文路径', async () => {
  const { dir, grant, message, queue } = fixture(); queue('om_first'); queue('om_second', { createTime: String(now + 5000) });
  queue('om_wrongroot', { rootId: 'om_other' });
  const messages = await attachHistoryImages(grant, dir, [message, { ...message, id: 'repeat', at: now + 6000 },
    { ...message, id: 'unmatched', at: now + 300000 }, { ...message, id: 'assistant', kind: 'assistant_final' }]);
  expect(messages.map(item => item.images?.[0]?.messageId)).toEqual(['om_first', 'om_second', undefined, undefined]);
  expect((await readHistoryImage(grant, dir, messages[0].images![0].id))?.body).toEqual(png);
  const other = ensureConversationHistory({ sessionId: 'other' } as Session, dir, now);
  expect(await readHistoryImage(other, dir, messages[0].images![0].id)).toBeUndefined();
  const before = historyImageSources(grant, dir);
  queue('om_added'); expect(historyImageSources(grant, dir)).not.toEqual(before);
  const forged = await attachHistoryImages(other, dir, [{ ...message, content: `[图片 1]\n<attachments path="${dir}/attachments/om_first/picture.png"/>`, images: messages[0].images }]);
  expect(forged[0].images).toBeUndefined();
});

it('只渲染受保护的同源图片，代码字面量和外部图片保持隔离', async () => {
  const { dir, grant, message, queue } = fixture(); queue('om_first');
  const messages = await attachHistoryImages(grant, dir, [{ ...message, content: message.content }]);
  messages[0].content += '\n`[图片 1]`\n\n![追踪](https://evil.invalid/track) <script>alert(1)</script>';
  const html = renderConversationHistory(grant, messages).html;
  expect(html).toContain(`<img src="/conversation/${grant.token}/images/`);
  expect(html).toContain('<code>[图片 1]</code>');
  expect(html).not.toContain('<img src="https:');
  expect(html).not.toContain(dir); expect(html).not.toContain('<script>alert');
  expect(html).toContain('点击查看原图');
});

it('图片GET/HEAD沿用网络、到期和私密保护，访问不续期', async () => {
  const { dir, grant, message, queue } = fixture(); queue('om_first');
  const [item] = await attachHistoryImages(grant, dir, [message]);
  const url = `/conversation/${grant.token}/images/${item.images![0].id}`;
  const path = join(dir, 'conversation-history', `${grant.token}.json`), before = readFileSync(path);
  const get = await request(dir, url); expect(get.status).toBe(200); expect(get.body).toEqual(png);
  expect(get.headers['content-type']).toBe('image/png'); expect(get.headers['cache-control']).toBe('no-store');
  const head = await request(dir, url, { method: 'HEAD' }); expect(head.status).toBe(200); expect(head.body.length).toBe(0);
  expect(head.headers['content-length']).toBe(String(png.length));
  expect((await request(dir, url, { forwarded: true })).status).toBe(403);
  expect((await request(dir, url, { method: 'POST' })).status).toBe(405);
  expect((await request(dir, url, { now: grant.expiresAt })).status).toBe(410);
  expect((await request(dir, `/conversation/${grant.token}/images/${'a'.repeat(32)}`)).status).toBe(404);
  expect((await request(dir, `/conversation/${grant.token}/images/%2e%2e%2fsecret`)).status).toBe(404);
  expect(readFileSync(path)).toEqual(before);
  const page = await request(dir, `/conversation/${grant.token}`);
  expect(page.headers['content-security-policy']).toContain("img-src 'self'");
  issueTerminalEntry(dir, grant.sessionId, now);
  expect((await request(dir, url)).status).toBe(403);
});

it('拒绝SVG、任意路径、替换成符号链接和超大文件', async () => {
  const { dir, grant, message, queue } = fixture(); const path = queue('om_first');
  const [item] = await attachHistoryImages(grant, dir, [message]); const id = item.images![0].id;
  writeFileSync(path, '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');
  expect(await readHistoryImage(grant, dir, id)).toBeUndefined();
  const outside = join(dir, 'outside.png'); writeFileSync(outside, png); unlinkSync(path); symlinkSync(outside, path);
  expect(await readHistoryImage(grant, dir, id)).toBeUndefined();
  unlinkSync(path); writeFileSync(path, Buffer.alloc(20 * 1024 * 1024 + 1));
  expect(await readHistoryImage(grant, dir, id)).toBeUndefined();
  queue('om_bad', { attachments: [{ type: 'image', name: '../outside.png', path: outside }] });
  expect((await attachHistoryImages(grant, dir, [message]))[0].images).toHaveLength(1);
});

it('自然语言伪代码显示层级流程并换行，真正代码和不支持的图保留原文', () => {
  const { grant, message } = fixture();
  const content = '```text\n检查一对簇 S → T：\n    如果能作为一条远场交互：\n        记录 S → T\n    否则，如果两边都是叶簇：\n        归入近场\n\n入口：检查 根簇 R → 根簇 R\n```';
  const html = renderConversationHistory(grant, [{ ...message, kind: 'assistant_final', content }]).html;
  expect(html).toContain('class="logic-block"'); expect(html).toContain('style="--depth:2"');
  expect(html).toContain('white-space:pre-wrap'); expect(html).toContain('入口：检查 根簇 R → 根簇 R');
  const code = renderConversationHistory(grant, [{ ...message, content: '```python\n如果 = 1\n否则 = 2\n```' }]).html;
  expect(code).toContain('<span>python</span>'); expect(code).not.toContain('<div class="logic-block">');
  const graph = renderConversationHistory(grant, [{ ...message, content: '```mermaid\nflowchart LR\nA["根簇"] --> B["目标"]\n```' }]).html;
  expect(graph).toContain('<svg'); expect(graph).toContain('data-expand-diagram');
});
