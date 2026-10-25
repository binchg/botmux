/** 用户会话权限、授权范围和群消息准入；由 event-dispatcher.ts 拆分，来源 c397c9af。 */
import { getBot, findOncallChat, getOwnerOpenId } from '../../bot-registry.js';
import { config } from '../../config.js';
import { chatQuotaKey, globalQuotaKey } from '../../services/grant-store.js';
import { isKnownPeerBot } from './event-peer-identity.js';
import { isTeamBot } from '../../services/team-bots-store.js';
import { isPlatformTeamBot } from '../../services/platform-team-store.js';
import { isThrottled, openPending, clearPending } from './grant-pending.js';
import { mentionOpenId } from './message-parser.js';
import { listObservedBots } from '../../services/observed-bots-store.js';
import { buildGrantCard } from './card-builder.js';
import { localeForBot } from '../../i18n/index.js';
import { replyMessage } from './client.js';
import { logger } from '../../utils/logger.js';
import { isBotMentioned } from './event-mentions.js';
import { getGroupStats } from './event-group-stats.js';

export type TalkReason =
  | 'allowedUser'
  | 'oncall'
  | 'peer'
  | 'teamBot'
  | 'allowedChatGroup'
  | 'open'
  | 'chatGrant'
  | 'globalGrant'
  | 'none';

export interface TalkEvaluation {
  allowed: boolean;
  reason: TalkReason;
  quotaKey?: string;
}

export type GrantCommandRestrictionReason = 'chatGrant' | 'globalGrant';

export function grantCommandRestriction(
  larkAppId: string,
  chatId: string | undefined,
  senderOpenId: string | undefined,
): { blocked: boolean; reason?: GrantCommandRestrictionReason } {
  const bot = getBot(larkAppId);
  if (bot.config.restrictGrantCommands !== true) return { blocked: false };
  const ev = evaluateTalk(larkAppId, chatId, senderOpenId);
  if (ev.reason === 'chatGrant' || ev.reason === 'globalGrant') {
    return { blocked: true, reason: ev.reason };
  }
  return { blocked: false };
}

/** per-chat per-user 授权命中判断（仅用于 canTalk —— 不给管理命令权）。 */
export function hasChatGrant(larkAppId: string, chatId: string | undefined, openId: string | undefined): boolean {
  return !!chatId && !!openId && !!getBot(larkAppId).config.chatGrants?.[chatId]?.includes(openId);
}

/** 全局对话授权命中判断（人/bot 通用，仅用于 canTalk / bot 路由闸 —— 不给管理命令权）。 */
export function hasGlobalGrant(larkAppId: string, openId: string | undefined): boolean {
  return !!openId && !!getBot(larkAppId).config.globalGrants?.includes(openId);
}

/**
 * 是否配置了任何白名单（限制态）。判定用 **原始** config.allowedUsers, 不用
 * resolvedAllowedUsers——否则「配了 owner 但启动时邮箱/union 解析失败 → resolved 为空」
 * 会 fall through 成「无白名单 = 全开放」，把误配/解析失败 fail-open 成谁都能 operate。
 * 配了就算限制态：解析为空时成员判定一律落空 → fail-closed（由 owner 修配置）。
 */
export function hasConfiguredAllowlist(bot: ReturnType<typeof getBot>): boolean {
  return (bot.config.allowedUsers?.length ?? 0) > 0
    || (bot.config.allowedChatGroups?.length ?? 0) > 0
    || (bot.config.globalGrants?.length ?? 0) > 0;
}

export function canTalk(larkAppId: string, chatId: string | undefined, senderOpenId: string | undefined, senderUnionId?: string): boolean {
  return evaluateTalk(larkAppId, chatId, senderOpenId, senderUnionId).allowed;
}

export function evaluateTalk(larkAppId: string, chatId: string | undefined, senderOpenId: string | undefined, senderUnionId?: string): TalkEvaluation {
  const bot = getBot(larkAppId);
  // allowedChatGroups 是"talk-open 的 chat_id 列表"：当前消息来自其中之一即放行（仅 canTalk）。
  // 成员关系隐含在"能在该 chat 发言"里 —— 退群者发不了言自动失权，新人进群即生效，无需成员快照。
  const allowedUsers = bot.resolvedAllowedUsers;
  if (senderOpenId && allowedUsers.includes(senderOpenId)) return { allowed: true, reason: 'allowedUser' };
  // Oncall 群命中：默认不限额；仅当 bot 配了 messageQuota.defaultLimit 时，
  // 才挂 chat:<chatId>:<openId> 这一 quotaKey（与 chatGrant 同键、同计数器，
  // 便于 owner 后续 /grant @x N 续杯/重置）。
  if (chatId && findOncallChat(larkAppId, chatId)) {
    const def = bot.config.messageQuota?.defaultLimit;
    if (typeof def === 'number' && Number.isInteger(def) && def > 0 && senderOpenId) {
      return { allowed: true, reason: 'oncall', quotaKey: chatQuotaKey(chatId, senderOpenId) };
    }
    return { allowed: true, reason: 'oncall' };
  }
  if (isKnownPeerBot(config.session.dataDir, larkAppId, senderOpenId)) return { allowed: true, reason: 'peer' };
  // 跨部署团队 peer bot（旧版联邦学来的 union_id / 平台 roster 下发的 union_id）——
  // 与 isKnownPeerBot 兄弟 bot 对等的 talk 放行。没有这一腿，外部 bot 闸门
  //（isTrustedTeamBotSender）放进来的团队 bot 消息会在 enforceMessageQuotaForCliInput
  // 的 evaluateTalk 复查处被静默丢弃（受限 bot 上 #332 的端到端断点）。仅认租户
  // 稳定 union_id（bot 专属，人不会进这两张表），不看 chatId，不授 operate。
  if (senderUnionId && (isTeamBot(config.session.dataDir, senderUnionId) || isPlatformTeamBot(config.session.dataDir, senderUnionId))) {
    return { allowed: true, reason: 'teamBot' };
  }
  if (chatId && bot.config.allowedChatGroups?.includes(chatId)) return { allowed: true, reason: 'allowedChatGroup' };

  // globalGrants 与 allowedChatGroups 同样确立"有白名单"语义：只配 globalGrants 也算限制态，
  // 不能 fall through 到"全开放"。用原始配置判定（见 hasConfiguredAllowlist）：配了 owner
  // 但解析失败时也保持限制态, 不 fail-open。
  if (!hasConfiguredAllowlist(bot)) return { allowed: true, reason: 'open' };

  if (hasChatGrant(larkAppId, chatId, senderOpenId)) {
    return { allowed: true, reason: 'chatGrant', quotaKey: chatQuotaKey(chatId!, senderOpenId!) };
  }
  // 全局对话授权（talk-only，人/bot 通用）：命中即在任意群放行，与 chatGrants 同级、不授 operate。
  if (hasGlobalGrant(larkAppId, senderOpenId)) {
    return { allowed: true, reason: 'globalGrant', quotaKey: globalQuotaKey(senderOpenId!) };
  }
  return { allowed: false, reason: 'none' };
}

export function canOperate(
  larkAppId: string,
  _chatId: string | undefined,
  senderOpenId: string | undefined,
  senderUnionId?: string | undefined,
): boolean {
  const bot = getBot(larkAppId);
  // L1 同部署兄弟 bot 互信 operate：与 canTalk 一致——isKnownPeerBot 只认本部署
  // bots-info.json 里注册过的自家 bot。这不重开 PR #46 的封堵：人的 talk 授权
  // （chatGrant/globalGrant）仍不漏成 operate；这里只放行「自家 bot 之间」的 /
  // 命令（让编排者能对子 bot 跑 /repo /cd 等）。
  if (isKnownPeerBot(config.session.dataDir, larkAppId, senderOpenId)) return true;
  // L2 跨部署「团队 peer bot」互信 operate（与 L1 兄弟 bot 对等，覆盖编排者给
  // 队友派 /repo /cd 等）。**只认租户稳定的 union_id**（isTeamBot / 平台 roster），
  // 不走 isTrustedTeamBotSender 的「团队群成员」分支——那条按 chat 放行是 sender
  // 无关的，会把「团队群里的真人」也误放进 operate，破坏 allowedUsers 边界。union_id
  // 是发送方专属、且必须先被团队背书（团队群学习 / 平台 roster）才进表，人不会命中。
  if (isTeamBot(config.session.dataDir, senderUnionId)) return true;
  if (isPlatformTeamBot(config.session.dataDir, senderUnionId)) return true;
  const allowedUsers = bot.resolvedAllowedUsers;
  // globalGrants（与 allowedChatGroups 同理）确立"有白名单"语义：只配 globalGrants 也算限制态，
  // 否则 canOperate 会 fall through 到"全开放"，把 talk-only 授权变成 operate 全开——正是 PR #46
  // 要堵的洞。注意 globalGrants 只进 hasAllowlist 判定，operate 命中仍只认 allowedUsers。
  // 用原始配置判定（hasConfiguredAllowlist）：配了 owner 但解析为空时 fail-closed, 不 fail-open。
  if (!hasConfiguredAllowlist(bot)) return true;
  return !!senderOpenId && allowedUsers.includes(senderOpenId);
}

/**
 * 入口 A：无权限者 @bot 时弹授权申请卡（正文 @owner，由 owner 处置）。
 * 受 grant-pending 节流：pending 中 / deny 冷却期内静默不发。开放模式（无 owner）兜底不发。
 */
export async function maybeSendGrantRequestCard(
  larkAppId: string, message: any, chatId: string, requesterOpenId: string | undefined,
): Promise<void> {
  if (getBot(larkAppId).config.autoGrantRequestCards === false) return;
  const owner = getOwnerOpenId(larkAppId);
  if (!owner || !requesterOpenId) return;
  if (isThrottled(larkAppId, chatId, requesterOpenId)) return;
  // 名字优先级：本消息 mentions（真人发送方、被 @ 目标都在此）→ observed-bots 花名册
  // （/introduce 登记过的 (open_id,name)）→ 裸 open_id 兜底。外部 bot 发送方不在自己
  // 消息的 mentions 里（那是 @ 目标），只靠 mentions 会让 owner 只看到 open_id。
  const mentionName = (message?.mentions ?? []).find((m: any) => mentionOpenId(m) === requesterOpenId)?.name;
  const observedName = mentionName
    ? undefined
    : listObservedBots(config.session.dataDir, larkAppId, chatId).find(b => b.openId === requesterOpenId)?.name;
  const name = mentionName ?? observedName ?? requesterOpenId;
  const nonce = openPending(larkAppId, chatId, requesterOpenId, getBot(larkAppId).config.messageQuota?.defaultLimit);
  const card = buildGrantCard(
    { ownerOpenId: owner, targets: [{ openId: requesterOpenId, name: String(name) }], chatId, nonce, mode: 'request' },
    localeForBot(larkAppId),
  );
  await replyMessage(larkAppId, message.message_id, card, 'interactive')
    .catch(err => {
      // 发卡失败必须撤掉刚开的 pending，否则该发送方被节流压死、owner 永远看不到卡片，
      // 只能等 daemon 重启或别的 target 触发全表 prune 才恢复。清掉后下次 @ 会重试发卡。
      clearPending(larkAppId, chatId, requesterOpenId);
      logger.debug(`grant request card send failed: ${err}`);
    });
}

// ─── Group message access check ──────────────────────────────────────────

/**
 * Check group message addressing:
 * - 'allowed'     -> sender is allowed, bot was @mentioned or solo group
 * - 'not_allowed' -> bot was @mentioned but sender is not in allowlist
 * - 'ignore'      -> not addressed to bot at all
 */
export async function checkGroupMessageAccess(
  larkAppId: string, message: any, chatId: string, senderOpenId: string | undefined,
): Promise<'allowed' | 'not_allowed' | 'ignore'> {
  const mentioned = isBotMentioned(larkAppId, message, senderOpenId);
  const isAllowed = canTalk(larkAppId, chatId, senderOpenId);

  logger.debug(`Check group message access: mentioned=${mentioned}, isAllowed=${isAllowed}`);
  if (mentioned) {
    return isAllowed ? 'allowed' : 'not_allowed';
  }

  // No @mention — only allow if sender is the sole human in the group
  // AND this is the only bot in the chat. With multiple bots, require @mention
  // to disambiguate.
  if (isAllowed) {
    const { userCount, botCount } = await getGroupStats(larkAppId, chatId);
    logger.debug(`Group user count: ${userCount}, bot count: ${botCount}`);
    if (userCount <= 1 && botCount <= 1) {
      return 'allowed';
    }
  }

  return 'ignore';
}
