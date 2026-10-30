/** 按机器人保存群消息的直接 @ 门禁，独立于会话复用与免 @ 续聊策略。 */
import { mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { config } from '../config.js';
import { atomicWriteFileSync } from '../utils/atomic-write.js';
import { withFileLock } from '../utils/file-lock.js';

type Policy = boolean | { requireDirectMention: boolean; ownerTopicNoMentionChats: string[] };
type Policies = Record<string, Policy>;

/** 兼容旧布尔开关；新配置只允许按群声明主人话题免 @。 */
function isPolicy(value: unknown): value is Policy {
  if (typeof value === 'boolean') return true;
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const entry = value as Record<string, unknown>;
  return typeof entry.requireDirectMention === 'boolean'
    && Array.isArray(entry.ownerTopicNoMentionChats)
    && entry.ownerTopicNoMentionChats.every(chat => typeof chat === 'string' && !!chat.trim());
}

/** 配置位于运行数据目录，不进入源码或机器人凭据文件。 */
function policyPath(): string {
  return join(config.session.dataDir, 'group-direct-mention-policy.json');
}

/** 缺少文件沿用旧策略；损坏文件拒绝被写入覆盖。 */
function readPolicies(): Policies {
  try {
    const value = JSON.parse(readFileSync(policyPath(), 'utf8'));
    if (!value || typeof value !== 'object' || Array.isArray(value)
        || Object.values(value).some(entry => !isPolicy(entry))) {
      throw new Error('Invalid group direct mention policy');
    }
    return value;
  } catch (error: any) {
    if (error.code === 'ENOENT') return {};
    throw error;
  }
}

/** 每条消息读取最新策略；配置损坏时收紧为必须直接 @，避免意外开工。 */
export function requiresDirectGroupMention(appId: string): boolean {
  try {
    const entry = readPolicies()[appId];
    return typeof entry === 'boolean' ? entry : entry?.requireDirectMention === true;
  }
  catch { return true; }
}

/** 损坏或未配置时不放宽门禁；主人身份与真实群类型由消息入口另行核验。 */
export function allowsOwnerTopicWithoutMention(appId: string, chatId: string): boolean {
  try {
    const entry = readPolicies()[appId];
    return typeof entry === 'object' && entry.requireDirectMention
      && entry.ownerTopicNoMentionChats.includes(chatId);
  } catch { return false; }
}

/** 锁内仅修改指定机器人的开关，原子落盘，下一条消息立即生效。 */
export async function setDirectGroupMention(appId: string, enabled: boolean): Promise<void> {
  if (!appId.trim() || typeof enabled !== 'boolean') throw new Error('Invalid group mention setting');
  mkdirSync(config.session.dataDir, { recursive: true });
  await withFileLock(policyPath(), async () => {
    const policies = readPolicies();
    const entry = policies[appId];
    policies[appId] = typeof entry === 'object' ? { ...entry, requireDirectMention: enabled } : enabled;
    atomicWriteFileSync(policyPath(), JSON.stringify(policies) + '\n', { mode: 0o600 });
  });
}

/** 原子更新指定群的主人免 @ 例外，同时保持普通群严格门禁和其它机器人配置。 */
export async function setOwnerTopicNoMention(appId: string, chatId: string, enabled: boolean): Promise<void> {
  if (!appId.trim() || !chatId.trim() || typeof enabled !== 'boolean') throw new Error('Invalid owner topic setting');
  mkdirSync(config.session.dataDir, { recursive: true });
  await withFileLock(policyPath(), async () => {
    const policies = readPolicies();
    const entry = policies[appId];
    const chats = new Set(typeof entry === 'object' ? entry.ownerTopicNoMentionChats : []);
    if (enabled) chats.add(chatId);
    else chats.delete(chatId);
    policies[appId] = { requireDirectMention: true, ownerTopicNoMentionChats: [...chats] };
    atomicWriteFileSync(policyPath(), JSON.stringify(policies) + '\n', { mode: 0o600 });
  });
}
