/** 保留既有审批卡返回契约；由 card-handler.ts 拆分，来源 c397c9af。 */
import { CardActionContext, CARD_ACTION_UNHANDLED } from './card-action-context.js';
import { isWorkflowApprovalAction, handleWorkflowApprovalAction } from './workflow-card-handler.js';
import { localeForBot, t } from '../../i18n/index.js';

/** 保留既有审批卡返回契约；未命中时交给下一处理器。 */
export async function handleLegacyApprovalAction(context: CardActionContext): Promise<any> {
  const { data, deps, larkAppId, action, value } = context;
  if (isWorkflowApprovalAction(value?.action)) {
    const locWf = localeForBot(larkAppId);
    const workflowData = data as Parameters<typeof handleWorkflowApprovalAction>[0];
    const result = await handleWorkflowApprovalAction(workflowData, deps.workflowApprovalDeps, locWf);
    const runId = value?.run_id;
    if (result?.ok && !result.duplicate && runId) {
      await deps.workflowApprovalResolved?.(runId);
    }
    // Non-approver: surface a toast so the clicker knows nothing happened
    // (instead of silently leaving the buttons active).
    if (result && !result.ok && result.error === 'not_approver') {
      return { toast: { type: 'warning', content: t('toast.not_in_approver_list', undefined, locWf) } };
    }
    // Successful resolve / reject / cancel: replace the clicked card with a
    // frozen "已通过/已拒绝/已取消" body so the buttons can't be re-submitted
    // from this surface. Duplicate clicks just no-op (the first PATCH already
    // landed).
    if (result?.ok && !result.duplicate && result.resolvedCardJson) {
      try {
        return JSON.parse(result.resolvedCardJson);
      } catch {
        // fall through to undefined
      }
    }
    return;
  }
  return CARD_ACTION_UNHANDLED;
}
