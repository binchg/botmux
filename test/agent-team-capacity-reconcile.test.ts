import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { config } from '../src/config.js';
import {
  reconcileAgentTeamRuntimeWorkers,
  setLarkAppId,
  startQueuedAgentTeamWorker,
  startIpcServer,
  type IpcServerHandle,
} from '../src/core/dashboard-ipc-server.js';
import * as workerPool from '../src/core/worker-pool.js';
import * as sessionManager from '../src/core/session-manager.js';
import {
  addAgentTeamWorker,
  appendAgentTeamGuidance,
  createAgentTeam,
  getAgentTeam,
  getAgentTeamCapacity,
  requestAgentTeamWorkerInterrupt,
  updateAgentTeamWorker,
} from '../src/services/agent-team-store.js';
import * as sessionStore from '../src/services/session-store.js';

let handle: IpcServerHandle | null = null;
let dataDir: string | null = null;
let previousDataDir = config.session.dataDir;

function prepare() {
  previousDataDir = config.session.dataDir;
  dataDir = mkdtempSync(join(tmpdir(), 'botmux-agent-team-runtime-'));
  config.session.dataDir = dataDir;
  sessionStore.init();
  setLarkAppId('cli_team');
  workerPool.setActiveSessionsRegistry(new Map());
  return dataDir;
}

function createTeam(dir: string, maxActiveWorkers = 3) {
  return createAgentTeam(dir, {
    name: 'runtime team', objective: 'capacity reconciliation', larkAppId: 'cli_team', chatId: 'oc_team',
    leaderSessionId: 'leader-team', maxActiveWorkers,
  });
}

function createStoredWorker(dir: string, teamId: string, workerId: string, closeStoredSession = false) {
  const session = sessionStore.createSession('oc_team', `om_${workerId}`, workerId, 'group');
  session.larkAppId = 'cli_team';
  session.cliId = 'codex-app';
  sessionStore.updateSession(session);
  if (closeStoredSession) sessionStore.closeSession(session.sessionId);
  const worker = addAgentTeamWorker(dir, teamId, {
    workerId, sessionId: session.sessionId, rootMessageId: session.rootMessageId,
    title: workerId, assignment: 'task', dependsOn: [],
  })!;
  return { session, worker };
}

afterEach(async () => {
  if (handle) await handle.close();
  handle = null;
  workerPool.setActiveSessionsRegistry(new Map());
  setLarkAppId('');
  sessionStore.init();
  config.session.dataDir = previousDataDir;
  if (dataDir) rmSync(dataDir, { recursive: true, force: true });
  dataDir = null;
  vi.restoreAllMocks();
});

describe('Agent Team runtime capacity reconciliation', () => {
  it('allows six workers across Teams, rejects same-Team overflow, and rejects the global seventh', async () => {
    const dir = prepare();
    const main = createTeam(dir, 3);
    for (const workerId of ['main-a', 'main-b', 'main-c']) {
      addAgentTeamWorker(dir, main.teamId, {
        workerId, sessionId: `session_${workerId}`, rootMessageId: `om_${workerId}`,
        title: workerId, assignment: 'task', dependsOn: [],
      });
    }
    const small = createTeam(dir, 1);
    addAgentTeamWorker(dir, small.teamId, {
      workerId: 'fourth', title: 'fourth', assignment: 'task', dependsOn: [],
    });
    const registry = new Map<string, any>([['leader', {
      session: { sessionId: 'leader-team', status: 'active', rootMessageId: 'om_leader', ownerOpenId: 'ou_owner' },
      worker: { killed: false, send() {} },
      larkAppId: 'cli_team', chatId: 'oc_team', chatType: 'group', scope: 'thread', workingDir: dir,
    }]]);
    for (const workerId of ['main-a', 'main-b', 'main-c']) {
      registry.set(workerId, {
        session: { sessionId: `session_${workerId}`, status: 'active', rootMessageId: `om_${workerId}` },
        worker: { killed: false, send() {} },
        larkAppId: 'cli_team', chatId: 'oc_team', chatType: 'group', scope: 'thread',
      });
    }
    workerPool.setActiveSessionsRegistry(registry);
    const spawn = vi.spyOn(sessionManager, 'spawnAgentTeamWorker').mockImplementation(async (activeSessions, args) => {
      const sessionId = `session_${args.workerId}`;
      const rootMessageId = `om_${args.workerId}`;
      activeSessions.set(args.workerId, {
        session: { sessionId, status: 'active', rootMessageId },
        worker: { killed: false, send() {} },
        larkAppId: 'cli_team', chatId: 'oc_team', chatType: 'group', scope: 'thread',
      } as any);
      return { ok: true, sessionId, rootMessageId };
    });

    expect(await startQueuedAgentTeamWorker(small.teamId, 'fourth')).toMatchObject({ ok: true, started: true });
    expect(spawn).toHaveBeenCalledTimes(1);
    expect(getAgentTeamCapacity(dir, small.teamId)).toMatchObject({
      activeWorkers: 1, globalActiveWorkers: 4, teamAvailable: 0, globalAvailable: 2, available: 0,
    });

    addAgentTeamWorker(dir, small.teamId, {
      workerId: 'same-team-overflow', title: 'overflow', assignment: 'task', dependsOn: [],
    });
    expect(await startQueuedAgentTeamWorker(small.teamId, 'same-team-overflow')).toMatchObject({
      ok: true, started: false, reason: 'capacity_pending',
    });

    const fifthTeam = createTeam(dir, 2);
    addAgentTeamWorker(dir, fifthTeam.teamId, {
      workerId: 'global-fifth', title: 'fifth', assignment: 'task', dependsOn: [],
    });
    addAgentTeamWorker(dir, fifthTeam.teamId, {
      workerId: 'global-sixth', title: 'sixth', assignment: 'task', dependsOn: [],
    });
    expect(await startQueuedAgentTeamWorker(fifthTeam.teamId, 'global-fifth')).toMatchObject({ ok: true, started: true });
    expect(await startQueuedAgentTeamWorker(fifthTeam.teamId, 'global-sixth')).toMatchObject({ ok: true, started: true });
    expect(getAgentTeamCapacity(dir, fifthTeam.teamId)).toMatchObject({
      activeWorkers: 2, globalActiveWorkers: 6, hardLimit: 6, globalAvailable: 0, available: 0,
    });

    const seventhTeam = createTeam(dir, 6);
    addAgentTeamWorker(dir, seventhTeam.teamId, {
      workerId: 'global-seventh', title: 'seventh', assignment: 'task', dependsOn: [],
    });
    expect(await startQueuedAgentTeamWorker(seventhTeam.teamId, 'global-seventh')).toMatchObject({
      ok: true, started: false, reason: 'capacity_pending',
    });
    expect(spawn).toHaveBeenCalledTimes(3);
  });

  it('clears a queued worker dependency through configure and starts it without replacing history', async () => {
    const dir = prepare();
    const team = createTeam(dir, 4);
    const rule = addAgentTeamWorker(dir, team.teamId, {
      workerId: 'alpha-audit-rule', title: 'rule', assignment: 'task', dependsOn: ['workflow-gate', 'diff-topology'],
    })!;
    const originalAttemptId = rule.currentAttemptId;
    workerPool.setActiveSessionsRegistry(new Map([['leader', {
      session: { sessionId: 'leader-team', status: 'active', rootMessageId: 'om_leader', ownerOpenId: 'ou_owner' },
      worker: { killed: false, send() {} },
      larkAppId: 'cli_team', chatId: 'oc_team', chatType: 'group', scope: 'thread', workingDir: dir,
    } as any]]));
    vi.spyOn(sessionManager, 'spawnAgentTeamWorker').mockResolvedValue({
      ok: true, sessionId: 'session_alpha-audit-rule', rootMessageId: 'om_alpha-audit-rule',
    });
    handle = await startIpcServer({ port: 0, host: '127.0.0.1' });

    const response = await fetch(`http://127.0.0.1:${handle.port}/api/agent-teams/${team.teamId}/configure`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        actorSessionId: 'leader-team', workerId: rule.workerId, clearDependsOn: true,
      }),
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      ok: true,
      changed: true,
      events: [{ type: 'worker_dependencies_cleared', previousDependsOn: ['workflow-gate', 'diff-topology'] }],
      worker: { workerId: rule.workerId, dependsOn: [], currentAttemptId: originalAttemptId, status: 'running' },
      start: { ok: true, started: true, sessionId: 'session_alpha-audit-rule' },
    });
    const persisted = getAgentTeam(dir, team.teamId)!.workers[0];
    expect(persisted.attempts).toHaveLength(1);
    expect(persisted.currentAttemptId).toBe(originalAttemptId);
  });

  it('terminalizes a dead interrupting worker, preserves its attempt audit, and releases capacity', () => {
    const dir = prepare();
    const team = createTeam(dir, 1);
    const { worker } = createStoredWorker(dir, team.teamId, 'dead-interrupting', true);
    expect(requestAgentTeamWorkerInterrupt(dir, team.teamId, worker.workerId)?.status).toBe('interrupting');
    expect(getAgentTeamCapacity(dir, team.teamId).available).toBe(0);

    expect(reconcileAgentTeamRuntimeWorkers({ teamId: team.teamId })).toEqual([
      expect.objectContaining({
        workerId: worker.workerId,
        previousSessionStatus: 'closed',
        terminalReason: 'session_closed_without_runner',
      }),
    ]);
    const persisted = getAgentTeam(dir, team.teamId)!.workers[0];
    const attempt = persisted.attempts.find(item => item.attemptId === persisted.currentAttemptId)!;
    expect(persisted.status).toBe('interrupted');
    expect(attempt).toMatchObject({
      attemptId: worker.currentAttemptId,
      status: 'interrupted',
      terminalReason: 'session_closed_without_runner',
    });
    expect(attempt.terminalAt).toBeTruthy();
    expect(getAgentTeamCapacity(dir, team.teamId)).toMatchObject({ activeWorkers: 0, globalActiveWorkers: 0, available: 1 });
  });

  it('reclaims deleted running and queued sessions without resuming them', () => {
    const dir = prepare();
    const team = createTeam(dir, 2);
    const deleted = addAgentTeamWorker(dir, team.teamId, {
      workerId: 'deleted-running', sessionId: 'session_deleted', rootMessageId: 'om_deleted',
      title: 'deleted', assignment: 'task', dependsOn: [],
    })!;
    const { worker: queued } = createStoredWorker(dir, team.teamId, 'closed-queued', true);
    updateAgentTeamWorker(dir, team.teamId, queued.workerId, { status: 'closed' });
    appendAgentTeamGuidance(dir, team.teamId, queued.workerId, {
      type: 'addition', lifetime: 'task-scoped', content: 'queued after close',
    });

    const outcomes = reconcileAgentTeamRuntimeWorkers({ teamId: team.teamId });
    expect(outcomes).toEqual(expect.arrayContaining([
      expect.objectContaining({ workerId: deleted.workerId, terminalReason: 'session_deleted_without_runner' }),
      expect.objectContaining({ workerId: queued.workerId, terminalReason: 'session_closed_without_runner' }),
    ]));
    expect(getAgentTeam(dir, team.teamId)!.workers.map(item => item.status)).toEqual(['interrupted', 'interrupted']);
  });

  it('never reclaims a live idle registry session even when its persisted row is closed', () => {
    const dir = prepare();
    const team = createTeam(dir, 1);
    const { session, worker } = createStoredWorker(dir, team.teamId, 'live-idle', true);
    workerPool.setActiveSessionsRegistry(new Map([['live-idle', {
      session,
      worker: { killed: false, send() {} },
      larkAppId: 'cli_team', chatId: 'oc_team', chatType: 'group', scope: 'thread',
      lastScreenStatus: 'idle', hasHistory: true,
    } as any]]));

    expect(reconcileAgentTeamRuntimeWorkers({ teamId: team.teamId })).toEqual([]);
    expect(getAgentTeam(dir, team.teamId)!.workers[0].status).toBe('running');
    expect(getAgentTeamCapacity(dir, team.teamId).available).toBe(0);
  });

  it('lets reap reconcile a dead interrupting worker and close the Team in one request', async () => {
    const dir = prepare();
    const team = createTeam(dir, 1);
    const { worker } = createStoredWorker(dir, team.teamId, 'dead-for-reap', true);
    requestAgentTeamWorkerInterrupt(dir, team.teamId, worker.workerId);
    handle = await startIpcServer({ port: 0, host: '127.0.0.1' });

    const response = await fetch(`http://127.0.0.1:${handle.port}/api/agent-teams/${team.teamId}/reap`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ actorSessionId: 'leader-team', closeTeam: true }),
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      ok: true,
      reaped: [worker.workerId],
      teamClosed: true,
      runtimeReconciliation: [expect.objectContaining({ workerId: worker.workerId })],
    });
    const persisted = getAgentTeam(dir, team.teamId)!;
    expect(persisted.status).toBe('closed');
    expect(persisted.workers[0].status).toBe('closed');
    expect(persisted.workers[0].attempts[0]).toMatchObject({
      status: 'interrupted', terminalReason: 'session_closed_without_runner',
    });
  });
});
