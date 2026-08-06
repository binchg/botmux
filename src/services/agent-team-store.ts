/**
 * 同 Bot 多会话 Agent Team 的持久注册表。
 *
 * 这里只保存 leader/worker 的关系、任务边界和回报摘要；真实运行状态仍以
 * session/worker 为准。这样 daemon 重启后可恢复监督关系，又不会复制终端日志或
 * 把独立会话的完整上下文灌回 leader。
 */
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { atomicWriteFileSync } from '../utils/atomic-write.js';

export type AgentTeamStatus = 'active' | 'completed' | 'closed';
export type AgentTeamWorkerStatus = 'working' | 'reported' | 'interrupted' | 'failed' | 'closed';

export interface AgentTeamWorker {
  workerId: string;
  sessionId: string;
  rootMessageId: string;
  title: string;
  assignment: string;
  workingDir?: string;
  dependsOn: string[];
  status: AgentTeamWorkerStatus;
  createdAt: string;
  updatedAt: string;
  lastReportAt?: string;
  lastResult?: string;
}

export interface AgentTeam {
  teamId: string;
  name: string;
  objective: string;
  larkAppId: string;
  chatId: string;
  leaderSessionId: string;
  status: AgentTeamStatus;
  createdAt: string;
  updatedAt: string;
  workers: AgentTeamWorker[];
}

type AgentTeamFile = Record<string, AgentTeam>;

function storePath(dataDir: string): string {
  return join(dataDir, 'agent-teams.json');
}

function readStore(dataDir: string): AgentTeamFile {
  const path = storePath(dataDir);
  if (!existsSync(path)) return {};
  try {
    const value = JSON.parse(readFileSync(path, 'utf8'));
    return value && typeof value === 'object' && !Array.isArray(value) ? value as AgentTeamFile : {};
  } catch {
    return {};
  }
}

function writeStore(dataDir: string, value: AgentTeamFile): void {
  mkdirSync(dataDir, { recursive: true });
  atomicWriteFileSync(storePath(dataDir), JSON.stringify(value, null, 2) + '\n');
}

/** 创建一支由现有会话担任 leader 的团队。 */
export function createAgentTeam(
  dataDir: string,
  input: Pick<AgentTeam, 'name' | 'objective' | 'larkAppId' | 'chatId' | 'leaderSessionId'>,
  now = new Date(),
): AgentTeam {
  const teams = readStore(dataDir);
  const stamp = now.toISOString();
  const team: AgentTeam = {
    teamId: `team_${randomUUID()}`,
    ...input,
    status: 'active',
    createdAt: stamp,
    updatedAt: stamp,
    workers: [],
  };
  teams[team.teamId] = team;
  writeStore(dataDir, teams);
  return team;
}

export function getAgentTeam(dataDir: string, teamId: string): AgentTeam | undefined {
  return readStore(dataDir)[teamId];
}

export function listAgentTeams(dataDir: string, filter?: { leaderSessionId?: string; larkAppId?: string }): AgentTeam[] {
  return Object.values(readStore(dataDir))
    .filter(team => !filter?.leaderSessionId || team.leaderSessionId === filter.leaderSessionId)
    .filter(team => !filter?.larkAppId || team.larkAppId === filter.larkAppId)
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

/** 为团队登记一个已成功创建的独立 worker 会话。 */
export function addAgentTeamWorker(
  dataDir: string,
  teamId: string,
  worker: Omit<AgentTeamWorker, 'createdAt' | 'updatedAt' | 'status'>,
  now = new Date(),
): AgentTeamWorker | undefined {
  const teams = readStore(dataDir);
  const team = teams[teamId];
  if (!team || team.status !== 'active' || team.workers.some(item => item.workerId === worker.workerId)) return undefined;
  const stamp = now.toISOString();
  const created: AgentTeamWorker = { ...worker, status: 'working', createdAt: stamp, updatedAt: stamp };
  team.workers.push(created);
  team.updatedAt = stamp;
  writeStore(dataDir, teams);
  return created;
}

export function updateAgentTeamWorker(
  dataDir: string,
  teamId: string,
  workerId: string,
  patch: Partial<Pick<AgentTeamWorker, 'status' | 'lastReportAt' | 'lastResult'>>,
  now = new Date(),
): AgentTeamWorker | undefined {
  const teams = readStore(dataDir);
  const team = teams[teamId];
  const worker = team?.workers.find(item => item.workerId === workerId);
  if (!team || !worker) return undefined;
  Object.assign(worker, patch, { updatedAt: now.toISOString() });
  team.updatedAt = worker.updatedAt;
  writeStore(dataDir, teams);
  return worker;
}

/** 根据 session 记录 worker 终态回报，供 worker-pool 的 final_output 钩子调用。 */
export function recordAgentTeamWorkerReport(
  dataDir: string,
  sessionId: string,
  content: string,
  now = new Date(),
): { team: AgentTeam; worker: AgentTeamWorker } | undefined {
  const teams = readStore(dataDir);
  for (const team of Object.values(teams)) {
    const worker = team.workers.find(item => item.sessionId === sessionId);
    if (!worker) continue;
    const stamp = now.toISOString();
    worker.status = 'reported';
    worker.lastReportAt = stamp;
    worker.lastResult = content.slice(0, 12_000);
    worker.updatedAt = stamp;
    team.updatedAt = stamp;
    writeStore(dataDir, teams);
    return { team, worker };
  }
  return undefined;
}

export function closeAgentTeam(dataDir: string, teamId: string, now = new Date()): AgentTeam | undefined {
  const teams = readStore(dataDir);
  const team = teams[teamId];
  if (!team) return undefined;
  team.status = 'closed';
  team.updatedAt = now.toISOString();
  writeStore(dataDir, teams);
  return team;
}
