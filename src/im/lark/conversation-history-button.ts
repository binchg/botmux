/** 会话卡片的历史链接入口；使用实际面板地址，不携带面板或终端写权限。 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { ensureConversationHistory } from '../../services/conversation-history-store.js';
import { getSession } from '../../services/session-store.js';
import { buildDashboardUrl } from '../../core/dashboard-url.js';
import type { Locale } from '../../i18n/index.js';
import { logger } from '../../utils/logger.js';
import { terminalAccessEnabled } from '../../services/terminal-access.js';
import { config } from '../../config.js';
import { preloadConversationHistory } from '../../services/conversation-history-preload.js';

/** 实际面板端口只用于回环预加载和未配置域名时的兼容入口。 */
function dashboardPort(): string | number {
  let port: string | number = config.dashboard.port;
  try {
    const actual = readFileSync(join(homedir(), '.botmux', '.dashboard-port'), 'utf8').trim();
    if (/^\d+$/.test(actual) && Number(actual) > 0 && Number(actual) <= 65535) port = actual;
  } catch {}
  return port;
}

/** 优先使用专用历史页域名，避免误用只代理 /f/ 的文件网关。 */
function historyOrigin(): string {
  const base = process.env.BOTMUX_HISTORY_BASE_URL?.trim();
  if (base) {
    const url = new URL(base);
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
      throw new Error('invalid_history_base_url');
    }
    if (!url.pathname.endsWith('/')) url.pathname += '/';
    return url.toString();
  }
  return buildDashboardUrl({ host: config.dashboard.externalHost, port: dashboardPort() });
}

/** 只为已登记的实际会话签发入口，刷新卡片不会延长已有链接的有效期。 */
export function conversationHistoryButtons(sessionId: string, locale?: Locale): any[] {
  const session = getSession(sessionId);
  if (!session) return [];
  if (terminalAccessEnabled(config.session.dataDir, sessionId)) return [];
  try {
    const grant = ensureConversationHistory(session);
    const url = new URL(`conversation/${grant.token}`, historyOrigin()).toString();
    if (grant.expiresAt > Date.now()) preloadConversationHistory(grant.token, dashboardPort());
    return [{ tag: 'button', type: 'default',
      text: { tag: 'plain_text', content: locale === 'en' ? '🔗 Conversation history' : '🔗 对话历史' },
      multi_url: { url, pc_url: url, android_url: url, ios_url: url } }];
  } catch {
    logger.warn('Conversation history link could not be prepared');
    return [];
  }
}
