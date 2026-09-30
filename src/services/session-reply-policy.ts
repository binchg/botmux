/** 所有会话使用同一出站停用门禁，覆盖 SDK 即时回复、HTTP 降级和持久补发。 */
import { listSessionHandoffs, readReplySessions } from './session-handoff-store.js';
import type { OutboundRequest } from './lark-reply-outbox.js';
import { isAgentTeamMachineOutput } from './agent-team-output-filter.js';
import { parseAgentTeamResult } from './agent-team-store.js';

/** 有意停用的回复属于本地抑制，不属于鉴权失败或人工处理阻塞。 */
export class SessionReplySuppressedError extends Error {
  readonly code = 'BOTMUX_SESSION_RETIRED';
  readonly __botmuxReplySuppressed = true;
  constructor() { super('Session reply suppressed after peer handoff'); }
}

/** 每次发送前核对账本；已交出的话题不改投、不生成替代通知。 */
export function assertSessionReplyAllowed(request: OutboundRequest, larkAppId: string): void {
  const records = listSessionHandoffs().filter(item => item.larkAppId === larkAppId);
  if (!records.length) return;
  const path = new URL(request.url ?? '/', 'https://open.feishu.cn').pathname;
  const messageId = /\/im\/v1\/messages\/([^/]+)(?:\/reply)?$/.exec(path)?.[1];
  if (!messageId) return;
  const target = decodeURIComponent(messageId);
  if (records.some(item => item.sourceMessageIds.includes(target))) throw new SessionReplySuppressedError();
  // 流卡片及引用回复会使用根消息以外的 ID；按已持久化的会话字段补齐归属。
  for (const session of readReplySessions(larkAppId)) {
    if (!records.some(item => item.sourceSessionId === session.sessionId)) continue;
    const fields = session as unknown as Record<string, unknown>;
    if (Object.entries(fields).some(([key, value]) => /(?:MessageId|CardId|TargetId)$/.test(key) && value === target)) {
      throw new SessionReplySuppressedError();
    }
  }
}

/** 已经运行的旧 Team turn 可自然结束；接手话题只显示其校验后的摘要。 */
export function peerHandoffContent(content: string, messageId: string | undefined, larkAppId: string): string {
  const targets = new Set(listSessionHandoffs().filter(item => item.larkAppId === larkAppId).map(item => item.targetSessionId));
  if (!targets.size || !messageId) return content;
  if (!readReplySessions(larkAppId).some(session => targets.has(session.sessionId)
    && session.rootMessageId === messageId)) return content;
  /** 递归卡片和 text 的正文；严格的机器结果不作为人类消息原样泄露。 */
  function humanValue(value: unknown): unknown {
    if (typeof value === 'string' && isAgentTeamMachineOutput(value)) {
      const parsed = parseAgentTeamResult(value);
      if (!parsed.ok) throw new Error('handoff_result_invalid');
      return parsed.result.summary;
    }
    if (Array.isArray(value)) return value.map(humanValue);
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, humanValue(item)]));
    return value;
  }
  let parsed: unknown;
  try { parsed = JSON.parse(content); } catch { return content; }
  return JSON.stringify(humanValue(parsed));
}
