/** 会话卡片的历史链接入口；复用已有分享网关，不把终端写权限带入历史链接。 */
import { ensureConversationHistory } from '../../services/conversation-history-store.js';
import { getSession } from '../../services/session-store.js';
import { resolveLocalFileShareBaseUrl } from '../../services/local-file-share.js';
import type { Locale } from '../../i18n/index.js';
import { logger } from '../../utils/logger.js';
import { terminalAccessEnabled } from '../../services/terminal-access.js';
import { config } from '../../config.js';

/** 只为已登记的实际会话签发入口，刷新卡片不会延长已有链接的有效期。 */
export function conversationHistoryButtons(sessionId: string, locale?: Locale): any[] {
  const session = getSession(sessionId);
  if (!session) return [];
  if (terminalAccessEnabled(config.session.dataDir, sessionId)) return [];
  try {
    const grant = ensureConversationHistory(session);
    const url = `${resolveLocalFileShareBaseUrl()}/conversation/${grant.token}`;
    return [{ tag: 'button', type: 'default',
      text: { tag: 'plain_text', content: locale === 'en' ? '🔗 Conversation history' : '🔗 对话历史' },
      multi_url: { url, pc_url: url, android_url: url, ios_url: url } }];
  } catch {
    logger.warn('Conversation history link could not be prepared');
    return [];
  }
}
