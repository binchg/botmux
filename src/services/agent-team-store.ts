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
export const MAX_AGENT_TEAM_ACTIVE_WORKERS = 8;

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
export type AgentTeamMilestoneType =
  | 'audit_eligible' | 'commit_pushed' | 'bits_mr_ready' | 'build_started' | 'build_terminal' | 'human_required';

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

export interface AgentTeamLatestArtifacts {
  bitsUrl?: string;
  bitsMrId?: string;
  branch?: string;
  sha?: string;
  buildJob?: string;
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
  latestArtifacts?: AgentTeamLatestArtifacts;
  invalidReason?: string;
  /** Crash-safe runtime reconciliation reason. This is audit metadata, not a
   * structured worker result and never resumes the vanished runner. */
  terminalReason?: string;
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
  latestArtifacts?: AgentTeamLatestArtifacts;
  createdAt: string;
  terminalAt: string;
  deliveryState: 'pending' | 'leader-seen' | 'quarantined';
  visibleMessageId?: string;
  leaderAckAt?: string;
  invalidReason?: string;
  quarantineReason?: string;
}

export interface AgentTeamMilestone {
  milestoneId: string;
  workerId: string;
  attemptId: string;
  revisionId: string;
  type: AgentTeamMilestoneType;
  summary: string;
  url?: string;
  evidenceRefs: string[];
  latestArtifacts?: AgentTeamLatestArtifacts;
  createdAt: string;
  deliveryState: 'pending' | 'leader-seen' | 'quarantined';
  visibleMessageId?: string;
  workerVisibleMessageId?: string;
  leaderAckAt?: string;
  quarantineReason?: string;
}

export interface AgentTeamConfigurationEvent {
  eventId: string;
  type: 'max_active_workers_changed' | 'worker_dependencies_cleared';
  actorSessionId: string;
  workerId?: string;
  previousMaxActiveWorkers?: number;
  maxActiveWorkers?: number;
  previousDependsOn?: string[];
  dependsOn?: string[];
  createdAt: string;
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
  guidanceToFirstArtifactMs: number[];
  guidanceToBitsUrlMs: number[];
  bitsUrlToBuildTerminalMs: number[];
  duplicateMilestones: number;
  quarantinedStaleMilestones: number;
  duplicateMilestoneLeaderSuppressions: number;
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
  milestones: AgentTeamMilestone[];
  milestoneOutbox: AgentTeamMilestone[];
  leaderSeenMilestoneIds: string[];
  configurationEvents: AgentTeamConfigurationEvent[];
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
    guidanceToFirstArtifactMs: [], guidanceToBitsUrlMs: [], bitsUrlToBuildTerminalMs: [],
    duplicateMilestones: 0, quarantinedStaleMilestones: 0, duplicateMilestoneLeaderSuppressions: 0,
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
  team.milestones ??= [];
  team.milestoneOutbox ??= [];
  team.leaderSeenMilestoneIds ??= [];
  team.configurationEvents ??= [];
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

function quarantinePendingMilestonesForAttempt(
  team: AgentTeam,
  workerId: string,
  attemptId: string,
  reason = 'attempt_superseded_before_delivery',
  types?: ReadonlySet<AgentTeamMilestoneType>,
): boolean {
  let quarantined = 0;
  let changed = false;
  for (const milestone of team.milestones) {
    if (milestone.workerId !== workerId
      || milestone.attemptId !== attemptId
      || milestone.deliveryState !== 'pending'
      || (types && !types.has(milestone.type))) continue;
    milestone.deliveryState = 'quarantined';
    milestone.quarantineReason = reason;
    quarantined += 1;
    changed = true;
  }
  for (const milestone of team.milestoneOutbox) {
    if (milestone.workerId !== workerId
      || milestone.attemptId !== attemptId
      || milestone.deliveryState !== 'pending'
      || (types && !types.has(milestone.type))) continue;
    milestone.deliveryState = 'quarantined';
    milestone.quarantineReason = reason;
    changed = true;
  }
  team.metrics.quarantinedStaleMilestones += quarantined;
  return changed;
}

function quarantinePendingReportsForAttempt(
  team: AgentTeam,
  workerId: string,
  attemptId: string,
  reason = 'attempt_superseded_before_delivery',
  reportId?: string,
): boolean {
  let quarantined = 0;
  let changed = false;
  for (const report of team.reports) {
    if (report.workerId !== workerId
      || report.attemptId !== attemptId
      || report.deliveryState !== 'pending'
      || (reportId && report.reportId !== reportId)) continue;
    report.deliveryState = 'quarantined';
    report.quarantineReason = reason;
    quarantined += 1;
    changed = true;
  }
  for (const report of team.reportOutbox) {
    if (report.workerId !== workerId
      || report.attemptId !== attemptId
      || report.deliveryState !== 'pending'
      || (reportId && report.reportId !== reportId)) continue;
    report.deliveryState = 'quarantined';
    report.quarantineReason = reason;
    changed = true;
  }
  team.metrics.quarantinedStaleResults += quarantined;
  return changed;
}

function hasCurrentDeliveryCoordinates(
  team: AgentTeam,
  item: Pick<AgentTeamMilestone | AgentTeamReport, 'workerId' | 'attemptId' | 'revisionId'>,
): boolean {
  const worker = team.workers.find(candidate => candidate.workerId === item.workerId);
  const attempt = worker ? currentAttempt(worker) : undefined;
  return !!worker
    && !!attempt
    && worker.currentAttemptId === item.attemptId
    && worker.currentRevisionId === item.revisionId
    && attempt.attemptId === item.attemptId
    && attempt.revisionId === item.revisionId;
}

/** Lazily upgrades v0.0.42 outboxes so a daemon restart cannot replay old revisions. */
function quarantineStalePendingOutboxes(teams: AgentTeamFile, now = new Date()): boolean {
  let changed = false;
  for (const team of Object.values(teams)) {
    let teamChanged = false;
    for (const milestone of [...team.milestoneOutbox]) {
      if (milestone.deliveryState !== 'pending' || hasCurrentDeliveryCoordinates(team, milestone)) continue;
      teamChanged = quarantinePendingMilestonesForAttempt(
        team,
        milestone.workerId,
        milestone.attemptId,
        'attempt_or_revision_stale_before_delivery',
      ) || teamChanged;
    }
    for (const report of [...team.reportOutbox]) {
      if (report.deliveryState !== 'pending') continue;
      const reason = report.status === 'invalid'
        ? 'invalid_result_not_deliverable'
        : 'attempt_or_revision_stale_before_delivery';
      if (report.status !== 'invalid' && hasCurrentDeliveryCoordinates(team, report)) continue;
      teamChanged = quarantinePendingReportsForAttempt(
        team,
        report.workerId,
        report.attemptId,
        reason,
        report.status === 'invalid' ? report.reportId : undefined,
      ) || teamChanged;
    }
    if (teamChanged) {
      team.updatedAt = now.toISOString();
      changed = true;
    }
  }
  return changed;
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
    workers: [], revisions: [], reports: [], reportOutbox: [], leaderSeenReportIds: [],
    milestones: [], milestoneOutbox: [], leaderSeenMilestoneIds: [], configurationEvents: [], metrics: emptyMetrics(),
  };
  teams[team.teamId] = team;
  writeStore(dataDir, teams);
  return team;
}

export type ConfigureAgentTeamResult =
  | {
      ok: true;
      changed: boolean;
      team: AgentTeam;
      worker?: AgentTeamWorker;
      events: AgentTeamConfigurationEvent[];
    }
  | {
      ok: false;
      error:
        | 'team_not_active'
        | 'configuration_action_required'
        | 'max_active_workers_must_be_1_to_8'
        | 'max_active_workers_below_current_active'
        | 'worker_required_for_clear_depends_on'
        | 'worker_not_found';
      activeWorkers?: number;
    };

/**
 * 持久修改 Team 配额或 worker 依赖。先完整校验再一次原子写入；重复配置不追加
 * 审计事件，也不改变正在运行的 worker/attempt/session。
 */
export function configureAgentTeam(
  dataDir: string,
  teamId: string,
  input: {
    actorSessionId: string;
    maxActiveWorkers?: number;
    workerId?: string;
    clearDependsOn?: boolean;
  },
  now = new Date(),
): ConfigureAgentTeamResult {
  const teams = readStore(dataDir);
  const team = teams[teamId];
  if (!team || team.status !== 'active') return { ok: false, error: 'team_not_active' };
  const hasMaxChange = input.maxActiveWorkers !== undefined;
  const clearDependsOn = input.clearDependsOn === true;
  if (!hasMaxChange && !clearDependsOn) return { ok: false, error: 'configuration_action_required' };
  if (hasMaxChange && (
    !Number.isInteger(input.maxActiveWorkers)
    || input.maxActiveWorkers! < 1
    || input.maxActiveWorkers! > MAX_AGENT_TEAM_ACTIVE_WORKERS
  )) {
    return { ok: false, error: 'max_active_workers_must_be_1_to_8' };
  }
  const worker = clearDependsOn
    ? team.workers.find(item => item.workerId === input.workerId)
    : undefined;
  if (clearDependsOn && !input.workerId) return { ok: false, error: 'worker_required_for_clear_depends_on' };
  if (clearDependsOn && !worker) return { ok: false, error: 'worker_not_found' };
  const activeWorkers = team.workers.filter(item => activeWorkerStatus(item.status)).length;
  if (hasMaxChange && input.maxActiveWorkers! < activeWorkers) {
    return { ok: false, error: 'max_active_workers_below_current_active', activeWorkers };
  }

  const stamp = now.toISOString();
  const events: AgentTeamConfigurationEvent[] = [];
  if (hasMaxChange && input.maxActiveWorkers !== team.maxActiveWorkers) {
    events.push({
      eventId: `config_${randomUUID()}`,
      type: 'max_active_workers_changed',
      actorSessionId: input.actorSessionId,
      previousMaxActiveWorkers: team.maxActiveWorkers,
      maxActiveWorkers: input.maxActiveWorkers,
      createdAt: stamp,
    });
    team.maxActiveWorkers = input.maxActiveWorkers!;
  }
  if (clearDependsOn && worker && worker.dependsOn.length > 0) {
    events.push({
      eventId: `config_${randomUUID()}`,
      type: 'worker_dependencies_cleared',
      actorSessionId: input.actorSessionId,
      workerId: worker.workerId,
      previousDependsOn: [...worker.dependsOn],
      dependsOn: [],
      createdAt: stamp,
    });
    worker.dependsOn = [];
    worker.updatedAt = stamp;
  }
  if (events.length > 0) {
    team.configurationEvents.push(...events);
    team.updatedAt = stamp;
    writeStore(dataDir, teams);
  }
  return { ok: true, changed: events.length > 0, team, worker, events };
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

/**
 * Team 配额与 leader 全局硬上限是两个正交闸门；queued worker 不占 live 配额。
 *
 * A small Team must still be able to use its own slot when sibling Teams are
 * below the leader-wide hard limit, while no combination of Teams may create
 * a ninth live worker for the same leader.
 */
export function getAgentTeamCapacity(dataDir: string, teamId: string): {
  activeWorkers: number;
  globalActiveWorkers: number;
  configuredLimit: number;
  hardLimit: number;
  teamAvailable: number;
  globalAvailable: number;
  available: number;
} {
  const allTeams = readStore(dataDir);
  const team = allTeams[teamId];
  const configuredLimit = Math.min(
    MAX_AGENT_TEAM_ACTIVE_WORKERS,
    Math.max(1, team?.maxActiveWorkers ?? DEFAULT_AGENT_TEAM_ACTIVE_WORKERS),
  );
  const activeWorkers = team?.workers.filter(worker => activeWorkerStatus(worker.status)).length ?? 0;
  const leaderTeams = team
    ? Object.values(allTeams).filter(item => item.status === 'active' && item.leaderSessionId === team.leaderSessionId)
    : [];
  const globalActiveWorkers = leaderTeams
    .flatMap(item => item.workers)
    .filter(worker => activeWorkerStatus(worker.status)).length;
  const teamAvailable = Math.max(0, configuredLimit - activeWorkers);
  const globalAvailable = Math.max(0, MAX_AGENT_TEAM_ACTIVE_WORKERS - globalActiveWorkers);
  return {
    activeWorkers,
    globalActiveWorkers,
    configuredLimit,
    hardLimit: MAX_AGENT_TEAM_ACTIVE_WORKERS,
    teamAvailable,
    globalAvailable,
    available: Math.min(teamAvailable, globalAvailable),
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
    if (revokedAttempt) {
      quarantinePendingMilestonesForAttempt(team, worker.workerId, revokedAttempt.attemptId);
      quarantinePendingReportsForAttempt(team, worker.workerId, revokedAttempt.attemptId);
    }
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
    if (previous) {
      quarantinePendingMilestonesForAttempt(team, worker.workerId, previous.attemptId);
      quarantinePendingReportsForAttempt(team, worker.workerId, previous.attemptId);
    }
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

function milestoneIdFor(
  teamId: string,
  workerId: string,
  attemptId: string,
  type: AgentTeamMilestoneType,
  identity: string,
): string {
  return `milestone_${createHash('sha256').update(`${teamId}\0${workerId}\0${attemptId}\0${type}\0${identity}`).digest('hex').slice(0, 32)}`;
}

const ARTIFACT_URL_RE = /https?:\/\/[^\s<>\]]+/giu;

function cleanArtifactUrl(value: string): string {
  return value.replace(/[.,;:!，。；！]+$/u, '');
}

function artifactUrls(value: string): string[] {
  return [...value.matchAll(ARTIFACT_URL_RE)].map(match => cleanArtifactUrl(match[0]));
}

function artifactMrId(value: string): string | undefined {
  return /\/code\/detail\/(\d+)(?:[/?#]|$)/u.exec(value)?.[1]
    ?? /\bMR\s*#?\s*(\d+)\b/iu.exec(value)?.[1];
}

function deriveLatestArtifacts(
  previous: AgentTeamLatestArtifacts | undefined,
  input: {
    type: AgentTeamMilestoneType;
    summary: string;
    url?: string;
    evidenceRefs?: string[];
    latestArtifacts?: AgentTeamLatestArtifacts;
  },
): AgentTeamLatestArtifacts {
  const next: AgentTeamLatestArtifacts = { ...(previous ?? {}) };
  const explicit = input.latestArtifacts ?? {};
  const source = [input.summary, ...(input.evidenceRefs ?? [])].join('\n');
  const urls = [...(input.url ? [input.url] : []), ...artifactUrls(source)];
  const bitsUrl = explicit.bitsUrl?.trim()
    || urls.find(url => /\/code\/detail\/\d+/u.test(url));
  if (bitsUrl) next.bitsUrl = bitsUrl;
  const mrId = explicit.bitsMrId?.trim()
    || (next.bitsUrl ? artifactMrId(next.bitsUrl) : undefined)
    || artifactMrId(source);
  if (mrId) next.bitsMrId = mrId;
  const branch = explicit.branch?.trim()
    || /(?:\bbranch|分支)\s*[:=：]?\s*([A-Za-z0-9._/-]+)/iu.exec(source)?.[1];
  if (branch) next.branch = branch;
  const sha = explicit.sha?.trim()
    || /(?:\bsha|commit(?:\s+id)?|提交)\s*[:=：]?\s*([0-9a-f]{7,40})\b/iu.exec(source)?.[1];
  if (sha) next.sha = sha;
  const buildUrl = urls.find(url => /(?:hummer|remotex|\/build\/logs|jobId=)/iu.test(url));
  const buildJob = explicit.buildJob?.trim()
    || buildUrl
    || /(?:build(?:\s*job)?|构建(?:任务|节点)?)\s*[:=#：]\s*([A-Za-z0-9._/-]+)/iu.exec(source)?.[1];
  if (buildJob) next.buildJob = buildJob;
  return next;
}

/**
 * Persist a non-terminal artifact event for the current attempt. Milestones
 * never mutate attempt/worker status; stale revision events stay quarantined.
 */
export function recordAgentTeamMilestone(
  dataDir: string,
  teamId: string,
  workerId: string,
  input: {
    attemptId: string;
    revisionId: string;
    type: AgentTeamMilestoneType;
    summary: string;
    url?: string;
    evidenceRefs?: string[];
    idempotencyKey?: string;
    latestArtifacts?: AgentTeamLatestArtifacts;
  },
  now = new Date(),
): { ok: true; team: AgentTeam; worker: AgentTeamWorker; milestone: AgentTeamMilestone; disposition: 'accepted' | 'stale' | 'duplicate' }
| { ok: false; error: string } {
  const teams = readStore(dataDir);
  const team = teams[teamId];
  const worker = team?.workers.find(item => item.workerId === workerId);
  const types = new Set<AgentTeamMilestoneType>(['audit_eligible', 'commit_pushed', 'bits_mr_ready', 'build_started', 'build_terminal', 'human_required']);
  if (!team || !worker) return { ok: false, error: 'team_or_worker_not_found' };
  if (!types.has(input.type)) return { ok: false, error: 'milestone_type_invalid' };
  const summary = input.summary.trim().slice(0, 4000);
  if (!summary) return { ok: false, error: 'milestone_summary_required' };
  const requestedUrl = input.url?.trim() || undefined;
  if (input.type === 'bits_mr_ready' && (!requestedUrl || !/^https?:\/\//i.test(requestedUrl))) {
    return { ok: false, error: 'bits_mr_ready_http_url_required' };
  }
  const evidenceRefs = (input.evidenceRefs ?? []).filter(item => typeof item === 'string').map(item => item.slice(0, 2000)).slice(0, 100);
  const attemptForInput = worker.attempts.find(item => item.attemptId === input.attemptId && item.revisionId === input.revisionId);
  const latestArtifacts = deriveLatestArtifacts(attemptForInput?.latestArtifacts, {
    ...input,
    url: requestedUrl,
    evidenceRefs,
  });
  // Once a BITS MR is known, every later artifact in this exact attempt keeps
  // the clickable MR coordinate even when the caller omits --url.
  const url = requestedUrl ?? latestArtifacts.bitsUrl;
  // BITS URL is itself the canonical idempotency coordinate. A caller-supplied
  // key must never allow the same URL to create a second visible event.
  const identity = input.type === 'bits_mr_ready'
    ? url!
    : input.idempotencyKey?.trim() || JSON.stringify([summary, url ?? '', evidenceRefs]);
  const milestoneId = milestoneIdFor(teamId, workerId, input.attemptId, input.type, identity.slice(0, 4000));
  const duplicate = team.milestones.find(item => item.milestoneId === milestoneId
    || (input.type === 'bits_mr_ready'
      && item.workerId === workerId
      && item.attemptId === input.attemptId
      && item.type === input.type
      && item.url === url));
  const stamp = now.toISOString();
  if (duplicate) {
    team.metrics.duplicateMilestones += 1;
    team.updatedAt = stamp;
    writeStore(dataDir, teams);
    return { ok: true, team, worker, milestone: duplicate, disposition: 'duplicate' };
  }

  const current = currentAttempt(worker);
  const stale = !current
    || input.attemptId !== worker.currentAttemptId
    || input.revisionId !== worker.currentRevisionId
    || current.revisionId !== input.revisionId;
  const milestone: AgentTeamMilestone = {
    milestoneId,
    workerId,
    attemptId: input.attemptId,
    revisionId: input.revisionId,
    type: input.type,
    summary,
    url,
    evidenceRefs,
    latestArtifacts,
    createdAt: stamp,
    deliveryState: stale ? 'quarantined' : 'pending',
    ...(stale ? { quarantineReason: 'attempt_or_revision_stale' } : {}),
  };
  team.milestones.push(milestone);
  if (stale) {
    team.metrics.quarantinedStaleMilestones += 1;
  } else {
    current.latestArtifacts = latestArtifacts;
    const acceptedForAttempt = team.milestones.filter(item =>
      item.milestoneId !== milestoneId
      && item.attemptId === input.attemptId
      && item.deliveryState !== 'quarantined');
    const guidance = team.revisions.find(item => item.revisionId === input.revisionId);
    const guidanceAt = guidance ? Date.parse(guidance.createdAt) : NaN;
    if (acceptedForAttempt.length === 0 && Number.isFinite(guidanceAt)) {
      team.metrics.guidanceToFirstArtifactMs.push(Math.max(0, now.getTime() - guidanceAt));
    }
    if (input.type === 'bits_mr_ready' && Number.isFinite(guidanceAt)) {
      team.metrics.guidanceToBitsUrlMs.push(Math.max(0, now.getTime() - guidanceAt));
    }
    if (input.type === 'build_terminal') {
      quarantinePendingMilestonesForAttempt(
        team,
        worker.workerId,
        input.attemptId,
        'build_terminal_superseded_progress',
        new Set<AgentTeamMilestoneType>(['build_started']),
      );
      const bits = [...acceptedForAttempt]
        .filter(item => item.type === 'bits_mr_ready')
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
      if (bits) team.metrics.bitsUrlToBuildTerminalMs.push(Math.max(0, now.getTime() - Date.parse(bits.createdAt)));
    }
    team.milestoneOutbox.push(milestone);
  }
  worker.updatedAt = team.updatedAt = stamp;
  writeStore(dataDir, teams);
  return { ok: true, team, worker, milestone, disposition: stale ? 'stale' : 'accepted' };
}

export function listPendingAgentTeamMilestones(dataDir: string, larkAppId?: string): Array<{ team: AgentTeam; milestone: AgentTeamMilestone }> {
  const teams = readStore(dataDir);
  if (quarantineStalePendingOutboxes(teams)) writeStore(dataDir, teams);
  return Object.values(teams)
    .filter(team => !larkAppId || team.larkAppId === larkAppId)
    .flatMap(team => team.milestoneOutbox
      .filter(milestone => milestone.deliveryState === 'pending')
      .map(milestone => ({ team, milestone })));
}

/** Stable leader consumer claim; duplicate URL/event IDs have one visible effect. */
export function markAgentTeamMilestoneLeaderSeen(
  dataDir: string,
  teamId: string,
  milestoneId: string,
  now = new Date(),
  visibleMessageId?: string,
  workerVisibleMessageId?: string,
): { team: AgentTeam; milestone: AgentTeamMilestone; firstSeen: boolean } | undefined {
  const teams = readStore(dataDir);
  const team = teams[teamId];
  const milestone = team?.milestones.find(item => item.milestoneId === milestoneId);
  if (!team || !milestone) return undefined;
  if (milestone.deliveryState === 'pending' && !hasCurrentDeliveryCoordinates(team, milestone)) {
    quarantinePendingMilestonesForAttempt(
      team,
      milestone.workerId,
      milestone.attemptId,
      'attempt_or_revision_stale_before_delivery',
    );
    team.updatedAt = now.toISOString();
    writeStore(dataDir, teams);
    return { team, milestone, firstSeen: false };
  }
  if (team.leaderSeenMilestoneIds.includes(milestoneId)) {
    team.metrics.duplicateMilestoneLeaderSuppressions += 1;
    writeStore(dataDir, teams);
    return { team, milestone, firstSeen: false };
  }
  const stamp = now.toISOString();
  team.leaderSeenMilestoneIds.push(milestoneId);
  milestone.deliveryState = 'leader-seen';
  milestone.visibleMessageId = visibleMessageId ?? milestone.visibleMessageId;
  milestone.workerVisibleMessageId = workerVisibleMessageId ?? milestone.workerVisibleMessageId;
  milestone.leaderAckAt = stamp;
  const outbox = team.milestoneOutbox.find(item => item.milestoneId === milestoneId);
  if (outbox) {
    outbox.deliveryState = 'leader-seen';
    outbox.visibleMessageId = visibleMessageId ?? outbox.visibleMessageId;
    outbox.workerVisibleMessageId = workerVisibleMessageId ?? outbox.workerVisibleMessageId;
    outbox.leaderAckAt = stamp;
  }
  team.updatedAt = stamp;
  writeStore(dataDir, teams);
  return { team, milestone, firstSeen: true };
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
    // Malformed finals have no trustworthy coordinates. Never borrow the
    // worker's current attempt: a late old turn can arrive after correction and
    // would otherwise invalidate the new attempt or enter its report outbox.
    const parsedAttemptId = parsed.ok ? parsed.result.attemptId : 'unknown';
    const reportedAttempt = worker.attempts.find(item => item.attemptId === parsedAttemptId);
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
      quarantinePendingMilestonesForAttempt(
        team,
        worker.workerId,
        attempt.attemptId,
        'terminal_report_superseded_progress',
        new Set<AgentTeamMilestoneType>(['build_started']),
      );
    }

    if (disposition === 'invalid') {
      team.metrics.invalidResults += 1;
    } else if (disposition === 'stale') {
      team.metrics.quarantinedStaleResults += 1;
    }

    const report: AgentTeamReport = {
      reportId: stableId,
      workerId: worker.workerId,
      attemptId: parsedAttemptId,
      revisionId: parsed.ok ? parsed.result.revisionId : 'unknown',
      turnId: payload.turnId,
      lastUuid: payload.lastUuid,
      status,
      summary,
      evidenceRefs,
      metrics,
      latestArtifacts: reportedAttempt?.latestArtifacts ? { ...reportedAttempt.latestArtifacts } : undefined,
      createdAt: stamp,
      terminalAt: stamp,
      deliveryState: disposition === 'accepted' ? 'pending' : 'quarantined',
      invalidReason,
      ...(disposition === 'invalid' ? { quarantineReason: 'invalid_result_not_deliverable' } : {}),
    };
    team.reports.push(report);
    if (report.deliveryState === 'pending') team.reportOutbox.push(report);
    if (disposition !== 'stale') {
      worker.lastReportAt = stamp;
      worker.updatedAt = stamp;
    }
    team.updatedAt = stamp;
    writeStore(dataDir, teams);
    return { team, worker, report, disposition };
  }
  return undefined;
}

export function listPendingAgentTeamReports(dataDir: string, larkAppId?: string): Array<{ team: AgentTeam; report: AgentTeamReport }> {
  const teams = readStore(dataDir);
  if (quarantineStalePendingOutboxes(teams)) writeStore(dataDir, teams);
  return Object.values(teams)
    .filter(team => !larkAppId || team.larkAppId === larkAppId)
    .flatMap(team => team.reportOutbox.filter(report => report.deliveryState === 'pending').map(report => ({ team, report })));
}

/** leader consumer 的持久幂等集合；同 reportId 最多产生一次可见注入效果。 */
export function markAgentTeamReportLeaderSeen(
  dataDir: string,
  teamId: string,
  reportId: string,
  now = new Date(),
  visibleMessageId?: string,
): { team: AgentTeam; report: AgentTeamReport; firstSeen: boolean } | undefined {
  const teams = readStore(dataDir);
  const team = teams[teamId];
  const report = team?.reports.find(item => item.reportId === reportId);
  if (!team || !report) return undefined;
  if (report.deliveryState === 'pending'
    && (report.status === 'invalid' || !hasCurrentDeliveryCoordinates(team, report))) {
    quarantinePendingReportsForAttempt(
      team,
      report.workerId,
      report.attemptId,
      report.status === 'invalid' ? 'invalid_result_not_deliverable' : 'attempt_or_revision_stale_before_delivery',
      report.status === 'invalid' ? report.reportId : undefined,
    );
    team.updatedAt = now.toISOString();
    writeStore(dataDir, teams);
    return { team, report, firstSeen: false };
  }
  if (team.leaderSeenReportIds.includes(reportId)) {
    team.metrics.duplicateLeaderSuppressions += 1;
    writeStore(dataDir, teams);
    return { team, report, firstSeen: false };
  }
  const stamp = now.toISOString();
  team.leaderSeenReportIds.push(reportId);
  report.deliveryState = 'leader-seen';
  report.visibleMessageId = visibleMessageId ?? report.visibleMessageId;
  report.leaderAckAt = stamp;
  const outbox = team.reportOutbox.find(item => item.reportId === reportId);
  if (outbox) {
    outbox.deliveryState = 'leader-seen';
    outbox.visibleMessageId = visibleMessageId ?? outbox.visibleMessageId;
    outbox.leaderAckAt = stamp;
  }
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

/**
 * Finish an attempt whose persisted session no longer has a runtime registry
 * entry/runner. The caller must establish that runtime fact first; the store
 * intentionally cannot infer it on its own.
 *
 * This is distinct from an App Server interrupt acknowledgement: it retains
 * the original attempt and records why it ended, but never fabricates a model
 * result or resumes the vanished session.
 */
export function reconcileAgentTeamWorkerRuntimeGone(
  dataDir: string,
  teamId: string,
  workerId: string,
  reason: 'registry_missing_without_runner' | 'session_closed_without_runner' | 'session_deleted_without_runner',
  now = new Date(),
): { team: AgentTeam; worker: AgentTeamWorker; attempt: AgentTeamAttempt } | undefined {
  const teams = readStore(dataDir);
  const team = teams[teamId];
  const worker = team?.workers.find(item => item.workerId === workerId);
  const attempt = worker ? currentAttempt(worker) : undefined;
  const liveWorkerStatuses = new Set<AgentTeamWorkerStatus>(['queued', 'starting', 'running', 'working', 'interrupting']);
  const liveAttemptStatuses = new Set<AgentTeamAttemptStatus>(['queued', 'starting', 'running', 'interrupting']);
  if (!team || !worker || !attempt || !liveWorkerStatuses.has(worker.status) || !liveAttemptStatuses.has(attempt.status)) {
    return undefined;
  }
  const stamp = now.toISOString();
  attempt.status = 'interrupted';
  attempt.terminalAt = stamp;
  attempt.terminalReason = reason;
  worker.status = 'interrupted';
  worker.updatedAt = team.updatedAt = stamp;
  writeStore(dataDir, teams);
  return { team, worker, attempt };
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
