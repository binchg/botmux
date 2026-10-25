/** 卡片回调公共入口与职责分派；由 card-handler.ts 拆分，来源 c397c9af。 */
import { CardHandlerDeps, CardActionData, CardOperatorIdentity, ResolveCardOperatorUnionIdDeps, resolveCardOperatorUnionId } from './card-action-types.js';
import { createCardActionContext, CARD_ACTION_UNHANDLED } from './card-action-context.js';
import { logger } from '../../utils/logger.js';
import { GROUP_SETTING_ACTION } from './regular-group-settings-card.js';
import { handleGroupSettingAction } from './regular-group-settings-action.js';
import { handleGrantActions } from './card-action-grants.js';
import { handlePanelActions } from './card-action-panels.js';
import { handleRelayPickerAction } from './card-action-relay-picker.js';
import { handleBotConfigAction } from './card-action-config.js';
import { handleRelayConfirmAction } from './card-action-relay-confirm.js';
import { handleApprovalActions } from './card-action-approval.js';
import { checkCardActionPermission } from './card-action-permissions.js';
import { handleLegacyApprovalAction } from './card-action-legacy-approval.js';
import { handleSessionCardAction } from './card-action-session.js';
import { handleDropdownAction } from './card-action-dropdown.js';

export type { CardHandlerDeps, CardActionData, CardOperatorIdentity, ResolveCardOperatorUnionIdDeps } from './card-action-types.js';
export { resolveCardOperatorUnionId } from './card-action-types.js';
/** 保持原有操作次序，新增群设置只在自身动作命中时处理。 */
export async function handleCardAction(data: CardActionData, deps: CardHandlerDeps, larkAppId?: string): Promise<any> {
  const context = createCardActionContext(data, deps, larkAppId);
  const { action, value } = context;
  if (logger.isDebug()) {
    logger.debug(
      `[card] app=${larkAppId ?? '?'} op=${data?.operator?.open_id ?? '?'} ` +
      `action=${value?.action ?? action?.option ?? '?'} root=${value?.root_id ?? '?'}`,
    );
  }
  if (value?.action === GROUP_SETTING_ACTION && larkAppId) return handleGroupSettingAction(data, larkAppId);
  for (const handle of [handleGrantActions, handlePanelActions, handleRelayPickerAction,
    handleBotConfigAction, handleRelayConfirmAction, handleApprovalActions,
    checkCardActionPermission, handleLegacyApprovalAction]) {
    const result = await handle(context);
    if (result !== CARD_ACTION_UNHANDLED) return result;
  }
  return value?.action ? handleSessionCardAction(context) : handleDropdownAction(context);
}
