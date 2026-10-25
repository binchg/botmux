/** 飞书事件权限检查与管理员提醒；由 event-dispatcher.ts 拆分，来源 c397c9af。 */
import { type BotState, getBot } from '../../bot-registry.js';
import { sendUserMessage } from './client.js';
import { logger } from '../../utils/logger.js';
import { normalizeBrand, larkHosts } from './lark-hosts.js';
import { config } from '../../config.js';
import { buildScopeDeepLink, DOC_FEATURE_SCOPES, DOC_COMMENT_EVENT, BOTMUX_REQUIRED_SCOPES } from '../../setup/verify-permissions.js';
import { listAllDocSubscriptions } from '../../services/doc-subs-store.js';
import { join } from 'node:path';

export const REQUIRED_BOT_AT_SCOPE = 'im:message.group_at_msg.include_bot:readonly';
export const SELF_MANAGE_SCOPE = 'application:application:self_manage';

export function getAdminOpenId(bot: BotState): string | undefined {
  return bot.resolvedAllowedUsers.find(u => u.startsWith('ou_'));
}

export async function dmAdmin(larkAppId: string, adminOpenId: string, content: string, contextTag: string): Promise<void> {
  try {
    await sendUserMessage(larkAppId, adminOpenId, content, 'text');
    logger.info(`[${larkAppId}] notified admin ${adminOpenId.substring(0, 12)} about ${contextTag}`);
  } catch (err: any) {
    logger.warn(`[${larkAppId}] failed to DM admin about ${contextTag}: ${err?.message ?? err}`);
  }
}

export async function checkRequiredScopes(larkAppId: string): Promise<void> {
  const bot = getBot(larkAppId);
  const brand = normalizeBrand(bot.config.brand);
  const openApi = larkHosts(brand).openApi;
  try {
    const tokenRes = await fetch(`${openApi}/open-apis/auth/v3/tenant_access_token/internal`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ app_id: bot.config.larkAppId, app_secret: bot.config.larkAppSecret }),
    });
    const tokenData = await tokenRes.json() as any;
    if (tokenData.code !== 0) {
      logger.debug(`[${larkAppId}] scope check skipped: tenant_access_token failed (${tokenData.msg})`);
      return;
    }
    const infoRes = await fetch(
      `${openApi}/open-apis/application/v6/applications/${bot.config.larkAppId}?lang=zh_cn`,
      { headers: { Authorization: `Bearer ${tokenData.tenant_access_token}` } },
    );
    const infoData = await infoRes.json() as any;

    // 99991672 = 应用身份缺权限。最常见就是 admin:app.info:readonly /
    // application:application:self_manage 都没拿到，导致根本查不到自己的
    // scope 列表。这种"鸡生蛋"情况单独提示：让 admin 开通免审批的
    // self_manage 后下次重启就能自检了。
    if (infoData.code === 99991672) {
      const selfManageAuthUrl = buildScopeDeepLink(bot.config.larkAppId, SELF_MANAGE_SCOPE, brand);
      const targetAuthUrl = buildScopeDeepLink(bot.config.larkAppId, REQUIRED_BOT_AT_SCOPE, brand);
      logger.warn(
        `[${larkAppId}] scope 自检 API 被拒（99991672）：应用缺少 ${SELF_MANAGE_SCOPE}（免审批）。` +
        `开通后下次 daemon 重启即可自动核验跨 bot @ 必需权限 ${REQUIRED_BOT_AT_SCOPE}。申请链接：${selfManageAuthUrl}`,
      );
      const adminOpenId = getAdminOpenId(bot);
      if (!adminOpenId) {
        logger.warn(`[${larkAppId}] 没有 resolved 的 admin open_id，self_manage 提示仅出现在 daemon 日志`);
        return;
      }
      const dm =
        `⚠️ botmux 想自动核验机器人 "${bot.botName ?? larkAppId}" 是否开通了跨 bot @ 必需权限，但发现应用自身缺少一个**免审批**的辅助权限，因此查不到 scope 列表。\n\n` +
        `**操作步骤（点链接 → 申请开通 → 重启 daemon）**：\n` +
        `1. 开通 ${SELF_MANAGE_SCOPE}（免审批，自动通过）：\n   ${selfManageAuthUrl}\n\n` +
        `2. 顺便确认/开通真正的目标权限 ${REQUIRED_BOT_AT_SCOPE}（"获取群组中其他机器人和用户@当前机器人的消息"，免审批，自动通过）：\n   ${targetAuthUrl}\n\n` +
        `3. \`botmux restart\`，启动后 botmux 会自动复核，结果会再次发到这里。\n\n` +
        `**为什么需要**：botmux 多机器人协作（A 机器人 @ B 机器人）依赖目标权限把跨 bot 事件推送过来；不开通则跨 bot @ 完全失效。`;
      await dmAdmin(larkAppId, adminOpenId, dm, 'self_manage scope (auto-approved) missing');
      return;
    }

    if (infoData.code !== 0) {
      logger.debug(`[${larkAppId}] scope check skipped: app info failed (code=${infoData.code} msg=${infoData.msg ?? ''})`);
      return;
    }
    // Lark 文档示例把 scopes 放在 data.app.scopes；为防响应结构变化，
    // 同时兜底 data.scopes / data.application.scopes，取到的第一个非空数组为准。
    const scopesRaw: any[] =
      infoData.data?.app?.scopes
      ?? infoData.data?.application?.scopes
      ?? infoData.data?.scopes
      ?? [];
    if (!Array.isArray(scopesRaw) || scopesRaw.length === 0) {
      logger.debug(`[${larkAppId}] scope check inconclusive: scopes array empty or shape unexpected — skipping`);
      return;
    }
    const grantedScopes = new Set(
      scopesRaw.map(s => typeof s === 'string' ? s : s?.scope).filter(Boolean) as string[],
    );

    // 文档评论入口就绪自检：仅对「已订阅过文档」的 bot 生效（opt-in，不打扰其他 bot）。
    // ① 校验文档 app 权限是否开通（可查 → 缺则 DM 深链）② 提醒去后台订阅评论事件
    // drive.notice.comment_add_v1（飞书无 API 可查是否已订阅，只能提醒）——让「订阅
    // 成功却收不到评论」这类配置漏项在重启自检时暴露。
    try {
      const docSubs = listAllDocSubscriptions(config.session.dataDir, larkAppId);
      if (docSubs.length > 0) {
        const missingDoc = DOC_FEATURE_SCOPES.filter(s => !grantedScopes.has(s.name));
        if (missingDoc.length > 0) {
          const summary = missingDoc.map(s => `${s.name}(${s.desc})`).join('、');
          logger.error(`[${larkAppId}] 文档评论入口已在用（${docSubs.length} 个订阅）但缺 ${missingDoc.length} 项文档权限：${summary}。评论将收不到/回不了，请到权限管理开通后 botmux restart。`);
          const adminDoc = getAdminOpenId(bot);
          if (adminDoc) {
            const lines = missingDoc.map((s, i) => `${i + 1}. **${s.desc}** (\`${s.name}\`)\n   ${buildScopeDeepLink(bot.config.larkAppId, s.name, brand)}`).join('\n\n');
            await dmAdmin(larkAppId, adminDoc,
              `⚠️ 机器人 "${bot.botName ?? larkAppId}" 已订阅 ${docSubs.length} 个飞书文档（/subscribe-lark-doc），但缺少文档评论所需权限：\n\n${lines}\n\n` +
              `另外请确认开发者后台「事件订阅」里已添加 **\`${DOC_COMMENT_EVENT}\`**（云文档新增评论）事件——该事件无法被自动检测，缺它则评论永远收不到。\n\n开通 + 订阅事件后执行 \`botmux restart\`。`,
              `missing doc-feature scopes: ${missingDoc.map(s => s.name).join(',')}`);
          }
        } else {
          // 权限齐了——事件订阅查不了，仅 info 记一条提醒（不 DM 免重启刷屏）。
          logger.info(`[${larkAppId}] doc-comment 权限齐全（${docSubs.length} 订阅）；请确保后台已订阅事件 ${DOC_COMMENT_EVENT}（无法自动检测）`);
        }
      }
    } catch (err: any) {
      logger.debug(`[${larkAppId}] doc-feature readiness check errored: ${err?.message ?? err}`);
    }

    // Diff against the canonical list. Critical-missing is the main signal;
    // non-critical is mentioned only when something critical is also missing,
    // so deployments don't get nagged about purely optional scopes like
    // `application:application:self_manage`.
    const missingCritical = BOTMUX_REQUIRED_SCOPES.filter(s => s.critical && !grantedScopes.has(s.name));
    const missingOptional = BOTMUX_REQUIRED_SCOPES.filter(s => !s.critical && !grantedScopes.has(s.name));

    if (missingCritical.length === 0) {
      logger.info(`[${larkAppId}] all critical scopes granted (${BOTMUX_REQUIRED_SCOPES.filter(s => s.critical).length} checked)`);
      return;
    }

    // Log + DM consolidated message listing all missing critical scopes.
    const summaryLine = missingCritical.map(s => `${s.name} (${s.desc})`).join('、');
    logger.error(
      `[${larkAppId}] 缺少 ${missingCritical.length} 项必需权限：${summaryLine}。` +
      `botmux 核心功能（消息收发、附件下载、用户名解析等）会受影响。请到飞书开放平台 → 应用 → 权限管理里申请，开通后 \`botmux restart\`。`,
    );
    const adminOpenId = getAdminOpenId(bot);
    if (!adminOpenId) {
      logger.warn(`[${larkAppId}] no resolved admin open_id in allowedUsers; missing-scope warning visible only in daemon log`);
      return;
    }
    const criticalLines = missingCritical.map((s, i) =>
      `${i + 1}. **${s.desc}** (\`${s.name}\`)\n   ${buildScopeDeepLink(bot.config.larkAppId, s.name, brand)}`,
    ).join('\n\n');
    const optionalBlock = missingOptional.length > 0
      ? `\n\n**可选权限（建议一并开通）**：\n${missingOptional.map(s => `- ${s.desc} (\`${s.name}\`): ${buildScopeDeepLink(bot.config.larkAppId, s.name, brand)}`).join('\n')}`
      : '';
    const dm =
      `⚠️ botmux 启动检查发现机器人 "${bot.botName ?? larkAppId}" 缺少 ${missingCritical.length} 项必需权限\n\n` +
      `**操作步骤（点链接 → 申请开通 → 重启 daemon）**：\n\n` +
      `${criticalLines}\n\n` +
      `开通完成后执行 \`botmux restart\`，botmux 会再次自检并把结果发到这里。${optionalBlock}`;
    await dmAdmin(larkAppId, adminOpenId, dm, `missing scopes: ${missingCritical.map(s => s.name).join(',')}`);
  } catch (err: any) {
    logger.debug(`[${larkAppId}] scope check errored: ${err?.message ?? err}`);
  }
}
