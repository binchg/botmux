/** 同 Bot 独立会话团队注册表的持久化与状态迁移回归。 */
import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  addAgentTeamWorker,
  closeAgentTeam,
  createAgentTeam,
  getAgentTeam,
  listAgentTeams,
  recordAgentTeamWorkerReport,
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

describe('agent team store', () => {
  it('persists leader and independent worker coordinates', () => {
    const dataDir = temporaryDataDir();
    const team = createAgentTeam(dataDir, {
      name: 'merge alpha review',
      objective: 'review and extract qualified changes',
      larkAppId: 'cli_x',
      chatId: 'oc_x',
      leaderSessionId: 'leader_1',
    }, new Date('2026-08-06T00:00:00.000Z'));
    const worker = addAgentTeamWorker(dataDir, team.teamId, {
      workerId: 'review_a',
      sessionId: 'worker_session',
      rootMessageId: 'om_root',
      title: 'Review A',
      assignment: 'inspect one bounded slice',
      dependsOn: [],
    }, new Date('2026-08-06T00:01:00.000Z'));

    expect(worker?.status).toBe('working');
    expect(getAgentTeam(dataDir, team.teamId)?.workers[0].sessionId).toBe('worker_session');
    expect(listAgentTeams(dataDir, { leaderSessionId: 'leader_1' })).toHaveLength(1);
  });

  it('records bounded final report and supports interrupt then close', () => {
    const dataDir = temporaryDataDir();
    const team = createAgentTeam(dataDir, {
      name: 'team', objective: 'objective', larkAppId: 'cli_x', chatId: 'oc_x', leaderSessionId: 'leader_1',
    });
    addAgentTeamWorker(dataDir, team.teamId, {
      workerId: 'worker_a', sessionId: 'session_a', rootMessageId: 'om_a', title: 'A',
      assignment: 'task', dependsOn: [],
    });

    expect(updateAgentTeamWorker(dataDir, team.teamId, 'worker_a', { status: 'interrupted' })?.status).toBe('interrupted');
    const report = recordAgentTeamWorkerReport(dataDir, 'session_a', 'x'.repeat(13_000));
    expect(report?.worker.status).toBe('reported');
    expect(report?.worker.lastResult).toHaveLength(12_000);
    expect(closeAgentTeam(dataDir, team.teamId)?.status).toBe('closed');
  });

  it('rejects duplicate worker ids', () => {
    const dataDir = temporaryDataDir();
    const team = createAgentTeam(dataDir, {
      name: 'team', objective: 'objective', larkAppId: 'cli_x', chatId: 'oc_x', leaderSessionId: 'leader_1',
    });
    const input = {
      workerId: 'same', sessionId: 'session_a', rootMessageId: 'om_a', title: 'A', assignment: 'task', dependsOn: [],
    };
    expect(addAgentTeamWorker(dataDir, team.teamId, input)).toBeDefined();
    expect(addAgentTeamWorker(dataDir, team.teamId, { ...input, sessionId: 'session_b' })).toBeUndefined();
  });
});
