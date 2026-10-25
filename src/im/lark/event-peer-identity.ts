/** 同部署机器人身份和介绍命令；由 event-dispatcher.ts 拆分，来源 c397c9af。 */
import { join } from 'node:path';
import { existsSync, readFileSync, mkdirSync } from 'node:fs';
import { isTeamBot } from '../../services/team-bots-store.js';
import { isPlatformTeamBot } from '../../services/platform-team-store.js';
import { isTeamGroupChat } from '../../services/team-groups-store.js';
import { mentionOpenId, stripLeadingMentions } from './message-parser.js';
import { atomicWriteFileSync } from '../../utils/atomic-write.js';
import { logger } from '../../utils/logger.js';
import { extractMessageTextForRouting } from './event-routing.js';
import { grantCommandRestriction } from './event-access.js';
import { localeForBot, t } from '../../i18n/index.js';
import { replyMessage, isHumanOpenId } from './client.js';
import { getBot } from '../../bot-registry.js';
import { recordObservedBots } from '../../services/observed-bots-store.js';
import { config } from '../../config.js';

export function readBotOpenIdCrossRef(dataDir: string, larkAppId: string): Map<string, string> {
  const map = new Map<string, string>();
  try {
    const fp = join(dataDir, `bot-openids-${larkAppId}.json`);
    if (existsSync(fp)) {
      const data: Record<string, string> = JSON.parse(readFileSync(fp, 'utf-8'));
      for (const [name, openId] of Object.entries(data)) {
        map.set(name.toLowerCase(), openId);
      }
    }
  } catch { /* ignore */ }
  return map;
}

/** Is `senderOpenId` a registered botmux peer (from larkAppId's cross-ref)?
 *  Used to gate chat-scope foreign-bot @mention spawning to vetted peers. */
export function isKnownPeerBot(dataDir: string, larkAppId: string, senderOpenId: string | undefined): boolean {
  if (!senderOpenId) return false;
  for (const openId of readBotOpenIdCrossRef(dataDir, larkAppId).values()) {
    if (openId === senderOpenId) return true;
  }
  return false;
}

/**
 * Should a FOREIGN bot sender be trusted to collaborate (route/spawn a session)
 * WITHOUT `/grant`, because it's a teammate? Two trust sources, both rooted in
 * tenant-stable identity or team-controlled group membership — never a name:
 *
 *  1. **Learned teammate** — its `union_id` (from the inbound event's
 *     `sender.sender_id.union_id`) is in the team-bot store, i.e. we've seen it
 *     vouched inside a team-assembled group before. Honoured in ANY chat.
 *  2. **Team-assembled group** — the chat itself is a 拉群 group (team-controlled
 *     membership), so a botmux bot speaking there is a vouched teammate even on
 *     first contact (mirrors the existing oncall-chat exemption).
 *
 * `isKnownPeerBot` (same-deployment siblings) is checked separately by callers;
 * this covers cross-deployment TEAM peers. Returns false when neither holds, so
 * the caller falls back to the /grant request card.
 *
 * 平台团队与旧版联邦团队同权：isPlatformTeamBot（平台 team-sync 下发的团队 bot
 * union_id roster）与 isTeamBot（团队群里学来的 union_id）都是 union_id 锚定的
 * bot 专属信任；平台拉的团队群则经 platform: 前缀镜像进 team-groups，走同一个
 * isTeamGroupChat。两条路都算团队模式，都不需要 /grant。
 */
export function isTrustedTeamBotSender(
  dataDir: string,
  chatId: string | undefined,
  senderUnionId: string | undefined,
): boolean {
  return isTeamBot(dataDir, senderUnionId)
    || isPlatformTeamBot(dataDir, senderUnionId)
    || isTeamGroupChat(dataDir, chatId);
}

/** Update the per-bot cross-reference from @mention data in an event.
 *  mentionsList comes from Lark event message.mentions array. */
export function updateBotOpenIdCrossRef(
  dataDir: string,
  larkAppId: string,
  mentionsList: Array<{ name?: string; id?: { open_id?: string } | string; id_type?: string }>,
): void {
  if (!mentionsList || mentionsList.length === 0) return;

  // Read known bot names from bots-info.json
  const knownBotNames = new Set<string>();
  try {
    const infoPath = join(dataDir, 'bots-info.json');
    if (existsSync(infoPath)) {
      const entries: Array<{ botName: string | null }> = JSON.parse(readFileSync(infoPath, 'utf-8'));
      for (const e of entries) {
        if (e.botName) knownBotNames.add(e.botName.toLowerCase());
      }
    }
  } catch { /* ignore */ }
  if (knownBotNames.size === 0) return;

  // Read existing cross-reference
  const fp = join(dataDir, `bot-openids-${larkAppId}.json`);
  let existing: Record<string, string> = {};
  try {
    if (existsSync(fp)) existing = JSON.parse(readFileSync(fp, 'utf-8'));
  } catch { /* ignore */ }

  // Update with new mentions that match known bot names
  let changed = false;
  for (const m of mentionsList) {
    const name = m.name;
    const openId = mentionOpenId(m);
    if (!name || !openId) continue;
    if (!knownBotNames.has(name.toLowerCase())) continue;
    if (existing[name] === openId) continue;
    existing[name] = openId;
    changed = true;
  }

  if (changed) {
    try {
      if (!existsSync(dataDir)) mkdirSync(dataDir, { recursive: true });
      atomicWriteFileSync(fp, JSON.stringify(existing, null, 2) + '\n');
      logger.debug(`Updated bot open_id cross-ref for ${larkAppId}: ${JSON.stringify(existing)}`);
    } catch (err) {
      logger.debug(`Failed to write bot open_id cross-ref: ${err}`);
    }
  }
}

// ─── /introduce collaboration handshake ──────────────────────────────────
//
// 用户在群里发 `@A @B /introduce`（顺序任意，带不带额外文本都行），每个被
// @ 的 bot 的 daemon 都会收到一份相同的 mentions[]，里面自带每个被 @ 实体
// 的 (open_id, name)。我们把这些登记进按 chatId 分文件的 observed-bots-store，
// 后续 `botmux bots list` / `<available_bots>` 就能感知到非本机 daemon 启动
// 的协作 bot，并能 @ 回去。
//
// 飞书没有任何公开接口能列出群里 bot 的 open_id（chat-members/get 明文跳过
// bot 成员），这是当前条件下能拿到陌生 bot open_id 的唯一可靠路径。

/** Command-position match: after stripping leading @mentions, the remaining
 *  text must begin with `/introduce` (optionally followed by whitespace).
 *  This is the same approach `parseForceTopicInvocation` takes for /t /topic.
 *  Stricter than a bare token match — "please run /introduce" or similar
 *  quoted/explanatory text won't trigger. */
export const INTRODUCE_RE = /^\/introduce(?:\s|$)/i;

/**
 * If `message` is a /introduce command, side-effect it (record observed bots
 * + send ack) and return `true` so the caller skips normal CLI routing.
 *
 * /introduce 不需要任何授权：它只是把群里别的 bot 记进花名册（observed），不授予
 * 任何对话/操作权，所以群里任何人都能用（与 /grant 的 owner 强闸门相反）。
 *
 * Consumed without side effects (still returns true) when:
 * - mentions[] minus self is empty — nothing to learn, ignore quietly
 *
 * Writes ALL mentions including self to the store. Each receiving bot's
 * daemon owns its own per-observer file (see observed-bots-store), so the
 * self entry is the only authoritative record of this app's own open_id
 * in the per-observer view — useful for `botmux bots list` self-identification.
 */
export async function tryHandleIntroduceCommand(
  larkAppId: string,
  message: any,
  senderOpenId: string | undefined,
): Promise<boolean> {
  const text = extractMessageTextForRouting(message);
  if (!text) return false;
  // Strip leading @<mention> tokens (using the message's mentions list to
  // tolerate names with spaces) before checking the command position.
  const stripped = stripLeadingMentions(text.trim(), message?.mentions ?? []);
  if (!INTRODUCE_RE.test(stripped)) return false;
  logger.debug(`[${larkAppId}] /introduce from ${senderOpenId ?? 'unknown'} (no auth required)`);

  if (grantCommandRestriction(larkAppId, message.chat_id, senderOpenId).blocked) {
    const loc = localeForBot(larkAppId);
    await replyMessage(larkAppId, message.message_id, JSON.stringify({
      text: t('cmd.grant_restricted', { cmd: '/introduce' }, loc),
    })).catch(err => logger.debug(`introduce grant_restricted reply failed: ${err}`));
    return true;
  }

  const selfOpenId = getBot(larkAppId).botOpenId;
  const rawMentions: Array<{ name?: string; id?: { open_id?: string } | string; id_type?: string }> = message.mentions ?? [];
  const all = rawMentions
    .map(m => ({ openId: mentionOpenId(m) ?? '', name: m.name ?? '' }))
    .filter(m => m.openId && m.name);
  const hasExternal = all.some(m => m.openId !== selfOpenId);
  if (!hasExternal) {
    logger.debug(`[${larkAppId}] /introduce ignored: no external bot in mentions`);
    return true;
  }

  const chatId = message.chat_id as string;
  // 查通讯录剔除真人：花名册只收 bot——真人混进去会污染 <available_bots> 误导模型，
  // 且不必再「靠人自觉」只 @ bot。self 始终保留（它是本 app open_id 的权威自记录）。
  // 缺 contact 读权限时 isHumanOpenId 一律返回 false → 退回「全部登记」旧行为（见其注释）。
  const humanFlags = await Promise.all(
    all.map(m => (m.openId === selfOpenId ? Promise.resolve(false) : isHumanOpenId(larkAppId, m.openId).catch(() => false))),
  );
  const bots = all.filter((_, i) => !humanFlags[i]);
  try {
    // Persist to the observer-scoped store: these open_ids are scoped to the
    // receiving app (larkAppId), so they're correct for THIS daemon to use
    // when @-mentioning back.
    recordObservedBots(config.session.dataDir, larkAppId, chatId, bots, 'introduce');
  } catch (err) {
    logger.warn(`[${larkAppId}] /introduce: failed to persist observed bots: ${err}`);
  }

  const externalBots = bots.filter(m => m.openId !== selfOpenId);
  const ackText = externalBots.length
    ? `✅ 已认识本群 ${externalBots.length} 个伙伴：${externalBots.map(m => `@${m.name}`).join(' ')}`
    : `ℹ️ 没有可登记的机器人（/introduce 只登记机器人，@ 的若是真人会被忽略）`;
  try {
    await replyMessage(larkAppId, message.message_id, ackText);
  } catch (err) {
    logger.warn(`[${larkAppId}] /introduce ack failed: ${err}`);
  }
  return true;
}
