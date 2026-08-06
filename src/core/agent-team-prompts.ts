/** 同 Bot 多会话团队的稳定提示契约；不包含运行态日志。 */
import type {
  AgentTeam,
  AgentTeamGuidanceRevision,
  AgentTeamReport,
  AgentTeamWorker,
} from '../services/agent-team-store.js';

function clean(value: string): string {
  return value.replace(/[<>]/g, '').trim();
}

/** worker 首轮只获得团队目标、自己的边界和回报约定，避免复制 leader 噪声。 */
export function buildAgentTeamWorkerPrompt(input: {
  teamId: string;
  teamName: string;
  objective: string;
  workerId: string;
  assignment: string;
  dependsOn?: string[];
  revisionId?: string;
  attemptId?: string;
}): string {
  const dependencies = input.dependsOn?.length ? input.dependsOn.join(', ') : 'none';
  return [
    '<botmux_agent_team>',
    `team_id: ${clean(input.teamId)}`,
    `team_name: ${clean(input.teamName)}`,
    `worker_id: ${clean(input.workerId)}`,
    `depends_on: ${clean(dependencies)}`,
    ...(input.revisionId ? [`revision_id: ${clean(input.revisionId)}`] : []),
    ...(input.attemptId ? [`attempt_id: ${clean(input.attemptId)}`] : []),
    'role: independent_worker',
    '你是独立工作会话，不是 leader。只完成 assignment，不接管团队编排。',
    '不要启动 Codex sub-agent，不使用已下线的 Botmux Workflow。',
    '新证据、真实阻塞与最终结果直接作为正常 assistant message 发在本话题；Botmux 会把最终回报同步给 leader。',
    '用户插入纠偏时立即按最新要求调整；新要求使分支、SHA、MR 或构建证据失效时明确作废旧证据。',
    '最终 assistant message 必须是窄结构化 JSON，字段仅需 attemptId、revisionId、status、summary、evidenceRefs、metrics；status 只能是 succeeded/failed/blocked/interrupted。',
    '</botmux_agent_team>',
    '',
    '<team_objective>',
    input.objective.trim(),
    '</team_objective>',
    '',
    '<assignment>',
    input.assignment.trim(),
    '</assignment>',
  ].join('\n');
}

/** leader steer 时显式携带新 revision/attempt，迟到 final 才能被控制面隔离。 */
export function buildAgentTeamGuidancePrompt(revision: AgentTeamGuidanceRevision): string {
  return [
    '<botmux_agent_team_guidance>',
    `revision_id: ${clean(revision.revisionId)}`,
    ...(revision.attemptId ? [`attempt_id: ${clean(revision.attemptId)}`] : []),
    `type: ${revision.type}`,
    `lifetime: ${revision.lifetime}`,
    ...(revision.revokesRevisionId ? [`revokes_revision_id: ${clean(revision.revokesRevisionId)}`] : []),
    revision.type === 'status_query'
      ? '这是只读状态查询：不得创建或声称新的 attempt，回答当前进度即可。'
      : '这是新的 guidance revision。后续 final 必须回报这里的 revision_id/attempt_id；旧 attempt 的 final 已失效。',
    '</botmux_agent_team_guidance>',
    '',
    revision.content.trim(),
  ].join('\n');
}

/** worker 终态回报注入 leader 的精简事件，leader 决定追问、验收或回收。 */
export function buildAgentTeamLeaderReportPrompt(team: AgentTeam, worker: AgentTeamWorker, report?: AgentTeamReport): string {
  return [
    '<botmux_agent_team_report>',
    `team_id: ${team.teamId}`,
    `worker_id: ${worker.workerId}`,
    `worker_session_id: ${worker.sessionId ?? ''}`,
    `worker_topic_root: ${worker.rootMessageId ?? ''}`,
    ...(report ? [
      `report_id: ${report.reportId}`,
      `attempt_id: ${report.attemptId}`,
      `revision_id: ${report.revisionId}`,
      `status: ${report.status}`,
    ] : []),
    '这是独立 worker 的终态回报。你仍是 supervisor，只做核验、追问、打断、派下一阶段或回收；不要代替 worker 进入业务实现。',
    '</botmux_agent_team_report>',
    '',
    report?.summary ?? worker.lastResult ?? '',
    ...(report?.evidenceRefs.length ? ['', 'evidence_refs:', ...report.evidenceRefs.map(ref => `- ${ref}`)] : []),
    ...(report && Object.keys(report.metrics).length ? ['', `metrics: ${JSON.stringify(report.metrics)}`] : []),
  ].join('\n');
}
