/** 会话卡片操作分派；由 card-handler.ts 拆分，来源 c397c9af。 */
import { CardActionContext, SessionCardContext, CARD_ACTION_UNHANDLED } from './card-action-context.js';
import { sessionKey } from '../../core/types.js';
import { getSessionByActionValue, validateCardCliBinding } from './card-action-session-helpers.js';
import { handleLifecycleAction } from './card-action-lifecycle.js';
import { handleTerminalInputAction } from './card-action-terminal-input.js';
import { handleDisplayAction } from './card-action-display.js';
import { handleRepoFormAction } from './card-action-repo-form.js';

/** 解析会话后按原顺序分派，未知动作仍保持原来的空返回。 */
export async function handleSessionCardAction(context: CardActionContext): Promise<any> {
  const { value, larkAppId, activeSessions } = context;
  if (!value?.action) return;
    const { action: actionType, root_id: rootId } = value;
    const sKey = larkAppId ? sessionKey(rootId, larkAppId) : rootId;
    const ds = larkAppId
      ? getSessionByActionValue(activeSessions, rootId, larkAppId, value.session_id, actionType)
      : activeSessions.get(rootId);

    if (ds && !validateCardCliBinding(ds, value)) return;
  const sessionContext: SessionCardContext = { ...context, value, actionType, rootId, sKey, ds };
  for (const handle of [handleLifecycleAction, handleTerminalInputAction, handleDisplayAction, handleRepoFormAction]) {
    const result = await handle(sessionContext);
    if (result !== CARD_ACTION_UNHANDLED) return result;
  }
}
