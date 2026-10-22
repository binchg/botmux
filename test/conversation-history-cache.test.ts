/** 合成大日志验证首屏、增量复用、来源失效以及授权检查，避免使用真实会话内容。 */
import { afterEach, expect, it, vi } from 'vitest';
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Session } from '../src/types.js';
import { readCachedHistoryTranscript } from '../src/services/conversation-history-transcript-cache.js';
import { parseHistoryRecord } from '../src/services/conversation-history-reader.js';
import * as reader from '../src/services/conversation-history-reader.js';
import * as resolver from '../src/services/transcript-resolver.js';
import { cachedHistoryPage } from '../src/services/conversation-history-page-cache.js';
import { handleConversationHistoryRequest } from '../src/services/conversation-history-http.js';
import { ensureConversationHistory, HISTORY_TTL_MS, recordConversationHistory } from '../src/services/conversation-history-store.js';
import { issueTerminalEntry } from '../src/services/terminal-access.js';

const dirs: string[] = [];
/** 隔离每条用例的文件和缓存键。 */
function storage() {
  const dir = mkdtempSync(join(tmpdir(), 'history-cache-')); dirs.push(dir); return dir;
}
/** 生成与 rollout 一致的记录头，正文只用合成数据。 */
function row(text: string, type = 'message') {
  return JSON.stringify({ timestamp: '2026-10-22T00:00:00Z', ordinal: 1, type: 'response_item',
    payload: { type, role: 'user', content: text } }) + '\n';
}
/** 通过真实路由检查状态及首屏，不启动监听端口。 */
async function request(dir: string, token: string, now = Date.now(), query = '') {
  const result = { status: 0, body: '', headers: {} as Record<string, string> };
  const req = { method: 'GET', socket: { remoteAddress: dir } } as IncomingMessage;
  const res = { writeHead(status: number, headers: Record<string, string>) { result.status = status; result.headers = headers; },
    end(body: string) { result.body = body; } } as unknown as ServerResponse;
  await handleConversationHistoryRequest(req, res, new URL(`http://localhost/conversation/${token}${query}`), { dataDir: dir, now });
  return result;
}
afterEach(() => { vi.restoreAllMocks(); dirs.splice(0).forEach(dir => rmSync(dir, { recursive: true, force: true })); });

it('跳过超过旧上限的工具行，热读不重解析，追加只处理新完整行', async () => {
  const file = join(storage(), 'source.jsonl');
  const padding = 256 * 1024 - row('首问').length - row('', 'function_call_output').length - 20;
  writeFileSync(file, row('首问') + row('x'.repeat(padding), 'function_call_output')
    + row('x'.repeat(9 * 1024 * 1024), 'custom_tool_call_output') + row('末问'));
  const parse = vi.fn(parseHistoryRecord);
  expect((await readCachedHistoryTranscript(file, 'codex', parse)).map(item => item.content)).toEqual(['首问', '末问']);
  const calls = parse.mock.calls.length;
  await readCachedHistoryTranscript(file, 'codex', parse);
  expect(parse).toHaveBeenCalledTimes(calls);
  const next = row('增量中文');
  appendFileSync(file, next.slice(0, -1));
  expect(await readCachedHistoryTranscript(file, 'codex', parse)).toHaveLength(2);
  appendFileSync(file, '\n');
  expect((await readCachedHistoryTranscript(file, 'codex', parse)).at(-1)?.content).toBe('增量中文');
  expect(parse).toHaveBeenCalledTimes(calls + 1);
  writeFileSync(file, row('替换内容'));
  expect((await readCachedHistoryTranscript(file, 'codex', parse)).map(item => item.content)).toEqual(['替换内容']);
});

it('首屏与预加载共用一次后台读取，命中缓存仍检查过期及私密保护', async () => {
  const dir = storage(); const now = Date.now();
  const session = { sessionId: 'cache-session', title: '合成标题' } as Session;
  recordConversationHistory(session, { kind: 'user', content: '首屏可见', at: now }, dir);
  const grant = ensureConversationHistory(session, dir, now);
  vi.spyOn(resolver, 'resolveSessionTranscriptPath').mockReturnValue(null);
  let release!: () => void;
  const barrier = new Promise<void>(resolve => { release = resolve; });
  const original = reader.readHistoryBundle;
  const read = vi.spyOn(reader, 'readHistoryBundle').mockImplementation(async (...args) => {
    await barrier; return original(...args);
  });
  const cold = await request(dir, grant.token, now);
  expect(cold.body).toContain('首屏可见'); expect(cold.body).toContain('history-loading');
  expect((await request(dir, grant.token, now, '?preload=1')).status).toBe(202);
  expect((await request(dir, grant.token, now, '?complete=1')).status).toBe(202);
  release();
  await vi.waitFor(() => expect(cachedHistoryPage(grant, dir).page).toBeDefined());
  expect(read).toHaveBeenCalledTimes(1);
  expect((await request(dir, grant.token, now)).headers['x-botmux-history-cache']).toBe('hit');
  expect((await request(dir, grant.token, now + HISTORY_TTL_MS)).status).toBe(410);
  issueTerminalEntry(dir, session.sessionId, now);
  expect((await request(dir, grant.token, now)).status).toBe(403);
});

it('来源追加时不复用旧页面', async () => {
  const dir = storage(); const file = join(dir, 'source.jsonl');
  const session = { sessionId: 'source-session', title: '合成标题' } as Session;
  const grant = ensureConversationHistory(session, dir);
  writeFileSync(file, row('旧正文'));
  vi.spyOn(resolver, 'resolveSessionTranscriptPath').mockReturnValue({ path: file, kind: 'codex' });
  const first = cachedHistoryPage(grant, dir);
  await vi.waitFor(() => expect(first.page).toBeDefined());
  appendFileSync(file, row('新增正文'));
  const second = cachedHistoryPage(grant, dir);
  expect(second).not.toBe(first);
  await vi.waitFor(() => expect(second.page?.html).toContain('新增正文'));
});

it('后台读取失败立即反馈并短暂退避，避免浏览器反复扫描损坏文件', async () => {
  const dir = storage();
  const grant = ensureConversationHistory({ sessionId: 'failed-session', title: '合成标题' } as Session, dir);
  vi.spyOn(resolver, 'resolveSessionTranscriptPath').mockReturnValue(null);
  const read = vi.spyOn(reader, 'readHistoryBundle').mockRejectedValue(new Error('synthetic_read_failure'));
  const state = cachedHistoryPage(grant, dir);
  await vi.waitFor(() => expect(state.error).toBe(true));
  expect((await request(dir, grant.token, Date.now(), '?complete=1')).status).toBe(503);
  expect(cachedHistoryPage(grant, dir)).toBe(state);
  expect(read).toHaveBeenCalledTimes(1);
});
