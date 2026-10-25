/** 普通群会话话题中的两个配置按钮；保持原卡正文和原有操作完整。 */
import { getSession } from '../../services/session-store.js';
import { regularGroupSettings, type RegularGroupSettings } from '../../services/regular-group-settings.js';
import type { Session } from '../../types.js';

export const GROUP_SETTING_ACTION = 'regular_group_setting';

/** 从已有会话操作按钮解析身份，不向无会话的通知卡片增加配置入口。 */
export function cardSession(card: any, appId: string): Session | undefined {
  if (!card || typeof card !== 'object') return undefined;
  if (card.tag === 'button' && typeof card.value?.session_id === 'string') {
    const session = getSession(card.value.session_id);
    if (session?.larkAppId === appId && session.chatType === 'group') return session;
  }
  for (const value of Object.values(card)) {
    const session = cardSession(value, appId);
    if (session) return session;
  }
  return undefined;
}

/** 只移除本功能追加的行，避免流卡片反复刷新导致按钮累积。 */
function settingsRow(row: any): boolean {
  const buttons = row?.tag === 'action' ? row.actions
    : row?.tag === 'column_set' ? row.columns?.flatMap((column: any) => column.elements ?? []) : undefined;
  return buttons?.length === 2 && buttons.every((button: any) => button.value?.action === GROUP_SETTING_ACTION);
}

/** 同时支持旧版会话卡和新版正文卡，按钮文字始终表示当前状态。 */
export function withGroupSettings(card: any, session: Session, settings: RegularGroupSettings): any {
  const buttons = (['sync', 'reuse'] as const).map(field => ({
    tag: 'button', type: settings[field] ? 'primary' : 'default',
    text: { tag: 'plain_text', content: `${field === 'sync' ? '同步到群' : '群聊复用'}：${settings[field] ? '开' : '关'}` },
    value: { action: GROUP_SETTING_ACTION, session_id: session.sessionId, field, next_value: !settings[field] },
  }));
  const result = structuredClone(card);
  const container = result.schema === '2.0' ? result.body : result;
  if (!Array.isArray(container?.elements)) return card;
  container.elements = container.elements.filter((row: any) => !settingsRow(row));
  container.elements.push(result.schema === '2.0'
    ? { tag: 'column_set', flex_mode: 'none', columns: buttons.map(button => ({
      tag: 'column', width: 'auto', elements: [button],
    })) }
    : { tag: 'action', actions: buttons });
  return result;
}

/** 发送位置必须由真实请求和平台群类型确认；群外副本、私聊及未知类型保持原样。 */
export async function decorateGroupSettings(content: string, appId: string, method: string, payload: any): Promise<string> {
  if (method === 'create' || (method === 'reply' && payload.data?.reply_in_thread !== true)) return content;
  let card: any;
  try { card = JSON.parse(content); } catch { return content; }
  const session = cardSession(card, appId);
  if (!session || !payload.path?.message_id) return content;
  try {
    const { getMessageDetail, getChatModeStrict } = await import('./client.js');
    const item = (await getMessageDetail(appId, payload.path.message_id)).items
      ?.find((message: any) => message.message_id === payload.path.message_id);
    if (!item || item.chat_id !== session.chatId || item.sync_to_chat_info?.type === 1) return content;
    if (method !== 'reply' && !item.thread_id && !item.root_id) return content;
    if (await getChatModeStrict(appId, session.chatId) !== 'group') return content;
    return JSON.stringify(withGroupSettings(card, session, regularGroupSettings(appId, session.chatId)));
  } catch { return content; }
}
