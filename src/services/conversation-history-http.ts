/** 七天有效的单会话历史页面；公开路由仅接受随机 token，不接受会话 ID 或文件路径。 */
import { historyWindow } from './conversation-history-window.js';
import { historyNetworkAllowed } from './conversation-history-network.js';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { config } from '../config.js';
import { HISTORY_TTL_DAYS, readConversationHistory } from './conversation-history-store.js';
import { cachedHistoryPage } from './conversation-history-page-cache.js';
import { renderConversationHistory } from './conversation-history-page.js';
import { terminalAccessEnabled } from './terminal-access.js';

const requests = new Map<string, { start: number; count: number }>();

/** 限制同一来源的公开页面读取频率，且不给访问行为续期。 */
function allowedRequest(address: string, now: number): boolean {
  const old = requests.get(address);
  if (old && now - old.start < 60_000) return ++old.count <= 180;
  if (requests.size >= 1_000) requests.delete(requests.keys().next().value!);
  requests.set(address, { start: now, count: 1 });
  return true;
}

/** 先验 token 和过期时间，再读历史；GET、HEAD、非法请求均不会刷新授权。 */
export async function handleConversationHistoryRequest(
  req: IncomingMessage, res: ServerResponse, url: URL,
  opts: { dataDir?: string; now?: number } = {},
): Promise<boolean> {
  if (url.pathname !== '/conversation' && !url.pathname.startsWith('/conversation/')) return false;
  const now = opts.now ?? Date.now();
  const headers = { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store',
    'referrer-policy': 'no-referrer', 'x-robots-tag': 'noindex, nofollow, noarchive', 'x-content-type-options': 'nosniff',
    'content-security-policy': "default-src 'none'; frame-ancestors 'none'; base-uri 'none'" };
  const finish = (status: number, body: string, extra: Record<string, string> = {}) => {
    res.writeHead(status, { ...headers, ...extra });
    res.end(req.method === 'HEAD' ? undefined : body);
  };
  if (!historyNetworkAllowed(req)) { finish(403, '仅允许通过 Tailscale 内网直接访问。'); return true; }
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    finish(405, 'Method not allowed', { allow: 'GET, HEAD' }); return true;
  }
  if (url.pathname === '/conversation') {
    finish(200, `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Botmux 对话历史</title><h1>Botmux 对话历史</h1><p>请从飞书会话卡片的「对话历史」按钮打开对应记录。链接有效期为 ${HISTORY_TTL_DAYS} 天，新追问后续期。</p></html>`); return true;
  }
  const token = url.pathname.slice('/conversation/'.length);
  if (!allowedRequest(`${req.socket.remoteAddress ?? 'unknown'}:${token}`, now)) {
    finish(429, '请求过于频繁，请稍后重试。', { 'retry-after': '60' }); return true;
  }
  const history = readConversationHistory(token, opts.dataDir ?? config.session.dataDir);
  if (!history) { finish(404, '未找到该对话历史链接。'); return true; }
  // 已启用私密终端保护的会话不能通过历史 token 绕过原有密码和本地访问限制。
  if (terminalAccessEnabled(opts.dataDir ?? config.session.dataDir, history.sessionId)) {
    finish(403, '该会话启用了私密访问保护，请使用原受保护入口。'); return true;
  }
  const expiry = { 'x-botmux-history-expires-at': new Date(history.expiresAt).toISOString() };
  if (history.expiresAt <= now) {
    finish(410, `<h1>链接已过期</h1><p>在原会话发送新的追问后，有效期将刷新为 ${HISTORY_TTL_DAYS} 天。</p>`, expiry); return true;
  }
  if (req.method === 'HEAD') { finish(200, '', expiry); return true; }
  try {
    const cursors = Object.fromEntries(['before', 'after', 'around'].flatMap(key => url.searchParams.has(key) ? [[key, url.searchParams.get(key)!]] : []));
    if (Object.keys(cursors).length > 1 || Object.values(cursors).some(value => !/^[A-Za-z0-9_-]{22}$/.test(value))) { finish(400, '无效的分页位置。'); return true; }
    const state = cachedHistoryPage(history, opts.dataDir ?? config.session.dataDir);
    if (url.searchParams.has('preload')) { finish(state.error ? 503 : state.page ? 200 : 202, '', expiry); return true; }
    if ((url.searchParams.has('complete') || Object.keys(cursors).length) && !state.page) {
      finish(state.error ? 503 : 202, state.error ? '暂时无法读取完整历史。' : '', { ...expiry, 'retry-after': '1' }); return true;
    }
    let page = state.page;
    if (state.bundle && Object.keys(cursors).length) {
      let window;
      try { window = historyWindow(state.bundle.messages, cursors); }
      catch { finish(409, '记录位置已变化，请重新定位最新记录。', expiry); return true; }
      if (!window.messages.length) { finish(204, '', expiry); return true; }
      page = renderConversationHistory(history, window.messages, state.bundle, false, window);
    }
    if (page && url.searchParams.get('revision') === page.revision) { finish(204, '', expiry); return true; }
    if (!page) { const window = historyWindow(history.messages); page = renderConversationHistory(history, window.messages, undefined, true, window); }
    finish(200, page.html, { ...expiry, 'x-botmux-history-cache': state.page ? 'hit' : 'loading',
      'content-security-policy': `default-src 'none'; connect-src 'self'; style-src 'unsafe-inline'; script-src 'nonce-${page.nonce}'; base-uri 'none'; frame-ancestors 'none'` });
  } catch { finish(503, '暂时无法读取完整对话历史，请稍后重试。'); }
  return true;
}
