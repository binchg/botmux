/** 普通群按钮的按机器人、按群覆盖配置；未设置时保留已有全局策略。 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { config } from '../config.js';
import { getBot } from '../bot-registry.js';
import { withFileLock } from '../utils/file-lock.js';
import { resolveRegularGroupMode } from './chat-reply-mode-store.js';

export interface RegularGroupSettings { sync: boolean; reuse: boolean }
type Entries = Record<string, Partial<RegularGroupSettings>>;

/** 使用数组编码身份，避免不同机器人和群的组合发生键冲突。 */
function key(appId: string, chatId: string): string { return JSON.stringify([appId, chatId]); }
function path(): string { return join(config.session.dataDir, 'regular-group-settings.json'); }

/** 缺少配置代表沿用旧行为；损坏配置不能在写入时被静默覆盖。 */
function read(): Entries {
  try {
    const entries = JSON.parse(readFileSync(path(), 'utf8'));
    if (!entries || typeof entries !== 'object' || Array.isArray(entries)) throw new Error('Invalid group settings');
    return entries;
  } catch (error: any) {
    if (error.code === 'ENOENT') return {};
    throw error;
  }
}

/** 每次读取磁盘，使不同发送进程及重启后的配置立即一致。 */
export function regularGroupOverrides(appId: string, chatId: string): Partial<RegularGroupSettings> {
  try { return read()[key(appId, chatId)] ?? {}; }
  catch { return {}; } // 读取失败不阻断既有消息；写入仍严格拒绝覆盖损坏配置。
}

/** 展示实际生效状态，兼容关闭主人续聊但仍采用旧群会话策略的配置。 */
export function regularGroupSettings(appId: string, chatId: string): RegularGroupSettings {
  const bot = getBot(appId).config;
  const overrides = regularGroupOverrides(appId, chatId);
  return {
    sync: overrides.sync ?? bot.regularGroupFinalToChat === true,
    reuse: overrides.reuse ?? (bot.regularGroupOwnerContinuation !== false
      || resolveRegularGroupMode(appId, chatId) !== 'new-topic'),
  };
}

/** 写明确目标值而非翻转，重复回调幂等；锁内合并其它群及另一个开关。 */
export async function setRegularGroupSetting(
  appId: string, chatId: string, field: keyof RegularGroupSettings, enabled: boolean,
): Promise<void> {
  mkdirSync(config.session.dataDir, { recursive: true });
  await withFileLock(path(), async () => {
    const entries = read();
    entries[key(appId, chatId)] = { ...entries[key(appId, chatId)], [field]: enabled };
    const temporary = `${path()}.tmp.${process.pid}`;
    writeFileSync(temporary, JSON.stringify(entries) + '\n', { mode: 0o600 });
    renameSync(temporary, path());
  });
}
