/** 机器人身份回读与启动竞态保护；由 event-dispatcher.ts 拆分，来源 c397c9af。 */
import { getBot, getAllBots } from '../../bot-registry.js';
import { join } from 'node:path';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { config } from '../../config.js';
import { atomicWriteFileSync } from '../../utils/atomic-write.js';
import { larkHosts, normalizeBrand } from './lark-hosts.js';
import { logger } from '../../utils/logger.js';

export function setBotOpenId(larkAppId: string, id: string): void {
  getBot(larkAppId).botOpenId = id;
}

/** Persist bot registry info to disk for agent-facing CLI subcommands to read.
 *  Merges current process's bot(s) into the existing file so that
 *  multiple daemon processes (one per bot) don't overwrite each other. */
export function writeBotInfoFile(dataDir: string): void {
  const filePath = join(dataDir, 'bots-info.json');
  if (!existsSync(dataDir)) mkdirSync(dataDir, { recursive: true });

  // Read existing entries from other daemon processes
  type BotInfoEntry = { larkAppId: string; botOpenId: string | null; botName: string | null; botAvatarUrl: string | null; cliId: string };
  let existing: BotInfoEntry[] = [];
  try {
    if (existsSync(filePath)) {
      existing = JSON.parse(readFileSync(filePath, 'utf-8'));
    }
  } catch { /* ignore corrupt file */ }

  // Build a map keyed by larkAppId, start with existing entries
  const map = new Map<string, BotInfoEntry>();
  for (const entry of existing) {
    if (entry.larkAppId) map.set(entry.larkAppId, entry);
  }

  // Upsert current process's bot(s)
  for (const b of getAllBots()) {
    map.set(b.config.larkAppId, {
      larkAppId: b.config.larkAppId,
      botOpenId: b.botOpenId ?? null,
      botName: b.botName ?? null,
      botAvatarUrl: b.botAvatarUrl ?? null,
      cliId: b.config.cliId,
    });
  }

  // 原子写：一 bot 一 daemon，多个 daemon 进程并发 upsert 同一个 bots-info.json，
  // 裸写会让并发读者看到半截 JSON。（read-merge-write 的 lost-update 仍存在，
  // 但每个 daemon 周期性重写自己的条目，可自愈。）
  atomicWriteFileSync(filePath, JSON.stringify([...map.values()], null, 2) + '\n');
}

/**
 * Probe the bot's own open_id at startup via the Lark bot info API.
 */
/** Per-app in-flight open_id probe, so a startup burst of events shares one probe. */
export const inflightOpenIdProbes = new Map<string, Promise<void>>();

/**
 * Ensure the bot's own open_id is resolved before @-detection. `probeBotOpenId`
 * is fired fire-and-forget at daemon startup, so events can arrive while
 * `botOpenId` is still undefined — `isBotMentioned` then can't recognize an @ as
 * ours and silently drops it. The WSClient still ACKs that dropped event, so
 * Lark never redelivers it (the @ is lost until manually re-sent). Awaiting the
 * deduped probe here closes that window: concurrent events share one probe, and
 * each is held only until the open_id lands, then processed normally.
 */
export function ensureBotOpenId(larkAppId: string): Promise<void> {
  if (getBot(larkAppId).botOpenId) return Promise.resolve();
  let inflight = inflightOpenIdProbes.get(larkAppId);
  if (!inflight) {
    inflight = probeBotOpenId(larkAppId).finally(() => inflightOpenIdProbes.delete(larkAppId));
    inflightOpenIdProbes.set(larkAppId, inflight);
  }
  return inflight;
}

export async function probeBotOpenId(larkAppId: string): Promise<void> {
  const bot = getBot(larkAppId);
  if (bot.botOpenId) return; // already known

  const openApi = larkHosts(normalizeBrand(bot.config.brand)).openApi;

  // Call /bot/v3/info to get the bot's open_id using tenant_access_token
  const tokenRes = await fetch(`${openApi}/open-apis/auth/v3/tenant_access_token/internal`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ app_id: bot.config.larkAppId, app_secret: bot.config.larkAppSecret }),
  });
  const tokenData = await tokenRes.json() as any;
  if (tokenData.code !== 0) {
    throw new Error(`Failed to get tenant_access_token: ${tokenData.msg}`);
  }

  const botRes = await fetch(`${openApi}/open-apis/bot/v3/info/`, {
    headers: { Authorization: `Bearer ${tokenData.tenant_access_token}` },
  });
  const botData = await botRes.json() as any;
  if (botData.code !== 0) {
    throw new Error(`Failed to get bot info: ${botData.msg}`);
  }

  const openId = botData.bot?.open_id;
  const appName = botData.bot?.app_name;
  const avatarUrl = botData.bot?.avatar_url;
  if (openId) {
    bot.botOpenId = openId;
    if (appName) bot.botName = appName;
    if (avatarUrl) bot.botAvatarUrl = avatarUrl;
    logger.info(`Bot open_id: ${bot.botOpenId}`);
  } else {
    throw new Error('No open_id in bot info response');
  }
}
