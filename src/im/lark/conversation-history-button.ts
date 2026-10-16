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

/** 文件分享网关可能只代理 /f/，因此历史页必须使用实际面板端口或平台入口。 */
function historyOrigin(): string {
  let port: string | number = config.dashboard.port;
  try {
    const actual = readFileSync(join(homedir(), '.botmux', '.dashboard-port'), 'utf8').trim();
    if (/^\d+$/.test(actual) && Number(actual) > 0 && Number(actual) <= 65535) port = actual;
  } catch {}
  return buildDashboardUrl({ host: config.dashboard.externalHost, port });
}

/** 只为已登记的实际会话签发入口，刷新卡片不会延长已有链接的有效期。 */
export function conversationHistoryButtons(sessionId: string, locale?: Locale): any[] {
  const session = getSession(sessionId);
  if (!session) return [];
  if (terminalAccessEnabled(config.session.dataDir, sessionId)) return [];
  try {
    const grant = ensureConversationHistory(session);
    const url = new URL(`conversation/${grant.token}`, historyOrigin()).toString();
    return [{ tag: 'button', type: 'default',
      text: { tag: 'plain_text', content: locale === 'en' ? '🔗 Conversation history' : '🔗 对话历史' },
      multi_url: { url, pc_url: url, android_url: url, ios_url: url } }];
  } catch {
    logger.warn('Conversation history link could not be prepared');
    return [];
  }
}
