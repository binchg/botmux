/** 询问卡与控制台导航操作；由 card-handler.ts 拆分，来源 c397c9af。 */
import { CardActionContext, CARD_ACTION_UNHANDLED } from './card-action-context.js';
import { isAskCardAction, handleAskCardAction } from './ask-card.js';
import { localeForBot } from '../../i18n/index.js';

/** 询问卡与控制台导航操作；未命中时交给下一处理器。 */
export async function handlePanelActions(context: CardActionContext): Promise<any> {
  const { data, larkAppId, action, value } = context;
  if (isAskCardAction(value?.action)) {
    return handleAskCardAction(data);
  }

  // Dashboard callbacks dispatch before session lookup. They do not require an
  // active DaemonSession and use dashboard-internal Route B endpoints.
  if (
    typeof value?.action === 'string' &&
    value.action.startsWith('dash_settings_') &&
    larkAppId
  ) {
    const { handleSettingsCardAction } = await import('./settings-card.js');
    const { createDaemonClientFor } = await import('../../daemon-internal-client-wrapper.js');
    const settingsLocale = localeForBot(larkAppId);
    // Success returns `{ card }` only so Lark replaces the card in the same
    // callback response. Slow fallback is handled by the event dispatcher.
    return handleSettingsCardAction(data, larkAppId, {
      createClient: (appId: string) => createDaemonClientFor(appId),
      locale: settingsLocale,
    });
  }

  // ─── `/dashboard sessions` callbacks ─────────────────────────────────
  // Same response shape as dash_settings_*: success returns `{ card }` only,
  // no toast, so Lark renders the new list in a single pass.
  if (
    typeof value?.action === 'string' &&
    value.action.startsWith('dash_sessions_') &&
    larkAppId
  ) {
    const { handleSessionsCardAction } = await import('./sessions-card.js');
    const { createDaemonClientFor } = await import('../../daemon-internal-client-wrapper.js');
    const sessionsLocale = localeForBot(larkAppId);
    return handleSessionsCardAction(data, larkAppId, {
      createClient: (appId: string) => createDaemonClientFor(appId),
      locale: sessionsLocale,
    });
  }

  // ─── `/dashboard schedules` callbacks ────────────────────────────────
  if (
    typeof value?.action === 'string' &&
    value.action.startsWith('dash_schedules_') &&
    larkAppId
  ) {
    const { handleSchedulesCardAction } = await import('./schedules-card.js');
    const { createDaemonClientFor } = await import('../../daemon-internal-client-wrapper.js');
    const schedulesLocale = localeForBot(larkAppId);
    return handleSchedulesCardAction(data, larkAppId, {
      createClient: (appId: string) => createDaemonClientFor(appId),
      locale: schedulesLocale,
    });
  }

  // ─── `/dashboard workflows` callbacks ────────────────────────────────
  if (
    typeof value?.action === 'string' &&
    value.action.startsWith('dash_workflows_') &&
    larkAppId
  ) {
    const { handleWorkflowsCardAction } = await import('./workflows-card.js');
    const { createDaemonClientFor } = await import('../../daemon-internal-client-wrapper.js');
    const workflowsLocale = localeForBot(larkAppId);
    return handleWorkflowsCardAction(data, larkAppId, {
      createClient: (appId: string) => createDaemonClientFor(appId),
      locale: workflowsLocale,
    });
  }

  // ─── `/dashboard groups` callbacks ───────────────────────────────────
  if (
    typeof value?.action === 'string' &&
    value.action.startsWith('dash_groups_') &&
    larkAppId
  ) {
    const { handleGroupsCardAction } = await import('./groups-card.js');
    const { createDaemonClientFor } = await import('../../daemon-internal-client-wrapper.js');
    const groupsLocale = localeForBot(larkAppId);
    return handleGroupsCardAction(data, larkAppId, {
      createClient: (appId: string) => createDaemonClientFor(appId),
      locale: groupsLocale,
    });
  }

  // ─── `/dashboard overview` callbacks ─────────────────────────────────
  // Goto buttons rebuild the TARGET card by re-fetching the corresponding
  // dedicated Route B endpoint (sessions-list / schedules-list /
  // settings-snapshot). No new endpoints, no multi_url cross-card jumps.
  if (
    typeof value?.action === 'string' &&
    value.action.startsWith('dash_overview_') &&
    larkAppId
  ) {
    const { handleOverviewCardAction } = await import('./overview-card.js');
    const { createDaemonClientFor } = await import('../../daemon-internal-client-wrapper.js');
    const overviewLocale = localeForBot(larkAppId);
    return handleOverviewCardAction(data, larkAppId, {
      createClient: (appId: string) => createDaemonClientFor(appId),
      locale: overviewLocale,
    });
  }
  return CARD_ACTION_UNHANDLED;
}
