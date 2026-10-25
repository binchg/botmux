/** 机器人配置字段更新与原卡刷新；由 card-handler.ts 拆分，来源 c397c9af。 */
import { CardActionContext, CARD_ACTION_UNHANDLED } from './card-action-context.js';
import { isLocale, localeForBot, t } from '../../i18n/index.js';
import { getBot } from '../../bot-registry.js';
import { ttadkConfigModelChoices } from '../../setup/cli-selection.js';
import { config } from '../../config.js';
import { createCliAdapterSync } from '../../adapters/cli/registry.js';
import { getConfigCardData, findConfigField, coerceConfigValue, applyConfigField } from '../../services/bot-config-store.js';
import { buildConfigCard, buildConfigTextCard, CONFIG_UNSET } from './card-builder.js';
import { sendUserMessage } from './client.js';
import { writeTeamRoleFile, deleteTeamRoleFile } from '../../core/role-resolver.js';
import { logger } from '../../utils/logger.js';
import { updateBotGrantPrefs } from '../../services/grant-prefs-store.js';

/** 机器人配置字段更新与原卡刷新；未命中时交给下一处理器。 */
export async function handleBotConfigAction(context: CardActionContext): Promise<any> {
  const { data, larkAppId, action, value, operatorOpenId } = context;
  const CONFIG_CARD_ACTIONS = ['config_toggle', 'config_set', 'config_quota', 'config_text_open', 'config_text_save'];
  if (value?.action && larkAppId && CONFIG_CARD_ACTIONS.includes(value.action)) {
    // 卡片携带的渲染语言（`/botconfig en` 的覆盖）优先；缺省回落 bot 默认。
    const vLoc = (value as any)?.loc;
    const loc = isLocale(vLoc) ? vLoc : localeForBot(larkAppId);
    let cbot;
    try { cbot = getBot(larkAppId); } catch { return { toast: { type: 'error', content: t('cmd.config.no_bot', undefined, loc) } }; }
    // 严格 owner/allowlist 闸（与文字版 /botconfig 同口径）：拒开放模式 + 非 admin。
    const admins = cbot.resolvedAllowedUsers;
    if (admins.length === 0 || !operatorOpenId || !admins.includes(operatorOpenId)) {
      return { toast: { type: 'error', content: t('cmd.config.not_admin', undefined, loc) } };
    }
    // ttadk 网关 bot 用 ttadk 网关模型候选（glm-5.1…），非底层适配器的 opus/gpt-5
    // （否则被 worker 注入成 `ttadk -m opus` 用错模型启动失败）；CoCo 无候选。
    const modelChoices = (() => {
      const ttadkChoices = ttadkConfigModelChoices(cbot.config.wrapperCli);
      if (ttadkChoices !== null) return ttadkChoices;
      try { return createCliAdapterSync(cbot.config.cliId, cbot.config.cliPathOverride).modelChoices ?? []; } catch { return []; }
    })();
    const reRender = () => {
      const d = getConfigCardData(larkAppId, modelChoices);
      return d ? { card: { type: 'raw' as const, data: JSON.parse(buildConfigCard(d, loc)) } } : {};
    };
    // 「文本设置」子卡：点主卡按钮 → **私信新发**一张含输入框的子卡（v1 form 须新发、
    // 不能 patch，否则空卡）。子卡每个字段一个 form，保存即写、回 toast、卡片保持
    // （不回 card → 不 patch，避免 form 重渲染异常）。
    if (value.action === 'config_text_open') {
      const d = getConfigCardData(larkAppId, modelChoices);
      if (!d) return { toast: { type: 'error', content: t('cmd.config.no_bot', undefined, loc) } };
      try {
        await sendUserMessage(larkAppId, operatorOpenId!, buildConfigTextCard(d, loc), 'interactive');
        return { toast: { type: 'success', content: t('card.config.text_sent', undefined, loc) } };
      } catch {
        return { toast: { type: 'error', content: t('card.config.text_send_fail', undefined, loc) } };
      }
    }
    if (value.action === 'config_text_save') {
      const fk = (value as any)?.field as string | undefined;
      const fv: Record<string, string> = (action as any)?.form_value ?? {};
      const raw = String((fk ? fv[fk] : '') ?? '').trim();
      if (fk === 'teamRole') {
        if (raw) writeTeamRoleFile(larkAppId, raw.slice(0, 4096)); else deleteTeamRoleFile(larkAppId);
        logger.info(`[config:${larkAppId}] team role ${raw ? 'set' : 'cleared'} via card`);
        return { toast: { type: 'success', content: t('card.config.text_saved', undefined, loc) } };
      }
      const spec = fk ? findConfigField(fk) : undefined;
      if (!spec) return { toast: { type: 'error', content: t('cmd.config.unknown_field', { field: fk ?? '?', fields: '' }, loc) } };
      // 留空 = 清除；非空一律过 coerceConfigValue 按 kind 归一化/校验（stringList
      // 拆数组、string 执行 maxLen 等 spec 约束），与 /config 文字入口、dashboard
      // PUT 同一校验点，避免卡片入口绕过。
      let valueToApply: string | string[] | null;
      if (!raw) {
        valueToApply = null;
      } else {
        const coerced = coerceConfigValue(spec, raw);
        if (!coerced.ok) return { toast: { type: 'error', content: t('cmd.config.write_failed', { reason: coerced.reason }, loc) } };
        // 文本子卡只承载 string / stringList 字段；narrow 给 applyConfigField。
        valueToApply = coerced.value as string | string[];
      }
      const r = await applyConfigField(larkAppId, spec, valueToApply);
      if (!r.ok) return { toast: { type: 'error', content: t('cmd.config.write_failed', { reason: r.reason }, loc) } };
      logger.info(`[config:${larkAppId}] text field ${spec.key} saved via card`);
      return { toast: { type: 'success', content: `✓ ${spec.key} = ${r.newText}` } };
    }

    // 消息额度（grant-prefs，非 CONFIG_FIELDS 字段）：'off' = 关闭，正整数 = 设定。
    if (value.action === 'config_quota') {
      const raw = (action as any)?.option ?? '';
      const n = raw === 'off' ? null : Number(raw);
      const limit = n && Number.isInteger(n) && n > 0 ? n : null;
      const qr = await updateBotGrantPrefs(larkAppId, { messageQuotaDefaultLimit: limit });
      if (!qr.ok) return { toast: { type: 'error', content: t('cmd.config.write_failed', { reason: qr.reason }, loc) } };
      return { toast: { type: 'success', content: `✓ quota = ${limit ?? 'off'}` }, ...reRender() };
    }

    const field = value.field as string | undefined;
    const spec = field ? findConfigField(field) : undefined;
    if (!spec || spec.kind === 'allowedUsers') {
      return { toast: { type: 'error', content: t('cmd.config.unknown_field', { field: field ?? '?', fields: '' }, loc) } };
    }

    let r;
    if (value.action === 'config_toggle') {
      if (spec.kind !== 'boolean') return { toast: { type: 'error', content: t('cmd.config.invalid_bool', { field: spec.key, value: '' }, loc) } };
      const cur = (cbot.config as any)[spec.configKey] === true;
      r = await applyConfigField(larkAppId, spec, !cur);
    } else {
      const raw = (action as any)?.option ?? (action as any)?.input_value ?? '';
      if (raw === CONFIG_UNSET) {
        if (!spec.clearable) return { toast: { type: 'error', content: t('cmd.config.not_clearable', { field: spec.key }, loc) }, ...reRender() };
        r = await applyConfigField(larkAppId, spec, null);
      } else {
        const coerced = coerceConfigValue(spec, raw);
        if (!coerced.ok) return { toast: { type: 'error', content: t('cmd.config.write_failed', { reason: coerced.reason }, loc) }, ...reRender() };
        r = await applyConfigField(larkAppId, spec, coerced.value);
      }
    }
    if (!r.ok) return { toast: { type: 'error', content: t('cmd.config.write_failed', { reason: r.reason }, loc) } };
    return { toast: { type: 'success', content: `✓ ${spec.key} = ${r.newText}` }, ...reRender() };
  }
  return CARD_ACTION_UNHANDLED;
}
