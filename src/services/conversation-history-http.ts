/** 一天有效的单会话历史页面；公开路由仅接受随机 token，不接受会话 ID 或文件路径。 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { config } from '../config.js';
import { readConversationHistory } from './conversation-history-store.js';
import { readHistoryBundle } from './conversation-history-reader.js';
import { renderConversationHistory } from './conversation-history-page.js';
import { terminalAccessEnabled } from './terminal-access.js';

const requests = new Map<string, { start: number; count: number }>();

/** 限制同一来源的公开页面读取频率，且不给访问行为续期。 */
function allowedRequest(address: string, now: number): boolean {
  const old = requests.get(address);
  if (old && now - old.start < 60_000) return ++old.count <= 60;
  if (requests.size >= 1_000) requests.delete(requests.keys().next().value!);
  requests.set(address, { start: now, count: 1 });
  return true;
}

/** 先验 token 和过期时间，再读历史；GET、HEAD、非法请求均不会刷新授权。 */
export async function handleConversationHistoryRequest(
  req: IncomingMessage, res: ServerResponse, url: URL,
  opts: { dataDir?: string; now?: number } = {},
): Promise<boolean> {
  if (!url.pathname.startsWith('/conversation/')) return false;
  const now = opts.now ?? Date.now();
  const headers = { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store',
    'referrer-policy': 'no-referrer', 'x-content-type-options': 'nosniff',
    'content-security-policy': "default-src 'none'; frame-ancestors 'none'; base-uri 'none'" };
  const finish = (status: number, body: string, extra: Record<string, string> = {}) => {
    res.writeHead(status, { ...headers, ...extra });
    res.end(req.method === 'HEAD' ? undefined : body);
  };
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    finish(405, 'Method not allowed', { allow: 'GET, HEAD' }); return true;
  }
  if (!allowedRequest(req.socket.remoteAddress ?? 'unknown', now)) {
    finish(429, '请求过于频繁，请稍后重试。', { 'retry-after': '60' }); return true;
  }
  const token = url.pathname.slice('/conversation/'.length);
  const history = readConversationHistory(token, opts.dataDir ?? config.session.dataDir);
  if (!history) { finish(404, '未找到该对话历史链接。'); return true; }
  // 已启用私密终端保护的会话不能通过历史 token 绕过原有密码和本地访问限制。
  if (terminalAccessEnabled(opts.dataDir ?? config.session.dataDir, history.sessionId)) {
    finish(403, '该会话启用了私密访问保护，请使用原受保护入口。'); return true;
  }
  const expiry = { 'x-botmux-history-expires-at': new Date(history.expiresAt).toISOString() };
  if (history.expiresAt <= now) {
    finish(410, '<h1>链接已过期</h1><p>在原会话发送新的追问后，有效期将刷新为一天。</p>', expiry); return true;
  }
  if (req.method === 'HEAD') { finish(200, '', expiry); return true; }
  try {
    const bundle = await readHistoryBundle(history, opts.dataDir ?? config.session.dataDir);
    const page = renderConversationHistory(history, bundle.messages, bundle);
    finish(200, page.html, { ...expiry, 'content-security-policy': `default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${page.nonce}'; base-uri 'none'; frame-ancestors 'none'` });
  } catch { finish(503, '暂时无法读取完整对话历史，请稍后重试。'); }
  return true;
}
