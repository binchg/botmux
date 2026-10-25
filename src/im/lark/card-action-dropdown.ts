/** 下拉选项类型校验与分派；由 card-handler.ts 拆分，来源 c397c9af。 */
import { CardActionContext, CARD_ACTION_UNHANDLED } from './card-action-context.js';
import { logger } from '../../utils/logger.js';
import { handleAdoptChoice } from './card-action-adopt.js';
import { handleRepoChoice } from './card-action-repo-choice.js';

/** 下拉输入先校验类型，再分派接管或仓库操作。 */
export async function handleDropdownAction(context: CardActionContext): Promise<any> {
  const { action } = context;
  const option = action?.option;
  if (!option) {
    logger.warn('Card action received but no option or action value');
    return;
  }
  if (Array.isArray(option)) {
    logger.warn('Card action received multi options for a single-select handler');
    return;
  }
  if (typeof option !== 'string') {
    logger.warn('Card action received non-string option for a single-select handler');
    return;
  }
  const result = await handleAdoptChoice(context, option);
  return result !== CARD_ACTION_UNHANDLED ? result : handleRepoChoice(context, option);
}
