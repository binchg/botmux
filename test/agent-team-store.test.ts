/** Agent Team P0 revision/attempt/result/可靠回收状态机回归。 */
import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  acknowledgeAgentTeamWorkerInterrupt,
  addAgentTeamWorker,
  agentTeamDependenciesSatisfied,
  appendAgentTeamGuidance,
  attachAgentTeamWorkerSession,
  closeAgentTeam,
  createAgentTeam,
  findReusableAgentTeamWorker,
  getAgentTeam,
  getAgentTeamCapacity,
  listAgentTeams,
  listPendingAgentTeamMilestones,
  listPendingAgentTeamReports,
  markAgentTeamMilestoneLeaderSeen,
  markAgentTeamReportLeaderSeen,
  parseAgentTeamResult,
  recordAgentTeamMilestone,
  recordAgentTeamWorkerReport,
  requestAgentTeamWorkerInterrupt,
  updateAgentTeamWorker,
} from '../src/services/agent-team-store.js';

const temporaryDirectories: string[] = [];

function temporaryDataDir(): string {
  const path = mkdtempSync(join(tmpdir(), 'botmux-agent-team-'));
  temporaryDirectories.push(path);
  return path;
}

afterEach(() => {
  for (const path of temporaryDirectories.splice(0)) rmSync(path, { recursive: true, force: true });
});

function create(dataDir: string, maxActiveWorkers?: number) {
  return createAgentTeam(dataDir, {
    name: 'team', objective: 'objective', larkAppId: 'cli_x', chatId: 'oc_x', leaderSessionId: 'leader_1',
    maxActiveWorkers,
  }, new Date('2026-08-06T00:00:00.000Z'));
}

function addRunning(dataDir: string, teamId: string, workerId = 'worker_a', reuseKey?: string) {
  return addAgentTeamWorker(dataDir, teamId, {
    workerId,
    sessionId: `session_${workerId}`,
    rootMessageId: `om_${workerId}`,
    title: workerId,
    assignment: 'task',
    workingDir: '/repo/a',
    dependsOn: [],
    reuseKey,
    writer: true,
  }, new Date('2026-08-06T00:01:00.000Z'))!;
}

function result(worker: ReturnType<typeof addRunning>, status = 'succeeded') {
  return JSON.stringify({
    attemptId: worker.currentAttemptId,
    revisionId: worker.currentRevisionId,
    status,
    summary: `${status} result`,
    evidenceRefs: ['test:ok'],
    metrics: { tests: 1 },
  });
}

describe('agent team store', () => {
  it('persists initial revision/attempt and leader-wide capacity', () => {
    const dataDir = temporaryDataDir();
    const team = create(dataDir, 2);
    const worker = addRunning(dataDir, team.teamId);

    expect(worker.status).toBe('running');
    expect(worker.attempts).toHaveLength(1);
    expect(worker.currentAttemptId).toMatch(/^attempt_/);
    expect(getAgentTeam(dataDir, team.teamId)?.revisions[0].type).toBe('assignment');
    expect(listAgentTeams(dataDir, { leaderSessionId: 'leader_1' })).toHaveLength(1);
    expect(getAgentTeamCapacity(dataDir, 'leader_1', 2)).toMatchObject({ activeWorkers: 1, configuredLimit: 2, hardLimit: 4, available: 1 });
  });

  it('keeps an unmet dependency queued without a session and never starts prematurely', () => {
    const dataDir = temporaryDataDir();
    const team = create(dataDir);
    addRunning(dataDir, team.teamId, 'upstream');
    const downstream = addAgentTeamWorker(dataDir, team.teamId, {
      workerId: 'downstream', title: 'downstream', assignment: 'task', dependsOn: ['upstream'],
    })!;
    const current = getAgentTeam(dataDir, team.teamId)!;
    const persisted = current.workers.find(worker => worker.workerId === 'downstream')!;

    expect(downstream.status).toBe('queued');
    expect(downstream.sessionId).toBeUndefined();
    expect(agentTeamDependenciesSatisfied(current, persisted)).toBe(false);
    expect(current.metrics.prematureDependencyStarts).toBe(0);
  });

  it('starts only after the current dependency attempt succeeds', () => {
    const dataDir = temporaryDataDir();
    const team = create(dataDir);
    const upstream = addRunning(dataDir, team.teamId, 'upstream');
    addAgentTeamWorker(dataDir, team.teamId, {
      workerId: 'downstream', title: 'downstream', assignment: 'task', dependsOn: ['upstream'],
    })!;
    recordAgentTeamWorkerReport(dataDir, upstream.sessionId!, {
      content: result(upstream), lastUuid: 'upstream-final', turnId: 'turn-upstream',
    });
    const current = getAgentTeam(dataDir, team.teamId)!;
    const downstream = current.workers.find(worker => worker.workerId === 'downstream')!;
    expect(agentTeamDependenciesSatisfied(current, downstream)).toBe(true);
    expect(attachAgentTeamWorkerSession(dataDir, team.teamId, 'downstream', {
      sessionId: 'session_downstream', rootMessageId: 'om_downstream',
    })?.status).toBe('running');
  });

  it('supersedes an old attempt and quarantines its late final', () => {
    const dataDir = temporaryDataDir();
    const team = create(dataDir);
    const worker = addRunning(dataDir, team.teamId);
    const oldAttemptId = worker.currentAttemptId!;
    const oldRevisionId = worker.currentRevisionId!;
    const guidance = appendAgentTeamGuidance(dataDir, team.teamId, worker.workerId, {
      type: 'correction', lifetime: 'task-scoped', content: 'new direction',
    })!;

    const stale = recordAgentTeamWorkerReport(dataDir, worker.sessionId!, {
      content: JSON.stringify({
        attemptId: oldAttemptId, revisionId: oldRevisionId, status: 'succeeded', summary: 'late', evidenceRefs: [], metrics: {},
      }),
      lastUuid: 'late-old-final', turnId: 'turn-old',
    });
    const current = getAgentTeam(dataDir, team.teamId)!;
    expect(guidance.attempt?.attemptId).not.toBe(oldAttemptId);
    expect(stale?.disposition).toBe('stale');
    expect(stale?.report.deliveryState).toBe('quarantined');
    expect(current.metrics.staleResultsAccepted).toBe(0);
    expect(current.workers[0].attempts.find(item => item.attemptId === oldAttemptId)?.status).toBe('superseded');
  });

  it('rejects malformed and mismatched finals instead of recording success', () => {
    const dataDir = temporaryDataDir();
    const team = create(dataDir);
    const worker = addRunning(dataDir, team.teamId);
    expect(parseAgentTeamResult('plain success')).toEqual({ ok: false, error: 'result_json_required' });
    const invalid = recordAgentTeamWorkerReport(dataDir, worker.sessionId!, {
      content: 'plain success', lastUuid: 'invalid-final', turnId: 'turn-invalid',
    });
    expect(invalid?.disposition).toBe('invalid');
    expect(invalid?.worker.status).toBe('failed');
    expect(invalid?.report.status).toBe('invalid');
  });

  it('normalizes strict named metric entries while retaining legacy map compatibility', () => {
    const strict = parseAgentTeamResult(JSON.stringify({
      attemptId: 'attempt_strict',
      revisionId: 'rev_strict',
      status: 'succeeded',
      summary: 'strict schema result',
      evidenceRefs: ['test:strict'],
      metrics: [{ name: 'tests', value: 1 }, { name: 'duplicates', value: 0 }],
    }));
    expect(strict).toEqual({
      ok: true,
      result: {
        attemptId: 'attempt_strict',
        revisionId: 'rev_strict',
        status: 'succeeded',
        summary: 'strict schema result',
        evidenceRefs: ['test:strict'],
        metrics: { tests: 1, duplicates: 0 },
      },
    });
    expect(parseAgentTeamResult(JSON.stringify({
      attemptId: 'attempt_bad', revisionId: 'rev_bad', status: 'succeeded', summary: 'bad', evidenceRefs: [],
      metrics: [{ name: 'tests', value: 'one' }],
    }))).toEqual({ ok: false, error: 'metrics_number_map_or_entries_required' });
  });

  it('uses stable reportId, persists outbox across reads, and suppresses duplicate leader effect', () => {
    const dataDir = temporaryDataDir();
    const team = create(dataDir);
    const worker = addRunning(dataDir, team.teamId);
    const payload = { content: result(worker), lastUuid: 'stable-final', turnId: 'turn-1' };
    const first = recordAgentTeamWorkerReport(dataDir, worker.sessionId!, payload)!;
    const duplicate = recordAgentTeamWorkerReport(dataDir, worker.sessionId!, payload)!;

    expect(duplicate.disposition).toBe('duplicate');
    expect(duplicate.report.reportId).toBe(first.report.reportId);
    // Fresh read simulates daemon restart before leader delivery.
    expect(listPendingAgentTeamReports(dataDir)).toHaveLength(1);
    expect(markAgentTeamReportLeaderSeen(dataDir, team.teamId, first.report.reportId)?.firstSeen).toBe(true);
    expect(markAgentTeamReportLeaderSeen(dataDir, team.teamId, first.report.reportId)?.firstSeen).toBe(false);
    const persisted = getAgentTeam(dataDir, team.teamId)!;
    expect(listPendingAgentTeamReports(dataDir)).toHaveLength(0);
    expect(persisted.metrics.duplicateLeaderEffects).toBe(0);
    expect(persisted.metrics.duplicateLeaderSuppressions).toBe(1);
  });

  it('persists non-terminal milestones, dedupes BITS URLs and records artifact latency', () => {
    const dataDir = temporaryDataDir();
    const team = create(dataDir);
    const worker = addRunning(dataDir, team.teamId);
    const base = {
      attemptId: worker.currentAttemptId!, revisionId: worker.currentRevisionId!, evidenceRefs: ['live:test'],
    };
    const audit = recordAgentTeamMilestone(dataDir, team.teamId, worker.workerId, {
      ...base, type: 'audit_eligible', summary: 'machine audit passed',
    }, new Date('2026-08-06T00:02:00.000Z'));
    const bits = recordAgentTeamMilestone(dataDir, team.teamId, worker.workerId, {
      ...base, type: 'bits_mr_ready', summary: 'BITS ready', url: 'https://bits.example/mr/1',
    }, new Date('2026-08-06T00:03:00.000Z'));
    const duplicate = recordAgentTeamMilestone(dataDir, team.teamId, worker.workerId, {
      ...base, type: 'bits_mr_ready', summary: 'same URL again', url: 'https://bits.example/mr/1',
    }, new Date('2026-08-06T00:03:30.000Z'));
    const terminal = recordAgentTeamMilestone(dataDir, team.teamId, worker.workerId, {
      ...base, type: 'build_terminal', summary: 'build passed',
    }, new Date('2026-08-06T00:05:00.000Z'));

    expect(audit.ok && audit.disposition).toBe('accepted');
    expect(bits.ok && bits.disposition).toBe('accepted');
    expect(duplicate.ok && duplicate.disposition).toBe('duplicate');
    expect(terminal.ok && terminal.disposition).toBe('accepted');
    if (!bits.ok || !duplicate.ok) throw new Error('expected milestones');
    expect(duplicate.milestone.milestoneId).toBe(bits.milestone.milestoneId);
    const persisted = getAgentTeam(dataDir, team.teamId)!;
    expect(persisted.workers[0].attempts[0].status).toBe('running');
    expect(persisted.milestones).toHaveLength(3);
    expect(listPendingAgentTeamMilestones(dataDir)).toHaveLength(3);
    expect(persisted.metrics).toMatchObject({
      guidanceToFirstArtifactMs: [60_000],
      guidanceToBitsUrlMs: [120_000],
      bitsUrlToBuildTerminalMs: [120_000],
      duplicateMilestones: 1,
    });
    expect(markAgentTeamMilestoneLeaderSeen(dataDir, team.teamId, bits.milestone.milestoneId)?.firstSeen).toBe(true);
    expect(markAgentTeamMilestoneLeaderSeen(dataDir, team.teamId, bits.milestone.milestoneId)?.firstSeen).toBe(false);
    expect(getAgentTeam(dataDir, team.teamId)?.metrics.duplicateMilestoneLeaderSuppressions).toBe(1);
  });

  it('quarantines a late milestone from a superseded revision without a leader effect', () => {
    const dataDir = temporaryDataDir();
    const team = create(dataDir);
    const worker = addRunning(dataDir, team.teamId);
    const old = { attemptId: worker.currentAttemptId!, revisionId: worker.currentRevisionId! };
    appendAgentTeamGuidance(dataDir, team.teamId, worker.workerId, {
      type: 'correction', lifetime: 'task-scoped', content: 'new revision',
    });
    const stale = recordAgentTeamMilestone(dataDir, team.teamId, worker.workerId, {
      ...old, type: 'commit_pushed', summary: 'late old commit', evidenceRefs: ['sha:old'],
    });
    expect(stale.ok && stale.disposition).toBe('stale');
    expect(stale.ok && stale.milestone.deliveryState).toBe('quarantined');
    expect(listPendingAgentTeamMilestones(dataDir)).toHaveLength(0);
    expect(getAgentTeam(dataDir, team.teamId)?.metrics.quarantinedStaleMilestones).toBe(1);
  });

  it('does not enter interrupted from a final and waits for App Server ack', () => {
    const dataDir = temporaryDataDir();
    const team = create(dataDir);
    const worker = addRunning(dataDir, team.teamId);
    expect(requestAgentTeamWorkerInterrupt(dataDir, team.teamId, worker.workerId)?.status).toBe('interrupting');
    const fakeTerminal = recordAgentTeamWorkerReport(dataDir, worker.sessionId!, {
      content: result(worker, 'interrupted'), lastUuid: 'fake-interrupt-final', turnId: 'turn-i',
    });
    expect(fakeTerminal?.disposition).toBe('invalid');
    expect(getAgentTeam(dataDir, team.teamId)?.workers[0].status).toBe('interrupting');
    expect(getAgentTeam(dataDir, team.teamId)?.metrics.falseInterruptTerminals).toBe(0);
    expect(acknowledgeAgentTeamWorkerInterrupt(dataDir, worker.sessionId!, true)?.worker.status).toBe('interrupted');
    expect(getAgentTeam(dataDir, team.teamId)?.metrics.interruptAckMs).toHaveLength(1);
  });

  it('status_query and revocation append revisions without creating attempts', () => {
    const dataDir = temporaryDataDir();
    const team = create(dataDir);
    const worker = addRunning(dataDir, team.teamId);
    const before = worker.attempts.length;
    const query = appendAgentTeamGuidance(dataDir, team.teamId, worker.workerId, {
      type: 'status_query', lifetime: 'one-shot', content: 'where are we',
    });
    const revoke = appendAgentTeamGuidance(dataDir, team.teamId, worker.workerId, {
      type: 'correction', lifetime: 'revoked', content: 'revoke old rule', revokesRevisionId: worker.currentRevisionId,
    });
    const current = getAgentTeam(dataDir, team.teamId)!;
    expect(query?.attempt).toBeUndefined();
    expect(revoke?.attempt).toBeUndefined();
    expect(current.workers[0].attempts).toHaveLength(before);
    expect(current.workers[0].status).toBe('superseded');
    expect(current.workers[0].currentAttemptId).toBeUndefined();
    expect(current.workers[0].attempts[0].status).toBe('superseded');
  });

  it('finds reusable task/worktree writer and counts queued outside the cap', () => {
    const dataDir = temporaryDataDir();
    const team = create(dataDir, 1);
    addRunning(dataDir, team.teamId, 'writer', 'repo-audit');
    addAgentTeamWorker(dataDir, team.teamId, {
      workerId: 'queued', title: 'queued', assignment: 'task', workingDir: '/repo/b', dependsOn: ['writer'], writer: true,
    });
    expect(findReusableAgentTeamWorker(dataDir, 'leader_1', { reuseKey: 'repo-audit' })?.worker.workerId).toBe('writer');
    expect(findReusableAgentTeamWorker(dataDir, 'leader_1', { workingDir: '/repo/a', writer: true })?.matchedBy).toBe('workingDir-writer');
    expect(getAgentTeamCapacity(dataDir, 'leader_1', 1)).toMatchObject({ activeWorkers: 1, available: 0 });
    updateAgentTeamWorker(dataDir, team.teamId, 'writer', { status: 'closed' });
    expect(findReusableAgentTeamWorker(dataDir, 'leader_1', { reuseKey: 'repo-audit' })?.worker.sessionId).toBe('session_writer');
  });

  it('keeps closed worker session coordinates for cold-resume guidance', () => {
    const dataDir = temporaryDataDir();
    const team = create(dataDir);
    const worker = addRunning(dataDir, team.teamId);
    const sessionId = worker.sessionId;
    const rootMessageId = worker.rootMessageId;
    expect(closeAgentTeam(dataDir, team.teamId)?.status).toBe('closed');
    // Closing/reaping the worker does not rewrite its original federation coordinates.
    const persisted = getAgentTeam(dataDir, team.teamId)!.workers[0];
    expect(persisted.sessionId).toBe(sessionId);
    expect(persisted.rootMessageId).toBe(rootMessageId);
  });
});
