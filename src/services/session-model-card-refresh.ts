/** 定向补齐即时卡模型信息，沿用原有串行 PATCH 队列，不能复活或替换旧话题卡。 */
import { config } from '../config.js';
import { getBot } from '../bot-registry.js';
import { localeForBot } from '../i18n/index.js';
import { buildStreamingCard, getCliDisplayName } from '../im/lark/card-builder.js';
import { listActiveSessions, scheduleCardPatch, cardUsageLimit, writableTerminalLinkFor, CARD_POSTING_SENTINEL } from '../core/worker-pool.js';
import { sessionAnchorId } from '../core/types.js';
import { buildTerminalUrl } from '../core/terminal-url.js';
import { sessionModelCardNeedsRefresh } from './session-model-card-status.js';
import { logger } from '../utils/logger.js';
import { sessionCardStatisticsNeedsRefresh } from './session-card-statistics.js';

const started = new Set<string>();

/** 每十五秒最多补三张变化的卡；无变化、已关闭、私有卡或在途 PATCH 均不发送。 */
export function refreshSessionModelCards(appId: string): number {
  let count = 0;
  for (const ds of listActiveSessions()) {
    if (count >= 3) break;
    const bot = getBot(appId).config;
    if (ds.larkAppId !== appId || ds.session.status !== 'active' || ds.adoptedFrom
      || (ds.session.cliId ?? bot.cliId) !== 'codex-app' || !ds.streamCardId
      || ds.streamCardId === CARD_POSTING_SENTINEL || ds.streamCardPending || ds.cardPatchInFlight || ds.pendingCardJson
      || !(ds.workerPort ?? ds.session.webPort)
      || (!ds.streamingCardForced && (bot.disableStreamingCard || bot.privateCard || (ds.chatId && bot.noCardChats?.includes(ds.chatId))))) continue;
    const key = ds.streamCardNonce || sessionAnchorId(ds);
    const locale = localeForBot(appId);
    if (!sessionModelCardNeedsRefresh(config.session.dataDir, ds.session.sessionId, key)
      && !sessionCardStatisticsNeedsRefresh(config.session.dataDir, ds.session.sessionId, locale, key)) continue;
    const card = buildStreamingCard(ds.session.sessionId, sessionAnchorId(ds), buildTerminalUrl(ds),
      ds.currentTurnTitle || ds.session.title || getCliDisplayName('codex-app'), ds.lastScreenContent ?? '',
      ds.lastScreenStatus ?? 'idle', 'codex-app', ds.displayMode ?? 'hidden', ds.streamCardNonce,
      ds.currentImageKey, false, false, locale, cardUsageLimit(ds), writableTerminalLinkFor(ds));
    scheduleCardPatch(ds, card);
    count++;
  }
  return count;
}

/** daemon 启动后延迟刷新，不阻塞首张卡或启动链路。 */
export function startSessionModelCardRefresh(appId: string): void {
  if (started.has(appId)) return;
  started.add(appId);
  setInterval(() => {
    try { refreshSessionModelCards(appId); }
    catch (error) { logger.debug(`Model card refresh deferred: ${error}`); }
  }, 15_000).unref();
}
