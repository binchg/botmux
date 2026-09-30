/** 平级会话交接账本；原子记录接手关系，不保存任务正文或继承父子角色。 */
import { existsSync, mkdirSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { config } from '../config.js';
import { createHash } from 'node:crypto';
import { atomicWriteFileSync } from '../utils/atomic-write.js';
import type { Session } from '../types.js';

export interface SessionHandoff {
  sourceSessionId: string;
  targetSessionId: string;
  larkAppId: string;
  sourceRootMessageId: string;
  sourceMessageIds: string[];
  createdAt: string;
}

/** 每次回读磁盘，确保 CLI、daemon 和重启后的补发使用相同停用事实。 */
export function listSessionHandoffs(dataDir = config.session.dataDir): SessionHandoff[] {
  const folder = join(dataDir, 'session-handoffs');
  if (!existsSync(folder)) return [];
  return readdirSync(folder).filter(name => /^[a-f0-9]{64}\.json$/.test(name))
    .map(name => JSON.parse(readFileSync(join(folder, name), 'utf8')) as SessionHandoff);
}

/** 同源交接只能指向同一接手会话；提交账本后迟到消息立即失去投递资格。 */
export function recordSessionHandoff(source: Session, target: Session, now = new Date()): SessionHandoff {
  const records = listSessionHandoffs();
  const previous = records.find(item => item.sourceSessionId === source.sessionId);
  if (previous) {
    if (previous.targetSessionId !== target.sessionId) throw new Error('handoff_target_conflict');
    return previous;
  }
  if (records.some(item => item.sourceSessionId === target.sessionId)) throw new Error('handoff_target_retired');
  const record: SessionHandoff = {
    sourceSessionId: source.sessionId, targetSessionId: target.sessionId,
    larkAppId: source.larkAppId!, sourceRootMessageId: source.rootMessageId,
    sourceMessageIds: [source.rootMessageId, source.quoteTargetId, source.streamCardId, source.progressCardId,
      source.currentReplyTarget?.rootMessageId,
      ...Object.keys(source.replyThreadAliases ?? {})].filter((id): id is string => !!id),
    createdAt: now.toISOString(),
  };
  // 每个交出会话单独写文件，避免不同 bot 的 daemon 并发交接覆盖彼此账本。
  const folder = join(config.session.dataDir, 'session-handoffs');
  mkdirSync(folder, { recursive: true, mode: 0o700 });
  const file = createHash('sha256').update(source.sessionId).digest('hex') + '.json';
  atomicWriteFileSync(join(folder, file), JSON.stringify(record, null, 2), { mode: 0o600 });
  return record;
}

/** 恢复时先停用交出会话；接手方移除旧会话的编排角色并保持独立身份。 */
export function applySessionHandoff(session: Session, records = listSessionHandoffs()): void {
  for (const record of records) {
    if (record.sourceSessionId === session.sessionId) {
      session.status = 'closed';
      session.closedAt ??= record.createdAt;
      delete session.agentTeam;
    } else if (record.targetSessionId === session.sessionId
      && session.agentTeam?.leaderSessionId === record.sourceSessionId) {
      delete session.agentTeam;
    }
  }
}

/** 仅从所属 bot 的会话文件解析消息归属，不读取其它机器人的正文。 */
export function readReplySessions(larkAppId: string): Session[] {
  const folder = config.session.dataDir;
  if (!existsSync(folder)) return [];
  const files = readdirSync(folder).filter(name => name === `sessions-${larkAppId}.json` || name === 'sessions.json');
  return files.flatMap(name => Object.values(JSON.parse(readFileSync(join(folder, name), 'utf8'))) as Session[])
    .filter(session => session.larkAppId === larkAppId);
}
