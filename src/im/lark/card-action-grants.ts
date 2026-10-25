/** 沙盒落盘与主人授权操作；由 card-handler.ts 拆分，来源 c397c9af。 */
import { CardActionContext, CARD_ACTION_UNHANDLED } from './card-action-context.js';
import { localeForBot, t } from '../../i18n/index.js';
import { getOwnerOpenId } from '../../bot-registry.js';
import { logger } from '../../utils/logger.js';
import { buildLandResultCard, buildGrantResultCard, buildGrantNotifyCard } from './card-builder.js';
import { computeSandboxDiff, applySandboxDiff } from '../../services/sandbox-land.js';
import { config } from '../../config.js';
import { checkNonce, markDenied, getPendingQuota, clearPending } from './grant-pending.js';
import { addGlobalGrant, addChatGrant } from '../../services/grant-store.js';
import { isHumanOpenId, getMessageDetail, replyMessage, deleteMessage } from './client.js';
import { recordObservedBots } from '../../services/observed-bots-store.js';
import { join } from 'node:path';

/** 沙盒落盘与主人授权操作；未命中时交给下一处理器。 */
export async function handleGrantActions(context: CardActionContext): Promise<any> {
  const { larkAppId, action, value, cardMessageId, operatorOpenId } = context;
  if (value?.action && (value.action === 'land_apply' || value.action === 'land_discard') && larkAppId) {
    const loc = localeForBot(larkAppId);
    const owner = getOwnerOpenId(larkAppId);
    if (!operatorOpenId || operatorOpenId !== owner) {
      logger.info(`Land action "${value.action}" blocked for non-owner: ${operatorOpenId}`);
      return { toast: { type: 'error', content: t('card.land.toast_owner_only', undefined, loc) } };
    }
    if (value.action === 'land_discard') {
      return JSON.parse(buildLandResultCard('discarded', '', loc));
    }
    const sid: string = value.sessionId;
    const wd: string = value.workingDir;
    if (!sid || !wd) return JSON.parse(buildLandResultCard('failed', t('card.land.stale', undefined, loc), loc));
    const d = computeSandboxDiff(config.session.dataDir, sid, loc);
    if (!d.ok) return JSON.parse(buildLandResultCard('failed', d.error, loc));
    if (d.empty) return JSON.parse(buildLandResultCard('discarded', '', loc));
    const a = applySandboxDiff(wd, config.session.dataDir, sid, loc);
    if (!a.ok) return JSON.parse(buildLandResultCard('failed', a.error, loc));
    logger.info(`Land applied: ${d.files} files (+${d.insertions}/-${d.deletions}) → ${wd}`);
    return JSON.parse(buildLandResultCard('applied', t('card.land.applied_body', { files: d.files, ins: d.insertions, del: d.deletions, dir: wd }, loc), loc));
  }
  // ─── 群内授权卡片动作（grant_chat / grant_global / grant_deny，talk-only）─────
  // 不绑定 session，必须在 session 解析之前处理。owner 强闸门 + nonce 校验。
  if (value?.action && (value.action === 'grant_chat' || value.action === 'grant_global' || value.action === 'grant_deny') && larkAppId) {
    const loc = localeForBot(larkAppId);
    const owner = getOwnerOpenId(larkAppId);
    // owner 强闸门：必须是当前 app 的 owner 本人（比 canOperate 更严）
    if (!operatorOpenId || operatorOpenId !== owner) {
      logger.info(`Grant action "${value.action}" blocked for non-owner: ${operatorOpenId}`);
      return { toast: { type: 'error', content: t('card.grant.toast_owner_only', undefined, loc) } };
    }
    // 一次 /grant 可带多个目标（多人/多 bot），共用一张卡 + 同一 nonce。
    // 兼容旧卡（重启前发出的单目标卡只带 target_open_id）：归一成数组。
    const targets: string[] = Array.isArray(value.target_open_ids)
      ? value.target_open_ids
      : (value.target_open_id ? [value.target_open_id] : []);
    const grantChatId = value.chat_id;
    const nonce = value.nonce;
    // 全部 target 都得仍 pending 且 nonce 匹配，否则视为整卡失效。
    if (!targets.length || !grantChatId || !nonce || !targets.every(tt => checkNonce(larkAppId, grantChatId, tt, nonce))) {
      return { toast: { type: 'error', content: t('card.grant.toast_expired', undefined, loc) } };
    }
    // 拒绝：只把卡更新成「已拒绝」+ 全部目标进 deny 冷却，绝不触碰 grant-store。
    // 返回原始卡 body，由 dispatcher 包成 in-place patch（不再走 updateMessage 双写）。
    if (value.action === 'grant_deny') {
      for (const tt of targets) markDenied(larkAppId, grantChatId, tt);
      return JSON.parse(buildGrantResultCard('deny', loc));
    }
    // 授权（talk-only）：grant_chat 写本群 chatGrants，grant_global 写全局 globalGrants，
    // 两者都绝不碰 allowedUsers（operate 只由 bots.json 配）。逐个落库，统计成功/失败。
    const kind = value.action === 'grant_global' ? 'global' as const : 'chat' as const;
    const names: string[] = Array.isArray(value.target_names) ? value.target_names : [];
    const idToName = new Map<string, string>();
    targets.forEach((tt, i) => idToName.set(tt, names[i] ?? ''));
    // 额度挂在 pending 上（/grant @x N 解析所得；多目标共用同一额度）；clearPending 前先读出来。
    const quota = getPendingQuota(larkAppId, grantChatId, targets[0]);
    const granted: string[] = [];
    const failed: Array<{ openId: string; reason: string }> = [];
    for (const tt of targets) {
      const res = kind === 'global'
        ? await addGlobalGrant(larkAppId, tt, quota)
        : await addChatGrant(larkAppId, grantChatId, tt, quota);
      if (res.ok) { clearPending(larkAppId, grantChatId, tt); granted.push(tt); }
      else { failed.push({ openId: tt, reason: res.reason }); logger.warn(`Grant action "${value.action}" store failed for ${tt}: ${res.reason}`); }
    }
    // 全部失败：保留 pending + 不撤卡（owner 可点原卡重试），toast 报错。
    if (granted.length === 0) {
      return { toast: { type: 'error', content: t('card.grant.toast_failed', { reason: failed[0]?.reason ?? 'unknown' }, loc) } };
    }
    // 部分成功：失败 target 的 pending 必须立刻清掉——卡马上要撤回（owner 无法再点原卡重试），
    // 而 pending 无 TTL，isThrottled 会永久挡住失败 target 后续的自助申请直到 daemon 重启。
    // 清掉后失败 target 可重新走 /grant 或自助申请；失败清单下面在原线程明确告知 owner，
    // 不做「撤卡 + 静默失败 + pending 永久卡住」。
    for (const f of failed) clearPending(larkAppId, grantChatId, f.openId);
    // 一次查通讯录判定哪些 grantee 是真人（vs bot），结果同时供下面两处复用：
    //   1. observed 花名册自动登记（只收 bot，剔真人）；
    //   2. 通知卡 @ 渲染（只 @ 真人，bot 用纯文本名字 —— 见下方注释）。
    // 缺 contact 读权限/查询瞬时失败 → 一律按 bot 处理（false）：登记侧沿用历史「全部登记」回退，
    // 通知侧则把对方当 bot 不 @（宁可少 @ 一次真人，也不误唤醒 bot 拉空会话）。
    const humanFlags = await Promise.all(granted.map(id => isHumanOpenId(larkAppId, id).catch(() => false)));
    // /grant @bot 成功后顺带把「bot」目标登记进 observed 花名册（等价内部跑一次 /introduce），
    // 授权 + 可点名一步到位。写的是 observed-bots-store（让本 daemon 能 @ 回对方），不影响
    // isKnownPeerBot 接收闸（那查的是 cross-ref，两套独立存储），零额外路由权。best-effort。
    // 真人**不**登记：查通讯录确认是真人就剔除，避免污染 <available_bots> 误导模型。
    try {
      const botEntries = granted
        .map((id, i) => ({ id, human: humanFlags[i] }))
        .filter(x => !x.human)
        .map(x => ({ openId: x.id, name: idToName.get(x.id) ?? '' }));
      const skipped = granted.length - botEntries.length;
      if (skipped > 0) logger.debug(`grant auto-introduce: skipped ${skipped} confirmed human target(s)`);
      if (botEntries.length > 0) {
        recordObservedBots(config.session.dataDir, larkAppId, grantChatId, botEntries, 'introduce');
      }
    } catch (err) {
      logger.warn(`grant auto-introduce (observed) failed (grant still applied): ${err}`);
    }
    // 通知卡的 grantee 渲染参数：bot 只用纯文本名字（不 <at>，否则唤醒对方 bot 误拉空会话），真人 @ 点名。
    const notifyTargets = granted.map((id, i) => ({ openId: id, name: idToName.get(id) || undefined, isBot: !humanFlags[i] }));
    // 授权成功后：
    //   1. 先同步返回 callback 响应（in-place patch 成「已授权」终态卡），避免飞书等待
    //      太久或 deleteMessage 与 callback 响应竞态导致客户端 300000 报错；
    //   2. 通知卡 + 部分失败告知 + 撤回原卡 走后台 fire-and-forget（不阻塞 callback）。
    const resultCardBody = JSON.parse(buildGrantResultCard(kind, loc));
    if (cardMessageId) {
      let replyInThread = true;
      try {
        const detail = await getMessageDetail(larkAppId, cardMessageId);
        const item = detail?.items?.[0];
        if (!item) throw new Error('no message item in getMessageDetail response');
        replyInThread = Boolean(item.thread_id);
      } catch (err) {
        logger.debug(`grant notify thread-mode probe failed, defaulting to thread reply: ${err}`);
      }
      // fire-and-forget: 通知卡 + 部分失败文字 + 撤回原卡
      Promise.resolve()
        .then(async () => {
          try {
            await replyMessage(larkAppId, cardMessageId, buildGrantNotifyCard(kind, notifyTargets, loc, quota), 'interactive', replyInThread);
          } catch (err) {
            logger.warn(`grant notify failed (grant still applied): ${err}`);
          }
          if (failed.length > 0) {
            const failNames = failed.map(f => idToName.get(f.openId) || f.openId).join('、');
            try {
              await replyMessage(larkAppId, cardMessageId, t('card.grant.partial_failed', { names: failNames }, loc), 'text', replyInThread);
            } catch (err) {
              logger.warn(`grant partial-failure notice failed: ${err}`);
            }
          }
          try {
            await deleteMessage(larkAppId, cardMessageId);
          } catch (err) {
            logger.debug(`grant card withdraw (post-callback) failed: ${err}`);
          }
        })
        .catch(err => logger.error(`grant post-callback background tasks failed: ${err}`));
    }
    return resultCardBody;
  }
  return CARD_ACTION_UNHANDLED;
}
