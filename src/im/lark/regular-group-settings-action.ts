/** 群设置按钮回调：核对操作者和原卡位置，持久化后原地回传最新卡片。 */
import type { CardActionData } from './card-handler.js';
import { canOperate } from './event-dispatcher.js';
import { getChatModeStrict, getMessageDetail } from './client.js';
import { cardSession, GROUP_SETTING_ACTION, withGroupSettings } from './regular-group-settings-card.js';
import { regularGroupSettings, setRegularGroupSetting } from '../../services/regular-group-settings.js';
import { readGroupCardSnapshot, saveGroupCardSnapshot } from '../../services/regular-group-card-snapshots.js';

/** 原卡必须仍包含该会话的设置入口，不能靠回调自报身份改其它群配置。 */
function hasSetting(card: any, sessionId: string, field: string): boolean {
  if (!card || typeof card !== 'object') return false;
  if (card.tag === 'button' && card.value?.action === GROUP_SETTING_ACTION
    && card.value.session_id === sessionId && card.value.field === field) return true;
  return Object.values(card).some(value => hasSetting(value, sessionId, field));
}

/** 保存失败返回明确提示；成功同时返回两项最新状态，保留正文和其它按钮。 */
export async function handleGroupSettingAction(data: CardActionData, appId: string): Promise<any> {
  const value = data.action?.value;
  const field = value?.field;
  const messageId = data.context?.open_message_id ?? data.open_message_id;
  const fail = (content: string) => ({ toast: { type: 'error', content } });
  if (!messageId || !value || (field !== 'sync' && field !== 'reuse') || typeof value.next_value !== 'boolean') {
    return fail('按钮已失效');
  }
  try {
    const item = (await getMessageDetail(appId, messageId)).items?.find((message: any) => message.message_id === messageId);
    if (!item || (!item.thread_id && !item.root_id) || item.sync_to_chat_info?.type === 1) return fail('仅限普通群话题内设置');
    if (!canOperate(appId, item.chat_id, data.operator?.open_id)) return fail('无权修改群设置');
    const card = readGroupCardSnapshot(appId, messageId);
    if (!card) return fail('请使用最新会话卡设置');
    const session = cardSession(card, appId);
    if (!session || session.chatId !== item.chat_id || session.sessionId !== value.session_id
      || !hasSetting(card, session.sessionId, value.field)) return fail('按钮已失效');
    if (await getChatModeStrict(appId, item.chat_id) !== 'group') return fail('仅限普通群话题内设置');
    await setRegularGroupSetting(appId, item.chat_id, field, value.next_value);
    const updated = withGroupSettings(card, session, regularGroupSettings(appId, item.chat_id));
    saveGroupCardSnapshot(appId, messageId, updated);
    return { toast: { type: 'success', content: '已更新，仅当前群生效' },
      card: { type: 'raw', data: updated } };
  } catch { return fail('设置失败，请重试'); }
}
