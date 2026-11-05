/** 每个用户轮次前两条＋最后一条；daemon 自动消息与显式 send 共用预算。
 * 重选/429 继续不是用户轮次，不重置。预算只保存随机轮次和计数，不保存正文。 */
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { atomicWriteFileSync } from '../utils/atomic-write.js';
import { withFileLockSync } from '../utils/file-lock.js';
import { isAgentTeamMachineOutput } from './agent-team-output-filter.js';
import { withSessionModelDisplay, type SessionModelDisplay } from './session-model-display.js';

interface Budget { epoch: string; count: number }
const header = /^> \*\*(?:模型：)?(TraeX · [^\n]+)\*\*\n\n/u;
export function isTraexModelReply(content: string): boolean { return header.test(content); }
function budgetPath(dir: string, id: string): string {
  if (!id || id.length > 200) throw new Error('invalid_session_id');
  const root = join(dir, 'session-models');
  mkdirSync(root, { recursive: true, mode: 0o700 });
  return join(root, createHash('sha256').update(id).digest('hex') + '.reply-budget.json');
}
function read(path: string): Budget {
  try {
    const value = JSON.parse(readFileSync(path, 'utf8'));
    if (typeof value.epoch !== 'string' || !Number.isSafeInteger(value.count) || value.count < 0) throw new Error('invalid_reply_budget');
    return value;
  } catch (e: any) {
    if (e.code !== 'ENOENT') throw e;
    return { epoch: randomUUID(), count: 0 };
  }
}
export function beginSessionModelReplyEpoch(dir: string, id: string): void {
  const path = budgetPath(dir, id);
  withFileLockSync(path, () => atomicWriteFileSync(path,
    JSON.stringify({ epoch: randomUUID(), count: 0 }), { mode: 0o600 }));
}
/** 调用点须在重复/内部/终态抑制之后；final 永远显示，发送重试复用已建卡片。 */
export function formatSessionModelReply(dir: string, id: string, content: string,
  final = false, display: SessionModelDisplay | null = null): string {
  if (!content.trim() || isAgentTeamMachineOutput(content)) return content;
  const match = header.exec(content);
  if (!display && !match) return content;
  const body = match ? content.slice(match[0].length) : content;
  const labeled = display ? withSessionModelDisplay(body, display) : `> **${match![1]}**\n\n${body}`;
  const path = budgetPath(dir, id);
  return withFileLockSync(path, () => {
    const budget = read(path);
    const show = final || budget.count < 2;
    budget.count = Math.min(budget.count + 1, 3);
    atomicWriteFileSync(path, JSON.stringify(budget), { mode: 0o600 });
    return show ? labeled : body;
  });
}
