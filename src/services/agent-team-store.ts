/**
 * 同 Bot 多会话 Agent Team 的持久控制面。
 *
 * registry 是 append-only revision / attempt / report 的事实来源；session 只承载
 * 当前 attempt 的执行。这样 daemon 重启后可以重放 queued worker 和 report
 * outbox，同时把旧 revision 的迟到 final 留在审计账本而不污染当前结果。
 */
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { atomicWriteFileSync } from '../utils/atomic-write.js';

export const DEFAULT_AGENT_TEAM_ACTIVE_WORKERS = 3;
export const MAX_AGENT_TEAM_ACTIVE_WORKERS = 4;

export type AgentTeamStatus = 'active' | 'completed' | 'closed';
export type AgentTeamWorkerStatus =
  | 'queued' | 'starting' | 'running' | 'working'
  | 'succeeded' | 'reported' | 'blocked' | 'interrupting' | 'interrupted'
  | 'failed' | 'superseded' | 'closed';
export type AgentTeamGuidanceType = 'assignment' | 'correction' | 'replacement' | 'addition' | 'status_query';
export type AgentTeamGuidanceLifetime = 'task-scoped' | 'one-shot' | 'revoked';
export type AgentTeamAttemptStatus =
  | 'queued' | 'starting' | 'running' | 'succeeded' | 'failed' | 'blocked'
  | 'interrupting' | 'interrupted' | 'superseded' | 'invalid' | 'closed';
export type AgentTeamResultStatus = 'succeeded' | 'failed' | 'blocked' | 'interrupted';

export interface AgentTeamGuidanceRevision {
  revisionId: string;
  parentRevisionId?: string;
  workerId: string;
  attemptId?: string;
  type: AgentTeamGuidanceType;
  lifetime: AgentTeamGuidanceLifetime;
  content: string;
  revokesRevisionId?: string;
  createdAt: string;
}

export interface AgentTeamResult {
  attemptId: string;
  revisionId: string;
  status: AgentTeamResultStatus;
  summary: string;
  evidenceRefs: string[];
  metrics: Record<string, number>;
}

export interface AgentTeamAttempt {
  attemptId: string;
  revisionId: string;
  status: AgentTeamAttemptStatus;
  queuedAt: string;
  startedAt?: string;
  terminalAt?: string;
  interruptRequestedAt?: string;
  interruptAckAt?: string;
  supersededAt?: string;
  result?: AgentTeamResult;
  invalidReason?: string;
}

export interface AgentTeamWorker {
  workerId: string;
  sessionId?: string;
  rootMessageId?: string;
  title: string;
  assignment: string;
  workingDir?: string;
  dependsOn: string[];
  reuseKey?: string;
  writer?: boolean;
  status: AgentTeamWorkerStatus;
  currentRevisionId?: string;
  currentAttemptId?: string;
  attempts: AgentTeamAttempt[];
  createdAt: string;
  updatedAt: string;
  lastReportAt?: string;
  lastResult?: string;
}

export interface AgentTeamReport {
  reportId: string;
  workerId: string;
  attemptId: string;
  revisionId: string;
  turnId: string;
  lastUuid: string;
  status: AgentTeamResultStatus | 'invalid' | 'stale';
  summary: string;
  evidenceRefs: string[];
  metrics: Record<string, number>;
  createdAt: string;
  terminalAt: string;
  deliveryState: 'pending' | 'leader-seen' | 'quarantined';
  leaderAckAt?: string;
  invalidReason?: string;
}

export interface AgentTeamMetrics {
  queueToStartMs: number[];
  terminalToLeaderAckMs: number[];
  interruptAckMs: number[];
  supersededAttempts: number;
  duplicateReports: number;
  duplicateLeaderSuppressions: number;
  quarantinedStaleResults: number;
  invalidResults: number;
  prematureDependencyStarts: number;
  staleResultsAccepted: number;
  duplicateLeaderEffects: number;
  falseInterruptTerminals: number;
}

export interface AgentTeam {
  teamId: string;
  name: string;
  objective: string;
  larkAppId: string;
  chatId: string;
  leaderSessionId: string;
  status: AgentTeamStatus;
  maxActiveWorkers: number;
  createdAt: string;
  updatedAt: string;
  workers: AgentTeamWorker[];
  revisions: AgentTeamGuidanceRevision[];
  reports: AgentTeamReport[];
  reportOutbox: AgentTeamReport[];
  leaderSeenReportIds: string[];
  metrics: AgentTeamMetrics;
}

type AgentTeamFile = Record<string, AgentTeam>;

function storePath(dataDir: string): string {
  return join(dataDir, 'agent-teams.json');
}

function emptyMetrics(): AgentTeamMetrics {
  return {
    queueToStartMs: [], terminalToLeaderAckMs: [], interruptAckMs: [],
    supersededAttempts: 0, duplicateReports: 0, duplicateLeaderSuppressions: 0,
    quarantinedStaleResults: 0, invalidResults: 0,
    prematureDependencyStarts: 0, staleResultsAccepted: 0,
    duplicateLeaderEffects: 0, falseInterruptTerminals: 0,
  };
}

function legacyCoordinate(prefix: 'rev' | 'attempt', teamId: string, worker: AgentTeamWorker): string {
  const digest = createHash('sha256')
    .update(`${teamId}\0${worker.workerId}\0${worker.sessionId ?? ''}\0${worker.createdAt}`)
    .digest('hex')
    .slice(0, 24);
  return `${prefix}_legacy_${digest}`;
}

function normalizeTeam(team: AgentTeam): AgentTeam {
  team.maxActiveWorkers = Math.min(
    MAX_AGENT_TEAM_ACTIVE_WORKERS,
    Math.max(1, Number(team.maxActiveWorkers) || DEFAULT_AGENT_TEAM_ACTIVE_WORKERS),
  );
  team.revisions ??= [];
  team.reports ??= [];
  team.reportOutbox ??= [];
  team.leaderSeenReportIds ??= [];
  team.metrics = { ...emptyMetrics(), ...(team.metrics ?? {}) };
  for (const worker of team.workers ??= []) {
    worker.dependsOn ??= [];
    worker.attempts ??= [];
    // v0.0.32 以前只有 worker.status/lastResult。迁移时给稳定坐标但绝不把
    // reported/closed 猜成 succeeded；旧结果仍需新 guidance/结构化 final 才能放行。
    if (worker.attempts.length === 0) {
      const revisionId = legacyCoordinate('rev', team.teamId, worker);
      const attemptId = legacyCoordinate('attempt', team.teamId, worker);
      const status: AgentTeamAttemptStatus = worker.status === 'working' || worker.status === 'running'
        ? 'running'
        : worker.status === 'interrupted'
          ? 'interrupted'
          : worker.status === 'failed'
            ? 'failed'
            : worker.status === 'closed'
              ? 'closed'
              : 'invalid';
      worker.currentRevisionId = revisionId;
      worker.currentAttemptId = attemptId;
      worker.attempts.push({
        attemptId,
        revisionId,
        status,
        queuedAt: worker.createdAt,
        ...(status === 'running' ? { startedAt: worker.createdAt } : { terminalAt: worker.updatedAt }),
        ...(status === 'invalid' ? { invalidReason: 'legacy_unstructured_result' } : {}),
      });
      if (!team.revisions.some(revision => revision.revisionId === revisionId)) {
        team.revisions.push({
          revisionId,
          workerId: worker.workerId,
          attemptId,
          type: 'assignment',
          lifetime: 'task-scoped',
          content: worker.assignment,
          createdAt: worker.createdAt,
        });
      }
    }
  }
  return team;
}

function readStore(dataDir: string): AgentTeamFile {
  const path = storePath(dataDir);
  if (!existsSync(path)) return {};
  try {
    const value = JSON.parse(readFileSync(path, 'utf8'));
    if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
    const teams = value as AgentTeamFile;
    for (const team of Object.values(teams)) normalizeTeam(team);
    return teams;
  } catch {
    return {};
  }
}

function writeStore(dataDir: string, value: AgentTeamFile): void {
  mkdirSync(dataDir, { recursive: true });
  atomicWriteFileSync(storePath(dataDir), JSON.stringify(value, null, 2) + '\n');
}

function id(prefix: 'rev' | 'attempt'): string {
  return `${prefix}_${randomUUID()}`;
}

function currentAttempt(worker: AgentTeamWorker): AgentTeamAttempt | undefined {
  return worker.attempts.find(item => item.attemptId === worker.currentAttemptId);
}

function activeWorkerStatus(status: AgentTeamWorkerStatus): boolean {
  return status === 'starting' || status === 'running' || status === 'working' || status === 'interrupting';
}

function workerStatusFromAttempt(status: AgentTeamAttemptStatus): AgentTeamWorkerStatus {
  if (status === 'invalid') return 'failed';
  return status;
}

/** 创建一支由现有会话担任 leader 的团队。 */
export function createAgentTeam(
  dataDir: string,
  input: Pick<AgentTeam, 'name' | 'objective' | 'larkAppId' | 'chatId' | 'leaderSessionId'> & { maxActiveWorkers?: number },
  now = new Date(),
): AgentTeam {
  const teams = readStore(dataDir);
  const stamp = now.toISOString();
  const team: AgentTeam = {
    teamId: `team_${randomUUID()}`,
    name: input.name,
    objective: input.objective,
    larkAppId: input.larkAppId,
    chatId: input.chatId,
    leaderSessionId: input.leaderSessionId,
    maxActiveWorkers: Math.min(
      MAX_AGENT_TEAM_ACTIVE_WORKERS,
      Math.max(1, input.maxActiveWorkers ?? DEFAULT_AGENT_TEAM_ACTIVE_WORKERS),
    ),
    status: 'active', createdAt: stamp, updatedAt: stamp,
    workers: [], revisions: [], reports: [], reportOutbox: [], leaderSeenReportIds: [], metrics: emptyMetrics(),
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

/** leader-wide 容量；queued worker 不占 live 配额。 */
export function getAgentTeamCapacity(dataDir: string, leaderSessionId: string, limit?: number): {
  activeWorkers: number;
  configuredLimit: number;
  hardLimit: number;
  available: number;
} {
  const teams = listAgentTeams(dataDir, { leaderSessionId }).filter(team => team.status === 'active');
  const configuredLimit = Math.min(
    MAX_AGENT_TEAM_ACTIVE_WORKERS,
    Math.max(1, limit ?? teams[0]?.maxActiveWorkers ?? DEFAULT_AGENT_TEAM_ACTIVE_WORKERS),
  );
  const activeWorkers = teams.flatMap(team => team.workers).filter(worker => activeWorkerStatus(worker.status)).length;
  return {
    activeWorkers,
    configuredLimit,
    hardLimit: MAX_AGENT_TEAM_ACTIVE_WORKERS,
    available: Math.max(0, configuredLimit - activeWorkers),
  };
}

export function findReusableAgentTeamWorker(
  dataDir: string,
  leaderSessionId: string,
  input: { reuseKey?: string; workingDir?: string; writer?: boolean },
): { team: AgentTeam; worker: AgentTeamWorker; matchedBy: 'reuseKey' | 'workingDir-writer' } | undefined {
  const reuseKey = input.reuseKey?.trim();
  const workingDir = input.workingDir ? resolve(input.workingDir) : undefined;
  for (const team of listAgentTeams(dataDir, { leaderSessionId }).filter(item => item.status === 'active')) {
    for (const worker of team.workers) {
      if (reuseKey && worker.reuseKey === reuseKey) return { team, worker, matchedBy: 'reuseKey' };
      if (input.writer && worker.writer && workingDir && worker.workingDir && resolve(worker.workingDir) === workingDir) {
        return { team, worker, matchedBy: 'workingDir-writer' };
      }
    }
  }
  return undefined;
}

/** 先登记 worker + initial revision/attempt；是否创建 session 由依赖闸门决定。 */
export function addAgentTeamWorker(
  dataDir: string,
  teamId: string,
  worker: Omit<AgentTeamWorker, 'createdAt' | 'updatedAt' | 'status' | 'attempts' | 'currentRevisionId' | 'currentAttemptId'> & {
    sessionId?: string;
    rootMessageId?: string;
    revisionId?: string;
    attemptId?: string;
  },
  now = new Date(),
): AgentTeamWorker | undefined {
  const teams = readStore(dataDir);
  const team = teams[teamId];
  if (!team || team.status !== 'active' || team.workers.some(item => item.workerId === worker.workerId)) return undefined;
  const stamp = now.toISOString();
  const revisionId = worker.revisionId ?? id('rev');
  const attemptId = worker.attemptId ?? id('attempt');
  const status: AgentTeamAttemptStatus = worker.sessionId ? 'running' : 'queued';
  const revision: AgentTeamGuidanceRevision = {
    revisionId, workerId: worker.workerId, attemptId, type: 'assignment', lifetime: 'task-scoped',
    content: worker.assignment, createdAt: stamp,
  };
  const attempt: AgentTeamAttempt = {
    attemptId, revisionId, status, queuedAt: stamp,
    ...(worker.sessionId ? { startedAt: stamp } : {}),
  };
  const created: AgentTeamWorker = {
    ...worker,
    status: workerStatusFromAttempt(status),
    currentRevisionId: revisionId,
    currentAttemptId: attemptId,
    attempts: [attempt],
    createdAt: stamp,
    updatedAt: stamp,
  };
  team.revisions.push(revision);
  team.workers.push(created);
  if (attempt.startedAt) team.metrics.queueToStartMs.push(0);
  team.updatedAt = stamp;
  writeStore(dataDir, teams);
  return created;
}

export function attachAgentTeamWorkerSession(
  dataDir: string,
  teamId: string,
  workerId: string,
  session: { sessionId: string; rootMessageId: string },
  now = new Date(),
): AgentTeamWorker | undefined {
  const teams = readStore(dataDir);
  const team = teams[teamId];
  const worker = team?.workers.find(item => item.workerId === workerId);
  const attempt = worker ? currentAttempt(worker) : undefined;
  if (!team || !worker || !attempt || !['queued', 'starting'].includes(attempt.status)) return undefined;
  const stamp = now.toISOString();
  worker.sessionId = session.sessionId;
  worker.rootMessageId = session.rootMessageId;
  worker.status = 'running';
  worker.updatedAt = stamp;
  attempt.status = 'running';
  attempt.startedAt = stamp;
  team.metrics.queueToStartMs.push(Math.max(0, now.getTime() - Date.parse(attempt.queuedAt)));
  team.updatedAt = stamp;
  writeStore(dataDir, teams);
  return worker;
}

export function updateAgentTeamWorker(
  dataDir: string,
  teamId: string,
  workerId: string,
  patch: Partial<Pick<AgentTeamWorker, 'status' | 'lastReportAt' | 'lastResult' | 'sessionId' | 'rootMessageId'>>,
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

export function markAgentTeamWorkerStarting(dataDir: string, teamId: string, workerId: string, now = new Date()): boolean {
  const teams = readStore(dataDir);
  const team = teams[teamId];
  const worker = team?.workers.find(item => item.workerId === workerId);
  const attempt = worker ? currentAttempt(worker) : undefined;
  if (!team || !worker || !attempt || attempt.status !== 'queued') return false;
  attempt.status = 'starting';
  worker.status = 'starting';
  worker.updatedAt = team.updatedAt = now.toISOString();
  writeStore(dataDir, teams);
  return true;
}

export function failAgentTeamWorkerStart(
  dataDir: string,
  teamId: string,
  workerId: string,
  reason: string,
  now = new Date(),
): void {
  const teams = readStore(dataDir);
  const team = teams[teamId];
  const worker = team?.workers.find(item => item.workerId === workerId);
  const attempt = worker ? currentAttempt(worker) : undefined;
  if (!team || !worker || !attempt) return;
  const stamp = now.toISOString();
  attempt.status = 'failed'; attempt.terminalAt = stamp; attempt.invalidReason = reason;
  worker.status = 'failed'; worker.updatedAt = team.updatedAt = stamp;
  writeStore(dataDir, teams);
}

export function agentTeamDependenciesSatisfied(team: AgentTeam, worker: AgentTeamWorker): boolean {
  return worker.dependsOn.every(depId => {
    const dependency = team.workers.find(item => item.workerId === depId);
    return dependency ? currentAttempt(dependency)?.status === 'succeeded' : false;
  });
}

export function appendAgentTeamGuidance(
  dataDir: string,
  teamId: string,
  workerId: string,
  input: {
    type: Exclude<AgentTeamGuidanceType, 'assignment'>;
    lifetime: AgentTeamGuidanceLifetime;
    content: string;
    revokesRevisionId?: string;
  },
  now = new Date(),
): { team: AgentTeam; worker: AgentTeamWorker; revision: AgentTeamGuidanceRevision; attempt?: AgentTeamAttempt } | undefined {
  const teams = readStore(dataDir);
  const team = teams[teamId];
  const worker = team?.workers.find(item => item.workerId === workerId);
  if (!team || !worker) return undefined;
  if (input.lifetime === 'revoked' && (!input.revokesRevisionId || !team.revisions.some(r => r.revisionId === input.revokesRevisionId))) {
    return undefined;
  }
  const stamp = now.toISOString();
  const revisionId = id('rev');
  const createsAttempt = input.type !== 'status_query' && input.lifetime !== 'revoked';
  const attemptId = createsAttempt ? id('attempt') : undefined;
  const revision: AgentTeamGuidanceRevision = {
    revisionId,
    parentRevisionId: worker.currentRevisionId,
    workerId,
    attemptId,
    type: input.type,
    lifetime: input.lifetime,
    content: input.content,
    revokesRevisionId: input.revokesRevisionId,
    createdAt: stamp,
  };
  team.revisions.push(revision);
  let attempt: AgentTeamAttempt | undefined;
  if (input.lifetime === 'revoked' && input.revokesRevisionId === worker.currentRevisionId) {
    const revokedAttempt = currentAttempt(worker);
    if (revokedAttempt && ['queued', 'starting', 'running', 'interrupting'].includes(revokedAttempt.status)) {
      revokedAttempt.status = 'superseded';
      revokedAttempt.supersededAt = stamp;
      revokedAttempt.terminalAt = stamp;
      team.metrics.supersededAttempts += 1;
    }
    worker.currentRevisionId = revisionId;
    worker.currentAttemptId = undefined;
    worker.status = 'superseded';
  }
  if (createsAttempt && attemptId) {
    const canContinueLiveSession = !!worker.sessionId && activeWorkerStatus(worker.status);
    const previous = currentAttempt(worker);
    if (previous && ['queued', 'starting', 'running', 'interrupting'].includes(previous.status)) {
      previous.status = 'superseded';
      previous.supersededAt = stamp;
      previous.terminalAt = stamp;
      team.metrics.supersededAttempts += 1;
    }
    attempt = {
      attemptId,
      revisionId,
      status: canContinueLiveSession ? 'running' : 'queued',
      queuedAt: stamp,
      ...(canContinueLiveSession ? { startedAt: stamp } : {}),
    };
    worker.attempts.push(attempt);
    worker.currentRevisionId = revisionId;
    worker.currentAttemptId = attemptId;
    worker.status = canContinueLiveSession ? 'running' : 'queued';
    if (canContinueLiveSession) team.metrics.queueToStartMs.push(0);
  }
  worker.updatedAt = team.updatedAt = stamp;
  writeStore(dataDir, teams);
  return { team, worker, revision, attempt };
}

function parseCandidateJson(content: string): unknown {
  const tagged = /<botmux_agent_team_result>\s*([\s\S]*?)\s*<\/botmux_agent_team_result>/.exec(content)?.[1];
  const fenced = /```(?:json)?\s*([\s\S]*?)\s*```/i.exec(content)?.[1];
  const candidates = [tagged, content.trim(), fenced].filter((item): item is string => !!item);
  for (const candidate of candidates) {
    try { return JSON.parse(candidate); } catch { /* next candidate */ }
  }
  return undefined;
}

export function parseAgentTeamResult(content: string): { ok: true; result: AgentTeamResult } | { ok: false; error: string } {
  const value = parseCandidateJson(content) as Record<string, unknown> | undefined;
  if (!value || typeof value !== 'object' || Array.isArray(value)) return { ok: false, error: 'result_json_required' };
  const statuses = new Set<AgentTeamResultStatus>(['succeeded', 'failed', 'blocked', 'interrupted']);
  if (typeof value.attemptId !== 'string' || !value.attemptId) return { ok: false, error: 'attemptId_required' };
  if (typeof value.revisionId !== 'string' || !value.revisionId) return { ok: false, error: 'revisionId_required' };
  if (typeof value.status !== 'string' || !statuses.has(value.status as AgentTeamResultStatus)) return { ok: false, error: 'status_invalid' };
  if (typeof value.summary !== 'string' || !value.summary.trim()) return { ok: false, error: 'summary_required' };
  if (!Array.isArray(value.evidenceRefs) || !value.evidenceRefs.every(item => typeof item === 'string')) {
    return { ok: false, error: 'evidenceRefs_string_array_required' };
  }
  const metricEntries = Array.isArray(value.metrics)
    ? value.metrics.every(item => item && typeof item === 'object'
      && typeof (item as Record<string, unknown>).name === 'string'
      && typeof (item as Record<string, unknown>).value === 'number'
      && Number.isFinite((item as Record<string, unknown>).value))
      ? value.metrics as Array<{ name: string; value: number }>
      : undefined
    : undefined;
  const metricMap = value.metrics && typeof value.metrics === 'object' && !Array.isArray(value.metrics)
    && Object.values(value.metrics).every(item => typeof item === 'number' && Number.isFinite(item))
    ? value.metrics as Record<string, number>
    : metricEntries
      ? Object.fromEntries(metricEntries.map(item => [item.name, item.value]))
      : undefined;
  if (!metricMap) return { ok: false, error: 'metrics_number_map_or_entries_required' };
  return {
    ok: true,
    result: {
      attemptId: value.attemptId,
      revisionId: value.revisionId,
      status: value.status as AgentTeamResultStatus,
      summary: value.summary.trim().slice(0, 12_000),
      evidenceRefs: (value.evidenceRefs as string[]).slice(0, 100),
      metrics: metricMap,
    },
  };
}

function reportIdFor(teamId: string, workerId: string, attemptId: string, lastUuid: string): string {
  return `report_${createHash('sha256').update(`${teamId}\0${workerId}\0${attemptId}\0${lastUuid}`).digest('hex').slice(0, 32)}`;
}

export function recordAgentTeamWorkerReport(
  dataDir: string,
  sessionId: string,
  input: string | { content: string; lastUuid: string; turnId: string },
  now = new Date(),
): { team: AgentTeam; worker: AgentTeamWorker; report: AgentTeamReport; disposition: 'accepted' | 'invalid' | 'stale' | 'duplicate' } | undefined {
  const teams = readStore(dataDir);
  const payload = typeof input === 'string'
    ? { content: input, lastUuid: `legacy-${createHash('sha256').update(input).digest('hex')}`, turnId: 'legacy' }
    : input;
  for (const team of Object.values(teams)) {
    const worker = team.workers.find(item => item.sessionId === sessionId);
    if (!worker) continue;
    const stamp = now.toISOString();
    const parsed = parseAgentTeamResult(payload.content);
    const parsedAttemptId = parsed.ok ? parsed.result.attemptId : (worker.currentAttemptId ?? 'unknown');
    const stableId = reportIdFor(team.teamId, worker.workerId, parsedAttemptId, payload.lastUuid);
    const existing = team.reports.find(item => item.reportId === stableId);
    if (existing) {
      team.metrics.duplicateReports += 1;
      team.updatedAt = stamp;
      writeStore(dataDir, teams);
      return { team, worker, report: existing, disposition: 'duplicate' };
    }
    const attempt = currentAttempt(worker);
    let disposition: 'accepted' | 'invalid' | 'stale' = 'accepted';
    let status: AgentTeamReport['status'];
    let summary: string;
    let evidenceRefs: string[] = [];
    let metrics: Record<string, number> = {};
    let invalidReason: string | undefined;

    if (!parsed.ok) {
      disposition = 'invalid'; status = 'invalid'; invalidReason = parsed.error;
      summary = `Worker final 未通过结构化结果校验：${parsed.error}`;
    } else if (!attempt || parsed.result.attemptId !== worker.currentAttemptId || parsed.result.revisionId !== worker.currentRevisionId) {
      disposition = 'stale'; status = 'stale'; invalidReason = 'attempt_or_revision_stale';
      summary = parsed.result.summary; evidenceRefs = parsed.result.evidenceRefs; metrics = parsed.result.metrics;
    } else if (attempt.status !== 'running' && attempt.status !== 'interrupting') {
      disposition = 'stale'; status = 'stale'; invalidReason = 'attempt_already_terminal';
      summary = parsed.result.summary; evidenceRefs = parsed.result.evidenceRefs; metrics = parsed.result.metrics;
    } else if (attempt.status === 'interrupting' || parsed.result.status === 'interrupted') {
      // interrupt 的唯一终态来源是 App Server 回执，final 文本不能伪造 interrupted。
      disposition = 'invalid'; status = 'invalid'; invalidReason = 'interrupt_ack_required';
      summary = 'Worker final 不能替代 Codex App Server interrupt 回执';
    } else {
      status = parsed.result.status;
      summary = parsed.result.summary;
      evidenceRefs = parsed.result.evidenceRefs;
      metrics = parsed.result.metrics;
      attempt.status = parsed.result.status;
      attempt.result = parsed.result;
      attempt.terminalAt = stamp;
      worker.status = workerStatusFromAttempt(parsed.result.status);
      worker.lastResult = parsed.result.summary;
    }

    if (disposition === 'invalid') {
      team.metrics.invalidResults += 1;
      if (attempt && attempt.attemptId === worker.currentAttemptId && attempt.status !== 'interrupting') {
        attempt.status = 'invalid'; attempt.terminalAt = stamp; attempt.invalidReason = invalidReason;
        worker.status = 'failed'; worker.lastResult = summary;
      }
    } else if (disposition === 'stale') {
      team.metrics.quarantinedStaleResults += 1;
    }

    const report: AgentTeamReport = {
      reportId: stableId,
      workerId: worker.workerId,
      attemptId: parsedAttemptId,
      revisionId: parsed.ok ? parsed.result.revisionId : (worker.currentRevisionId ?? 'unknown'),
      turnId: payload.turnId,
      lastUuid: payload.lastUuid,
      status,
      summary,
      evidenceRefs,
      metrics,
      createdAt: stamp,
      terminalAt: stamp,
      deliveryState: disposition === 'stale' ? 'quarantined' : 'pending',
      invalidReason,
    };
    team.reports.push(report);
    if (report.deliveryState === 'pending') team.reportOutbox.push(report);
    worker.lastReportAt = stamp;
    worker.updatedAt = team.updatedAt = stamp;
    writeStore(dataDir, teams);
    return { team, worker, report, disposition };
  }
  return undefined;
}

export function listPendingAgentTeamReports(dataDir: string, larkAppId?: string): Array<{ team: AgentTeam; report: AgentTeamReport }> {
  return Object.values(readStore(dataDir))
    .filter(team => !larkAppId || team.larkAppId === larkAppId)
    .flatMap(team => team.reportOutbox.filter(report => report.deliveryState === 'pending').map(report => ({ team, report })));
}

/** leader consumer 的持久幂等集合；同 reportId 最多产生一次可见注入效果。 */
export function markAgentTeamReportLeaderSeen(
  dataDir: string,
  teamId: string,
  reportId: string,
  now = new Date(),
): { team: AgentTeam; report: AgentTeamReport; firstSeen: boolean } | undefined {
  const teams = readStore(dataDir);
  const team = teams[teamId];
  const report = team?.reports.find(item => item.reportId === reportId);
  if (!team || !report) return undefined;
  if (team.leaderSeenReportIds.includes(reportId)) {
    team.metrics.duplicateLeaderSuppressions += 1;
    writeStore(dataDir, teams);
    return { team, report, firstSeen: false };
  }
  const stamp = now.toISOString();
  team.leaderSeenReportIds.push(reportId);
  report.deliveryState = 'leader-seen';
  report.leaderAckAt = stamp;
  const outbox = team.reportOutbox.find(item => item.reportId === reportId);
  if (outbox) { outbox.deliveryState = 'leader-seen'; outbox.leaderAckAt = stamp; }
  team.metrics.terminalToLeaderAckMs.push(Math.max(0, now.getTime() - Date.parse(report.terminalAt)));
  team.updatedAt = stamp;
  writeStore(dataDir, teams);
  return { team, report, firstSeen: true };
}

export function requestAgentTeamWorkerInterrupt(
  dataDir: string,
  teamId: string,
  workerId: string,
  now = new Date(),
): AgentTeamWorker | undefined {
  const teams = readStore(dataDir);
  const team = teams[teamId];
  const worker = team?.workers.find(item => item.workerId === workerId);
  const attempt = worker ? currentAttempt(worker) : undefined;
  if (!team || !worker || !attempt || attempt.status !== 'running') return undefined;
  const stamp = now.toISOString();
  attempt.status = 'interrupting'; attempt.interruptRequestedAt = stamp;
  worker.status = 'interrupting'; worker.updatedAt = team.updatedAt = stamp;
  writeStore(dataDir, teams);
  return worker;
}

export function acknowledgeAgentTeamWorkerInterrupt(
  dataDir: string,
  sessionId: string,
  acknowledged: boolean,
  now = new Date(),
): { team: AgentTeam; worker: AgentTeamWorker } | undefined {
  const teams = readStore(dataDir);
  for (const team of Object.values(teams)) {
    const worker = team.workers.find(item => item.sessionId === sessionId);
    const attempt = worker ? currentAttempt(worker) : undefined;
    if (!worker || !attempt || attempt.status !== 'interrupting') continue;
    const stamp = now.toISOString();
    if (acknowledged) {
      attempt.status = 'interrupted'; attempt.interruptAckAt = stamp; attempt.terminalAt = stamp;
      worker.status = 'interrupted';
      if (attempt.interruptRequestedAt) {
        team.metrics.interruptAckMs.push(Math.max(0, now.getTime() - Date.parse(attempt.interruptRequestedAt)));
      }
    } else {
      attempt.status = 'running';
      attempt.interruptRequestedAt = undefined;
      worker.status = 'running';
    }
    worker.updatedAt = team.updatedAt = stamp;
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
