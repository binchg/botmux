/** 平台提及结构解析与目标机器人匹配；由 event-dispatcher.ts 拆分，来源 c397c9af。 */
import { getBot } from '../../bot-registry.js';
import { logger } from '../../utils/logger.js';
import { tag } from './card-action-session-helpers.js';
import { mentionOpenId } from './message-parser.js';

export let warnedStringMentionShape = false;

/** Check if the bot was @mentioned in this message */
export function isBotMentioned(larkAppId: string, message: any, _senderOpenId: string | undefined): boolean {
  const botOpenId = getBot(larkAppId).botOpenId;
  if (!botOpenId) {
    // Startup race: events can arrive before probeBotOpenId() resolves the
    // per-bot open_id. Subsequent events succeed once the probe completes,
    // so this is not a real warning — drop to debug to keep error.log clean.
    logger.debug(`[${larkAppId}] Bot open_id not yet known, skipping @mention check`);
    return false;
  }

  // 1. Check message.mentions array (populated for user-sent text messages).
  //    mentionOpenId() tolerates both the WS event object shape and the REST
  //    string shape, so a Lark mention-shape change can't silently break
  //    @-detection (which would make the bot ignore every @ with no error).
  const mentions: any[] = message.mentions ?? [];
  // Early-warning: today's WS events carry mention.id as an object; the REST
  // API carries a bare string. A string-form id on the event path means Lark
  // has converged the event onto the REST shape — surface it (once) so a silent
  // @-routing regression announces itself even though mentionOpenId absorbs it.
  if (!warnedStringMentionShape && mentions.some((m: any) => typeof m?.id === 'string')) {
    warnedStringMentionShape = true;
    logger.warn(`[${larkAppId}] mention.id arrived in string form on the event path — Lark may have converged the WS event onto the REST shape. mentionOpenId() absorbs it, but verify group @-routing. (logged once per process)`);
  }
  if (mentions.some((m: any) => mentionMatchesBot(m, larkAppId, botOpenId))) {
    return true;
  }

  // 2. Check post content for inline at tags (bot-sent post messages may not
  //    populate message.mentions — the @mention is embedded in the content structure)
  try {
    const content = JSON.parse(message.content ?? '{}');
    const inner = content.zh_cn ?? content.en_us ?? content;
    if (Array.isArray(inner?.content)) {
      for (const paragraph of inner.content) {
        if (!Array.isArray(paragraph)) continue;
        for (const node of paragraph) {
          if (node.tag === 'at' && node.user_id === botOpenId) return true;
        }
      }
    }
  } catch { /* ignore parse errors */ }

  return false;
}

/** Does this message @mention a *specific other member* (a person or bot that
 *  is NOT this bot)? Used by the 'ambient' mention policy to decide whether to
 *  back off: under 'ambient' the bot answers un-@ messages, but if the user
 *  explicitly addresses SOMEONE ELSE it stays quiet (the redirect carve-out).
 *  `@all` addresses everyone including this bot, so it is NOT an "other member"
 *  and does NOT trigger backoff. Mirrors isBotMentioned's two shapes:
 *  message.mentions[] (user text) and inline `at` nodes in post content. */
export function mentionsAnotherMember(larkAppId: string, message: any): boolean {
  const botOpenId = getBot(larkAppId).botOpenId;

  // 1. message.mentions array (populated for user-sent text messages)
  const mentions: any[] = message.mentions ?? [];
  for (const m of mentions) {
    // mentionOpenId() tolerates both the WS event object shape ({ open_id }) and
    // the REST bare-string shape (a bot @ is a "cli_…" string). A naked
    // m.id.open_id silently misses the string form → the redirect carve-out
    // breaks and the ambient bot keeps answering instead of backing off.
    const oid = mentionOpenId(m);
    if (!oid) continue;
    if (oid === botOpenId) continue; // that's me
    if (oid === 'all') continue;     // @all → everyone incl. me
    return true;                     // a specific other member
  }

  // 2. inline `at` nodes in post content (bot-sent / rich messages)
  try {
    const content = JSON.parse(message.content ?? '{}');
    const inner = content.zh_cn ?? content.en_us ?? content;
    if (Array.isArray(inner?.content)) {
      for (const paragraph of inner.content) {
        if (!Array.isArray(paragraph)) continue;
        for (const node of paragraph) {
          if (node.tag !== 'at') continue;
          const uid: string | undefined = node.user_id;
          if (!uid || uid === botOpenId || uid === 'all') continue;
          return true;
        }
      }
    }
  } catch { /* ignore parse errors */ }

  return false;
}

export function mentionMatchesBot(m: any, larkAppId: string, botOpenId?: string): boolean {
  const openId = mentionOpenId(m);
  if (botOpenId && openId === botOpenId) return true;

  // Some Lark event payloads identify bot mentions by app_id:
  //   { id_type: "app_id", id: "cli_xxx" }
  // Treat that as an explicit mention of this daemon, but do not let app_id
  // flow through mentionOpenId(), which is persisted and used as an open_id.
  const appId = mentionAppId(m);
  return Boolean(larkAppId && appId === larkAppId);
}

export function mentionIdType(m: any): string | undefined {
  if (!m || typeof m !== 'object') return undefined;
  if (typeof m.id_type === 'string') return m.id_type;
  if (typeof m.idType === 'string') return m.idType;
  return undefined;
}

export function mentionAppId(m: any): string | undefined {
  if (!m || typeof m !== 'object') return undefined;
  if (typeof m.appId === 'string') return m.appId;
  if (typeof m.app_id === 'string') return m.app_id;
  const idType = mentionIdType(m);
  if (idType === 'app_id' && typeof m.id === 'string') return m.id;
  if (m.id && typeof m.id === 'object' && typeof m.id.app_id === 'string') return m.id.app_id;
  return undefined;
}
