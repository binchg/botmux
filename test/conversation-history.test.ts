/** 验证历史链接的续期、隔离、正文边界与过期路由，不使用真实会话内容。 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Session } from '../src/types.js';
import { ensureConversationHistory, HISTORY_TTL_MS, readConversationHistory,
  recordConversationHistory, visibleHistoryText } from '../src/services/conversation-history-store.js';
import { parseHistoryRecord } from '../src/services/conversation-history-reader.js';
import { renderConversationHistory } from '../src/services/conversation-history-page.js';
import { handleConversationHistoryRequest } from '../src/services/conversation-history-http.js';
import * as sessionStore from '../src/services/session-store.js';
import { buildSessionCard, buildStreamingCard } from '../src/im/lark/card-builder.js';
import { issueTerminalEntry } from '../src/services/terminal-access.js';

const directories: string[] = [];
const now = Date.parse('2026-10-16T09:00:00Z');
const session: Session = { sessionId: 'test-history-session', chatId: 'chat', rootMessageId: 'root',
  title: '测试对话', status: 'active', createdAt: new Date(now).toISOString() };

/** 为每个测试建立独立临时存储，退出后仅删除本测试创建的目录。 */
function storage(): string {
  const dir = mkdtempSync(join(tmpdir(), 'botmux-history-test-'));
  directories.push(dir);
  return dir;
}

/** 使用最小 HTTP 对象验证状态码、正文和响应头。 */
async function request(dataDir: string, path: string, at: number, method = 'GET') {
  const result = { status: 0, body: '', headers: {} as Record<string, string> };
  const req = { method, socket: { remoteAddress: '127.0.0.1' } } as IncomingMessage;
  const res = { writeHead(status: number, headers: Record<string, string>) {
    result.status = status; result.headers = headers;
  }, end(body?: string) { result.body = body ?? ''; } } as unknown as ServerResponse;
  const handled = await handleConversationHistoryRequest(req, res, new URL(path, 'http://localhost'), { dataDir, now: at });
  return { ...result, handled };
}

afterEach(() => {
  vi.restoreAllMocks(); vi.unstubAllEnvs();
  for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('conversation history', () => {
  it('启用已有私密保护后拒绝旧历史链接，不能绕过密码与本地访问边界', async () => {
    const dir = storage();
    const grant = ensureConversationHistory(session, dir, now);
    issueTerminalEntry(dir, session.sessionId, now);
    expect((await request(dir, `/conversation/${grant.token}`, now)).status).toBe(403);
    expect(() => ensureConversationHistory(session, dir, now)).toThrow('protected_session');
    recordConversationHistory(session, { kind: 'user', content: 'private', at: now }, dir);
    expect(readConversationHistory(grant.token, dir)!.messages).toEqual([]);
  });

  it('新会话卡和追问流式卡都给出同一直接跳转链接，重绘不续期', () => {
    const dir = storage();
    vi.stubEnv('SESSION_DATA_DIR', dir);
    vi.stubEnv('BOTMUX_FILE_SHARE_BASE_URL', 'https://files-only.invalid');
    vi.spyOn(sessionStore, 'getSession').mockReturnValue(session);
    const a = JSON.parse(buildSessionCard(session.sessionId, 'root', 'http://localhost/terminal', '测试'));
    const expiry = ensureConversationHistory(session, dir).expiresAt;
    const b = JSON.parse(buildStreamingCard(session.sessionId, 'root', 'http://localhost/terminal', '测试', '', 'working'));
    const findButton = (card: unknown): any => {
      if (!card || typeof card !== 'object') return;
      if ((card as any).text?.content === '🔗 对话历史') return card;
      return Object.values(card).map(findButton).find(Boolean);
    };
    const first = findButton(a);
    expect(first.multi_url.url).toMatch(/\/conversation\/[A-Za-z0-9_-]{43}$/);
    expect(first.multi_url.url).not.toContain('files-only.invalid');
    expect(first.value).toBeUndefined();
    expect(findButton(b).multi_url.url).toBe(first.multi_url.url);
    expect(ensureConversationHistory(session, dir).expiresAt).toBe(expiry);
  });

  it('首次一天，只有新输入续期，重复事件及卡片渲染不续期', () => {
    const dir = storage();
    const first = ensureConversationHistory(session, dir, now);
    expect(first.expiresAt).toBe(now + HISTORY_TTL_MS);
    recordConversationHistory(session, { kind: 'user', content: '继续', id: 'u1', at: now + 3600_000 }, dir);
    const expiry = now + 3600_000 + HISTORY_TTL_MS;
    recordConversationHistory(session, { kind: 'assistant_final', content: '结果', id: 'a1', at: now + 7200_000 }, dir);
    recordConversationHistory(session, { kind: 'assistant_progress', content: '内部进展', at: now + 7200_000 }, dir);
    recordConversationHistory(session, { kind: 'user', content: '继续', id: 'u1', at: now + 7200_000 }, dir);
    const current = ensureConversationHistory(session, dir, now + 10_800_000);
    expect(current.token).toBe(first.token);
    expect(current.expiresAt).toBe(expiry);
    expect(current.messages.map(item => item.kind)).toEqual(['user', 'assistant_final']);
  });

  it('过期返回410，新追问恢复同一链接，HEAD与GET都不续期', async () => {
    const dir = storage();
    const grant = ensureConversationHistory(session, dir, now);
    const path = `/conversation/${grant.token}`;
    expect((await request(dir, path, now + HISTORY_TTL_MS)).status).toBe(410);
    recordConversationHistory(session, { kind: 'user', content: '新的追问', id: 'u2', at: now + HISTORY_TTL_MS + 1 }, dir);
    const expiry = readConversationHistory(grant.token, dir)!.expiresAt;
    const get = await request(dir, path, now + HISTORY_TTL_MS + 2);
    expect(get.status).toBe(200);
    expect(get.body).toContain('新的追问');
    expect(get.headers['cache-control']).toBe('no-store');
    expect((await request(dir, path, now + HISTORY_TTL_MS + 3, 'HEAD')).body).toBe('');
    expect(readConversationHistory(grant.token, dir)!.expiresAt).toBe(expiry);
  });

  it('会话ID和路径无法读正文，另一个会话使用独立随机链接', async () => {
    const dir = storage();
    const a = ensureConversationHistory(session, dir, now);
    const b = ensureConversationHistory({ ...session, sessionId: 'second-session' }, dir, now);
    expect(a.token).not.toBe(b.token);
    expect((await request(dir, `/conversation/${session.sessionId}`, now)).status).toBe(404);
    expect(readConversationHistory('../secret', dir)).toBeUndefined();
    expect((await request(dir, `/conversation/${a.token}`, now, 'POST')).status).toBe(405);
  });

  it('排除启动规则、工具、推理与中途消息，只提取真实用户信封及最终答复', () => {
    const base = { type: 'response_item', timestamp: new Date(now).toISOString() };
    const record = (payload: unknown) => ({ ...base, payload });
    expect(parseHistoryRecord(record({ type: 'function_call_output', output: 'SECRET' }), 'codex')).toBeUndefined();
    expect(parseHistoryRecord(record({ type: 'message', role: 'developer', content: 'SECRET' }), 'codex')).toBeUndefined();
    expect(parseHistoryRecord(record({ type: 'message', role: 'assistant', phase: 'commentary', content: '进展' }), 'codex')).toBeUndefined();
    expect(visibleHistoryText('# AGENTS.md instructions for /private', 'user')).toBe('');
    const user = parseHistoryRecord(record({ type: 'message', role: 'user', content: [
      { type: 'input_text', text: '<botmux_reminder>内部</botmux_reminder><user_message>继续测试</user_message><sender id="private" />' },
    ] }), 'codex');
    expect(user?.content).toBe('继续测试');
  });

  it('保存超过仪表盘预览上限的正文，保持旧蓝绿样式并转义可执行内容', () => {
    const dir = storage();
    const content = '正文'.repeat(3000) + '<script>alert(1)</script> ![追踪](https://example.com/track)';
    recordConversationHistory(session, { kind: 'user', content, at: now }, dir);
    const history = ensureConversationHistory(session, dir, now);
    expect(history.messages[0].content.length).toBe(content.length);
    const page = renderConversationHistory(history, history.messages);
    expect(page.html).toContain('--blue-bg:#eaf1ff');
    expect(page.html).toContain('--green-bg:#eef8f2');
    expect(page.html).not.toContain('<script>alert(1)</script>');
    expect(page.html).not.toContain('<img');
    expect(page.html).toContain('有效期至');
  });
});
