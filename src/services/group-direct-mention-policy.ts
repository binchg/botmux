/** 按机器人保存群消息的直接 @ 门禁，独立于会话复用与免 @ 续聊策略。 */
import { mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { config } from '../config.js';
import { atomicWriteFileSync } from '../utils/atomic-write.js';
import { withFileLock } from '../utils/file-lock.js';

type Policies = Record<string, boolean>;

/** 配置位于运行数据目录，不进入源码或机器人凭据文件。 */
function policyPath(): string {
  return join(config.session.dataDir, 'group-direct-mention-policy.json');
}

/** 缺少文件沿用旧策略；损坏文件拒绝被写入覆盖。 */
function readPolicies(): Policies {
  try {
    const value = JSON.parse(readFileSync(policyPath(), 'utf8'));
    if (!value || typeof value !== 'object' || Array.isArray(value)
        || Object.values(value).some(entry => typeof entry !== 'boolean')) {
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
  try { return readPolicies()[appId] === true; }
  catch { return true; }
}

/** 锁内仅修改指定机器人的开关，原子落盘，下一条消息立即生效。 */
export async function setDirectGroupMention(appId: string, enabled: boolean): Promise<void> {
  if (!appId.trim() || typeof enabled !== 'boolean') throw new Error('Invalid group mention setting');
  mkdirSync(config.session.dataDir, { recursive: true });
  await withFileLock(policyPath(), async () => {
    const policies = readPolicies();
    policies[appId] = enabled;
    atomicWriteFileSync(policyPath(), JSON.stringify(policies) + '\n', { mode: 0o600 });
  });
}
