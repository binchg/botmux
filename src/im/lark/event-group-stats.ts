/** 群成员计数和有界缓存；由 event-dispatcher.ts 拆分，来源 c397c9af。 */
import { BoundedMap } from '../../utils/bounded-map.js';
import { getChatInfo } from './client.js';
import { logger } from '../../utils/logger.js';

export const CHAT_CACHE_TTL = 5 * 60_000; // 5 minutes
// Bounded: keyed per chat; TTL gates freshness on read, the cap stops the
// entry count growing with every distinct chat the bot ever serves.
export const chatStatsCache = new BoundedMap<string, { userCount: number; botCount: number; fetchedAt: number }>(1000);

// ─── Event callback ACK safety ──────────────────────────────────────────────
//
// The Lark WS SDK sends exactly one response frame per event and only AFTER the
// registered handler's promise resolves (WSClient.handleEventData: it awaits
// eventDispatcher.invoke, then sendMessage once). So that frame is the ACK: a
// slow handler delays it past Feishu's 3s budget and triggers a timeout re-push.
// The message path below can spend seconds on OpenAPI lookups + spawning a CLI,
// so we return synchronously and run the heavy work behind setImmediate — the
// handler resolves immediately, the ACK is prompt, and the work runs after.
//
// Dedupe: Feishu re-pushes an un-ACKed/non-200 event at 15s, 5min, 1h, 6h (max
// 4 retries), and its pipeline is at-least-once, so a duplicate can arrive even
// after a timely 200. Fast-ACK keeps us inside 3s so timeout-retries stop
// firing — the realistic duplicate is then a near-simultaneous at-least-once
// copy, which a short-lived claim per stable event key suppresses. The TTL
// covers the 15s/5min/1h retry tiers with margin; the 6h tier is only reachable
// after a sustained ACK failure that fast-ACK prevents, so we don't size for it.
// (We claim-then-ack-success on purpose: a redelivery is always treated as a
//  duplicate, never as recovery — matching the prior swallow-and-ACK behavior.)
export async function getGroupStats(larkAppId: string, chatId: string): Promise<{ userCount: number; botCount: number }> {
  const cacheKey = `${larkAppId}:${chatId}`;
  const cached = chatStatsCache.get(cacheKey);
  if (cached && Date.now() - cached.fetchedAt < CHAT_CACHE_TTL) {
    return { userCount: cached.userCount, botCount: cached.botCount };
  }
  try {
    const info = await getChatInfo(larkAppId, chatId);
    chatStatsCache.set(cacheKey, { userCount: info.userCount, botCount: info.botCount, fetchedAt: Date.now() });
    return info;
  } catch (err) {
    // Soft failure — the fallback below assumes worst case (multi-user,
    // multi-bot → require @mention). No user-visible regression, so debug.
    logger.debug(`Failed to get chat stats for ${chatId}, using safe fallback: ${err}`);
    if (cached) return { userCount: cached.userCount, botCount: cached.botCount };
    // Fallback: assume multi-person, multi-bot → require @mention to be safe.
    return { userCount: 999, botCount: 999 };
  }
}
