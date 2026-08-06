/** Agent Team P0 revision/attempt/result/可靠回收状态机回归。 */
import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  acknowledgeAgentTeamWorkerInterrupt,
  addAgentTeamWorker,
  agentTeamDependenciesSatisfied,
  appendAgentTeamGuidance,
  attachAgentTeamWorkerSession,
  closeAgentTeam,
  configureAgentTeam,
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
    expect(getAgentTeamCapacity(dataDir, team.teamId)).toMatchObject({
      activeWorkers: 1, globalActiveWorkers: 1, configuredLimit: 2, hardLimit: 8,
      teamAvailable: 1, globalAvailable: 7, available: 1,
    });
  });

  it('keeps per-Team configured limits independent under the leader-wide hard limit', () => {
    const dataDir = temporaryDataDir();
    const main = create(dataDir, 3);
    addRunning(dataDir, main.teamId, 'main-a');
    addRunning(dataDir, main.teamId, 'main-b');
    addRunning(dataDir, main.teamId, 'main-c');
    const small = create(dataDir, 1);

    // Three workers in a sibling Team do not consume this Team's configured
    // slot; five leader-wide slots remain available.
    expect(getAgentTeamCapacity(dataDir, small.teamId)).toMatchObject({
      activeWorkers: 0, globalActiveWorkers: 3, configuredLimit: 1,
      teamAvailable: 1, globalAvailable: 5, available: 1,
    });
    expect(getAgentTeamCapacity(dataDir, main.teamId)).toMatchObject({
      activeWorkers: 3, globalActiveWorkers: 3, configuredLimit: 3,
      teamAvailable: 0, globalAvailable: 5, available: 0,
    });

    addRunning(dataDir, small.teamId, 'small-a');
    const extra = create(dataDir, 4);
    addRunning(dataDir, extra.teamId, 'extra-a');
    addRunning(dataDir, extra.teamId, 'extra-b');
    addRunning(dataDir, extra.teamId, 'extra-c');
    addRunning(dataDir, extra.teamId, 'extra-d');
    const ninth = create(dataDir, 8);
    expect(getAgentTeamCapacity(dataDir, ninth.teamId)).toMatchObject({
      activeWorkers: 0, globalActiveWorkers: 8, configuredLimit: 8,
      teamAvailable: 8, globalAvailable: 0, available: 0,
    });
  });

  it('persists audited Team configuration, clears dependencies idempotently, and rejects unsafe shrink', () => {
    const dataDir = temporaryDataDir();
    const team = create(dataDir, 3);
    addRunning(dataDir, team.teamId, 'active-a');
    addRunning(dataDir, team.teamId, 'active-b');
    const rule = addAgentTeamWorker(dataDir, team.teamId, {
      workerId: 'alpha-audit-rule', title: 'rule', assignment: 'task', dependsOn: ['active-a', 'active-b'],
    })!;
    const originalAttempts = structuredClone(rule.attempts);
    const stamp = new Date('2026-08-07T01:00:00.000Z');

    const configured = configureAgentTeam(dataDir, team.teamId, {
      actorSessionId: 'leader_1', maxActiveWorkers: 8, workerId: rule.workerId, clearDependsOn: true,
    }, stamp);
    expect(configured).toMatchObject({
      ok: true,
      changed: true,
      events: [
        { type: 'max_active_workers_changed', previousMaxActiveWorkers: 3, maxActiveWorkers: 8 },
        { type: 'worker_dependencies_cleared', workerId: rule.workerId, previousDependsOn: ['active-a', 'active-b'], dependsOn: [] },
      ],
    });

    // Fresh reads simulate daemon restart and prove both config and audit survive.
    const persisted = getAgentTeam(dataDir, team.teamId)!;
    expect(persisted.maxActiveWorkers).toBe(8);
    expect(persisted.configurationEvents).toHaveLength(2);
    expect(persisted.workers.find(item => item.workerId === rule.workerId)).toMatchObject({
      status: 'queued', dependsOn: [], attempts: originalAttempts,
    });

    const duplicate = configureAgentTeam(dataDir, team.teamId, {
      actorSessionId: 'leader_1', maxActiveWorkers: 8, workerId: rule.workerId, clearDependsOn: true,
    });
    expect(duplicate).toMatchObject({ ok: true, changed: false, events: [] });
    expect(getAgentTeam(dataDir, team.teamId)!.configurationEvents).toHaveLength(2);

    expect(configureAgentTeam(dataDir, team.teamId, {
      actorSessionId: 'leader_1', maxActiveWorkers: 1,
    })).toEqual({ ok: false, error: 'max_active_workers_below_current_active', activeWorkers: 2 });
    expect(getAgentTeam(dataDir, team.teamId)!.maxActiveWorkers).toBe(8);
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

  it('keeps an old accepted final for audit but removes it from delivery after a newer revision', () => {
    const dataDir = temporaryDataDir();
    const team = create(dataDir);
    const worker = addRunning(dataDir, team.teamId, 'diff-topology');
    const oldAttemptId = worker.currentAttemptId!;
    const oldRevisionId = worker.currentRevisionId!;
    const accepted = recordAgentTeamWorkerReport(dataDir, worker.sessionId!, {
      content: JSON.stringify({
        attemptId: oldAttemptId,
        revisionId: oldRevisionId,
        status: 'succeeded',
        summary: 'old diff report',
        evidenceRefs: ['report_332e'],
        metrics: {},
      }),
      lastUuid: 'report-332e',
      turnId: 'turn-old-report',
    })!;
    const correction = appendAgentTeamGuidance(dataDir, team.teamId, worker.workerId, {
      type: 'correction', lifetime: 'task-scoped', content: 'review current MR 8303603',
    })!;

    expect(accepted.disposition).toBe('accepted');
    expect(listPendingAgentTeamReports(dataDir)).toHaveLength(0);
    let persisted = getAgentTeam(dataDir, team.teamId)!;
    expect(persisted.reports.find(item => item.reportId === accepted.report.reportId)).toMatchObject({
      deliveryState: 'quarantined',
      quarantineReason: 'attempt_superseded_before_delivery',
    });
    expect(persisted.workers[0]).toMatchObject({
      currentAttemptId: correction.attempt!.attemptId,
      currentRevisionId: correction.revision.revisionId,
      status: 'queued',
    });

    const late = recordAgentTeamWorkerReport(dataDir, worker.sessionId!, {
      content: JSON.stringify({
        attemptId: oldAttemptId,
        revisionId: oldRevisionId,
        status: 'succeeded',
        summary: 'late old revision must not win',
        evidenceRefs: [],
        metrics: {},
      }),
      lastUuid: 'late-old-report',
      turnId: 'turn-late-old-report',
    })!;
    persisted = getAgentTeam(dataDir, team.teamId)!;
    expect(late.disposition).toBe('stale');
    expect(late.report.deliveryState).toBe('quarantined');
    expect(persisted.workers[0]).toMatchObject({
      currentAttemptId: correction.attempt!.attemptId,
      currentRevisionId: correction.revision.revisionId,
      status: 'queued',
    });
  });

  it('audits malformed finals without changing the current attempt or entering the outbox', () => {
    const dataDir = temporaryDataDir();
    const team = create(dataDir);
    const worker = addRunning(dataDir, team.teamId);
    expect(parseAgentTeamResult('plain success')).toEqual({ ok: false, error: 'result_json_required' });
    const invalid = recordAgentTeamWorkerReport(dataDir, worker.sessionId!, {
      content: 'plain success', lastUuid: 'invalid-final', turnId: 'turn-invalid',
    });
    expect(invalid?.disposition).toBe('invalid');
    expect(invalid?.worker.status).toBe('running');
    expect(invalid?.report.status).toBe('invalid');
    expect(invalid?.report).toMatchObject({
      attemptId: 'unknown',
      revisionId: 'unknown',
      deliveryState: 'quarantined',
      invalidReason: 'result_json_required',
      quarantineReason: 'invalid_result_not_deliverable',
    });
    expect(invalid?.report.summary).not.toContain('plain success');
    expect(listPendingAgentTeamReports(dataDir)).toHaveLength(0);
    expect(getAgentTeam(dataDir, team.teamId)?.workers[0]).toMatchObject({
      currentAttemptId: worker.currentAttemptId,
      currentRevisionId: worker.currentRevisionId,
      status: 'running',
    });
  });

  it('quarantines two interrupted old invalid finals while current valid output stays exactly-once after restart', () => {
    const dataDir = temporaryDataDir();
    const team = create(dataDir);
    const workerC = addRunning(dataDir, team.teamId, 'bulk-nonad-writer-c');
    const workerRule = addRunning(dataDir, team.teamId, 'alpha-audit-rule');
    requestAgentTeamWorkerInterrupt(dataDir, team.teamId, workerC.workerId);
    requestAgentTeamWorkerInterrupt(dataDir, team.teamId, workerRule.workerId);
    const correctionC = appendAgentTeamGuidance(dataDir, team.teamId, workerC.workerId, {
      type: 'correction', lifetime: 'task-scoped', content: 'new C revision',
    })!;
    const correctionRule = appendAgentTeamGuidance(dataDir, team.teamId, workerRule.workerId, {
      type: 'correction', lifetime: 'task-scoped', content: 'new rule revision',
    })!;

    const invalidC = recordAgentTeamWorkerReport(dataDir, workerC.sessionId!, {
      content: 'late malformed C final', lastUuid: 'report-eb853', turnId: 'old-turn-c',
    })!;
    const invalidRule = recordAgentTeamWorkerReport(dataDir, workerRule.sessionId!, {
      content: 'late malformed rule final', lastUuid: 'report-786355', turnId: 'old-turn-rule',
    })!;
    expect([invalidC, invalidRule].map(item => item.disposition)).toEqual(['invalid', 'invalid']);
    expect([invalidC, invalidRule].map(item => item.report.deliveryState)).toEqual(['quarantined', 'quarantined']);
    expect(listPendingAgentTeamReports(dataDir)).toHaveLength(0);
    let persisted = getAgentTeam(dataDir, team.teamId)!;
    expect(persisted.workers.find(item => item.workerId === workerC.workerId)).toMatchObject({
      currentAttemptId: correctionC.attempt!.attemptId,
      currentRevisionId: correctionC.revision.revisionId,
      status: 'running',
    });
    expect(persisted.workers.find(item => item.workerId === workerRule.workerId)).toMatchObject({
      currentAttemptId: correctionRule.attempt!.attemptId,
      currentRevisionId: correctionRule.revision.revisionId,
      status: 'running',
    });

    // Simulate a v0.0.43 daemon restart with a misattributed invalid report
    // still pending under the current coordinates. Listing must repair it
    // before any Hook/leader consumer can claim it.
    const path = join(dataDir, 'agent-teams.json');
    const raw = JSON.parse(readFileSync(path, 'utf8')) as Record<string, any>;
    const storedInvalid = raw[team.teamId].reports.find((item: any) => item.reportId === invalidC.report.reportId);
    storedInvalid.attemptId = correctionC.attempt!.attemptId;
    storedInvalid.revisionId = correctionC.revision.revisionId;
    storedInvalid.deliveryState = 'pending';
    delete storedInvalid.quarantineReason;
    raw[team.teamId].reportOutbox.push({ ...storedInvalid });
    writeFileSync(path, `${JSON.stringify(raw, null, 2)}\n`);
    expect(listPendingAgentTeamReports(dataDir)).toHaveLength(0);
    persisted = getAgentTeam(dataDir, team.teamId)!;
    expect(persisted.reports.find(item => item.reportId === invalidC.report.reportId)).toMatchObject({
      status: 'invalid',
      deliveryState: 'quarantined',
      quarantineReason: 'invalid_result_not_deliverable',
    });

    const currentC = persisted.workers.find(item => item.workerId === workerC.workerId)!;
    const payload = {
      content: result(currentC as ReturnType<typeof addRunning>),
      lastUuid: 'current-c-final',
      turnId: 'current-turn-c',
    };
    const valid = recordAgentTeamWorkerReport(dataDir, workerC.sessionId!, payload)!;
    const duplicate = recordAgentTeamWorkerReport(dataDir, workerC.sessionId!, payload)!;
    expect(valid.disposition).toBe('accepted');
    expect(duplicate.disposition).toBe('duplicate');
    expect(listPendingAgentTeamReports(dataDir).map(item => item.report.reportId)).toEqual([valid.report.reportId]);
    expect(markAgentTeamReportLeaderSeen(dataDir, team.teamId, valid.report.reportId)?.firstSeen).toBe(true);
    expect(markAgentTeamReportLeaderSeen(dataDir, team.teamId, valid.report.reportId)?.firstSeen).toBe(false);
    expect(listPendingAgentTeamReports(dataDir)).toHaveLength(0);
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
      ...base,
      type: 'bits_mr_ready',
      summary: 'BITS ready',
      url: 'https://bits.bytedance.net/bytebus/devops/code/detail/8303533?tab=changes&devops_space_type=client',
      latestArtifacts: { branch: 'dev', sha: '899ef47c7eec293927416ad39627e570fca2c4c3' },
    }, new Date('2026-08-06T00:03:00.000Z'));
    const duplicate = recordAgentTeamMilestone(dataDir, team.teamId, worker.workerId, {
      ...base,
      type: 'bits_mr_ready',
      summary: 'same URL again',
      url: 'https://bits.bytedance.net/bytebus/devops/code/detail/8303533?tab=changes&devops_space_type=client',
      idempotencyKey: 'different-caller-key',
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
    if (!terminal.ok) throw new Error('expected terminal milestone');
    expect(terminal.milestone.url).toBe('https://bits.bytedance.net/bytebus/devops/code/detail/8303533?tab=changes&devops_space_type=client');
    expect(terminal.milestone.latestArtifacts).toMatchObject({
      bitsMrId: '8303533', branch: 'dev', sha: '899ef47c7eec293927416ad39627e570fca2c4c3',
    });
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
    expect(markAgentTeamMilestoneLeaderSeen(
      dataDir, team.teamId, bits.milestone.milestoneId, new Date('2026-08-06T00:03:01.000Z'), 'om_visible_bits',
    )?.firstSeen).toBe(true);
    expect(markAgentTeamMilestoneLeaderSeen(dataDir, team.teamId, bits.milestone.milestoneId)?.firstSeen).toBe(false);
    expect(getAgentTeam(dataDir, team.teamId)?.milestones.find(item => item.milestoneId === bits.milestone.milestoneId)?.visibleMessageId).toBe('om_visible_bits');
    expect(getAgentTeam(dataDir, team.teamId)?.metrics.duplicateMilestoneLeaderSuppressions).toBe(1);
    if (!audit.ok) throw new Error('expected audit milestone');
    expect(markAgentTeamMilestoneLeaderSeen(dataDir, team.teamId, audit.milestone.milestoneId)?.firstSeen).toBe(true);
    expect(getAgentTeam(dataDir, team.teamId)?.milestones.find(item => item.milestoneId === audit.milestone.milestoneId)?.visibleMessageId).toBeUndefined();
  });

  it('keeps latestArtifacts inside one attempt and quarantines old pending artifacts on a new revision', () => {
    const dataDir = temporaryDataDir();
    const team = create(dataDir);
    const worker = addRunning(dataDir, team.teamId);
    const oldBitsUrl = 'https://bits.bytedance.net/bytebus/devops/code/detail/8303533?tab=changes&from=old-attempt';
    recordAgentTeamMilestone(dataDir, team.teamId, worker.workerId, {
      attemptId: worker.currentAttemptId!,
      revisionId: worker.currentRevisionId!,
      type: 'bits_mr_ready',
      summary: 'old attempt BITS',
      url: oldBitsUrl,
    });

    const correction = appendAgentTeamGuidance(dataDir, team.teamId, worker.workerId, {
      type: 'correction', lifetime: 'task-scoped', content: 'new attempt',
    })!;
    const build = recordAgentTeamMilestone(dataDir, team.teamId, worker.workerId, {
      attemptId: correction.attempt!.attemptId,
      revisionId: correction.revision.revisionId,
      type: 'build_started',
      summary: 'new attempt build started',
    });
    expect(build.ok && build.milestone.url).toBeUndefined();
    expect(build.ok && build.milestone.latestArtifacts?.bitsUrl).toBeUndefined();
    const persisted = getAgentTeam(dataDir, team.teamId)!;
    expect(persisted.milestones.find(item => item.url === oldBitsUrl)?.deliveryState).toBe('quarantined');
    expect(listPendingAgentTeamMilestones(dataDir).map(item => item.milestone.attemptId)).toEqual([correction.attempt!.attemptId]);
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

  it('never replays build_started after a terminal event for the same artifact', () => {
    const dataDir = temporaryDataDir();
    const team = create(dataDir);
    const worker = addRunning(dataDir, team.teamId);
    const base = { attemptId: worker.currentAttemptId!, revisionId: worker.currentRevisionId! };
    const started = recordAgentTeamMilestone(dataDir, team.teamId, worker.workerId, {
      ...base,
      type: 'build_started',
      summary: 'MR 8303593 build started sha abcdef1',
      url: 'https://bits.bytedance.net/bytebus/devops/code/detail/8303593?tab=changes&sha=abcdef1',
    });
    const terminal = recordAgentTeamMilestone(dataDir, team.teamId, worker.workerId, {
      ...base,
      type: 'build_terminal',
      summary: 'MR 8303593 build passed sha abcdef1',
    });
    if (!started.ok || !terminal.ok) throw new Error('expected accepted milestones');

    expect(started.disposition).toBe('accepted');
    expect(terminal.disposition).toBe('accepted');
    expect(listPendingAgentTeamMilestones(dataDir).map(item => item.milestone.milestoneId)).toEqual([
      terminal.milestone.milestoneId,
    ]);
    expect(getAgentTeam(dataDir, team.teamId)?.milestones.find(
      item => item.milestoneId === started.milestone.milestoneId,
    )).toMatchObject({
      deliveryState: 'quarantined',
      quarantineReason: 'build_terminal_superseded_progress',
    });
  });

  it('repairs persisted stale v0.0.42 outboxes before list or leader claim', () => {
    const dataDir = temporaryDataDir();
    const team = create(dataDir);
    const worker = addRunning(dataDir, team.teamId);
    const oldAttemptId = worker.currentAttemptId!;
    const oldRevisionId = worker.currentRevisionId!;
    const milestone = recordAgentTeamMilestone(dataDir, team.teamId, worker.workerId, {
      attemptId: oldAttemptId,
      revisionId: oldRevisionId,
      type: 'build_started',
      summary: 'legacy pending build_started',
    });
    const report = recordAgentTeamWorkerReport(dataDir, worker.sessionId!, {
      content: JSON.stringify({
        attemptId: oldAttemptId,
        revisionId: oldRevisionId,
        status: 'succeeded',
        summary: 'legacy pending final',
        evidenceRefs: [],
        metrics: {},
      }),
      lastUuid: 'legacy-pending-final',
      turnId: 'legacy-turn',
    })!;
    appendAgentTeamGuidance(dataDir, team.teamId, worker.workerId, {
      type: 'correction', lifetime: 'task-scoped', content: 'current revision',
    });
    if (!milestone.ok) throw new Error('expected accepted milestone');

    // Recreate the persisted v0.0.42 defect: superseded coordinates remained pending.
    const path = join(dataDir, 'agent-teams.json');
    const raw = JSON.parse(readFileSync(path, 'utf8')) as Record<string, any>;
    for (const item of [
      ...raw[team.teamId].milestones,
      ...raw[team.teamId].milestoneOutbox,
      ...raw[team.teamId].reports,
      ...raw[team.teamId].reportOutbox,
    ]) {
      if (item.milestoneId === milestone.milestone.milestoneId || item.reportId === report.report.reportId) {
        item.deliveryState = 'pending';
        delete item.quarantineReason;
        delete item.invalidReason;
      }
    }
    writeFileSync(path, `${JSON.stringify(raw, null, 2)}\n`);

    expect(markAgentTeamMilestoneLeaderSeen(
      dataDir,
      team.teamId,
      milestone.milestone.milestoneId,
    )?.firstSeen).toBe(false);
    expect(markAgentTeamReportLeaderSeen(
      dataDir,
      team.teamId,
      report.report.reportId,
    )?.firstSeen).toBe(false);
    expect(listPendingAgentTeamMilestones(dataDir)).toHaveLength(0);
    expect(listPendingAgentTeamReports(dataDir)).toHaveLength(0);
    const persisted = getAgentTeam(dataDir, team.teamId)!;
    expect(persisted.milestones.find(item => item.milestoneId === milestone.milestone.milestoneId)).toMatchObject({
      deliveryState: 'quarantined',
      quarantineReason: 'attempt_or_revision_stale_before_delivery',
    });
    expect(persisted.reports.find(item => item.reportId === report.report.reportId)).toMatchObject({
      deliveryState: 'quarantined',
      quarantineReason: 'attempt_or_revision_stale_before_delivery',
    });
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
    expect(getAgentTeamCapacity(dataDir, team.teamId)).toMatchObject({ activeWorkers: 1, available: 0 });
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
