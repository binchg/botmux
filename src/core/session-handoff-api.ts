/** 平级会话交接 API：先落停用事实，再脱离旧编排关系，最后关闭交出方。 */
import { config } from '../config.js';
import * as sessions from '../services/session-store.js';
import { closeAgentTeam, listAgentTeams } from '../services/agent-team-store.js';
import { applySessionHandoff, listSessionHandoffs, recordSessionHandoff } from '../services/session-handoff-store.js';
import { closeSession, findActiveBySessionId } from './worker-pool.js';
import { ipcRoute, jsonRes, readJsonBody } from './dashboard-ipc-server.js';

let registered = false;

/** 同 bot 同 owner 的两个独立会话可平级交接；失败前不改变运行身份。 */
export async function handoffSession(sourceId: string, targetId: string, larkAppId: string) {
  const source = sessions.getSession(sourceId);
  const target = sessions.getSession(targetId);
  if (!source || !target) throw new Error('handoff_session_not_found');
  if (sourceId === targetId) throw new Error('handoff_same_session');
  if (source.larkAppId !== larkAppId || target.larkAppId !== larkAppId) throw new Error('handoff_bot_mismatch');
  const sourceOwner = source.ownerUnionId ?? source.ownerOpenId;
  const targetOwner = target.ownerUnionId ?? target.ownerOpenId;
  if (!sourceOwner || sourceOwner !== targetOwner) throw new Error('handoff_owner_mismatch');
  const previous = listSessionHandoffs().find(item => item.sourceSessionId === sourceId);
  if (!previous && source.status !== 'active') throw new Error('handoff_source_inactive');
  if (target.status !== 'active') throw new Error('handoff_target_inactive');
  if (source.scope === 'chat' || target.scope === 'chat') throw new Error('handoff_requires_independent_threads');
  if (source.rootMessageId === target.rootMessageId) throw new Error('handoff_requires_independent_threads');
  const teams = listAgentTeams(config.session.dataDir, { leaderSessionId: sourceId, larkAppId })
    .filter(team => team.status === 'active');
  if (teams.some(team => team.workers.some(worker => worker.sessionId !== targetId
    && !['succeeded', 'reported', 'failed', 'interrupted', 'superseded', 'closed'].includes(worker.status)))) {
    throw new Error('handoff_has_other_live_dependents');
  }
  const handoff = recordSessionHandoff(source, target);
  // 关闭 Team 只停编排，不杀接手 runner，也不删除 revision/attempt/outbox 审计。
  for (const team of teams) closeAgentTeam(config.session.dataDir, team.teamId);
  applySessionHandoff(target);
  sessions.updateSession(target);
  const liveTarget = findActiveBySessionId(targetId);
  if (liveTarget) applySessionHandoff(liveTarget.session);
  await closeSession(sourceId);
  applySessionHandoff(source);
  sessions.updateSession(source);
  return { ok: true, relationship: 'peer', sourceSessionId: sourceId, targetSessionId: targetId,
    sourceReplyEnabled: false, targetReplyEnabled: true, handoff };
}

/** 由 daemon 出站运行时安装，复用既有 IPC 路由和同 bot 隔离身份。 */
export function registerSessionHandoffApi(larkAppId: string): void {
  if (registered) return;
  registered = true;
  ipcRoute('POST', '/api/sessions/:sessionId/handoff', async (req, res, params) => {
    try {
      const body = await readJsonBody<{ targetSessionId?: string }>(req);
      if (typeof body.targetSessionId !== 'string') throw new Error('handoff_target_required');
      jsonRes(res, 200, await handoffSession(params.sessionId, body.targetSessionId, larkAppId));
    } catch (error) {
      jsonRes(res, 409, { ok: false, error: error instanceof Error ? error.message : 'handoff_failed' });
    }
  });
}
