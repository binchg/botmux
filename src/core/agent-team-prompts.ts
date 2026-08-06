/** 同 Bot 多会话团队的稳定提示契约；不包含运行态日志。 */
import type { AgentTeam, AgentTeamWorker } from '../services/agent-team-store.js';

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
}): string {
  const dependencies = input.dependsOn?.length ? input.dependsOn.join(', ') : 'none';
  return [
    '<botmux_agent_team>',
    `team_id: ${clean(input.teamId)}`,
    `team_name: ${clean(input.teamName)}`,
    `worker_id: ${clean(input.workerId)}`,
    `depends_on: ${clean(dependencies)}`,
    'role: independent_worker',
    '你是独立工作会话，不是 leader。只完成 assignment，不接管团队编排。',
    '不要启动 Codex sub-agent，不使用已下线的 Botmux Workflow。',
    '新证据、真实阻塞与最终结果直接作为正常 assistant message 发在本话题；Botmux 会把最终回报同步给 leader。',
    '用户插入纠偏时立即按最新要求调整；新要求使分支、SHA、MR 或构建证据失效时明确作废旧证据。',
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

/** worker 终态回报注入 leader 的精简事件，leader 决定追问、验收或回收。 */
export function buildAgentTeamLeaderReportPrompt(team: AgentTeam, worker: AgentTeamWorker): string {
  return [
    '<botmux_agent_team_report>',
    `team_id: ${team.teamId}`,
    `worker_id: ${worker.workerId}`,
    `worker_session_id: ${worker.sessionId}`,
    `worker_topic_root: ${worker.rootMessageId}`,
    '这是独立 worker 的终态回报。你仍是 supervisor，只做核验、追问、打断、派下一阶段或回收；不要代替 worker 进入业务实现。',
    '</botmux_agent_team_report>',
    '',
    worker.lastResult ?? '',
  ].join('\n');
}
