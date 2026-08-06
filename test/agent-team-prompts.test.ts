/** Agent Team 角色隔离和精简回报契约回归。 */
import { describe, expect, it } from 'vitest';
import { buildAgentTeamLeaderReportPrompt, buildAgentTeamWorkerPrompt } from '../src/core/agent-team-prompts.js';
import type { AgentTeam, AgentTeamWorker } from '../src/services/agent-team-store.js';

describe('agent team prompts', () => {
  it('keeps worker independent and forbids nested orchestration', () => {
    const prompt = buildAgentTeamWorkerPrompt({
      teamId: 'team_x', teamName: 'alpha', objective: 'review merge', workerId: 'slice_a', assignment: 'review files',
      revisionId: 'rev_1', attemptId: 'attempt_1',
    });
    expect(prompt).toContain('role: independent_worker');
    expect(prompt).toContain('不要启动 Codex sub-agent');
    expect(prompt).toContain('<assignment>\nreview files\n</assignment>');
    expect(prompt).toContain('revision_id: rev_1');
    expect(prompt).toContain('attempt_id: attempt_1');
    expect(prompt).toContain('attemptId、revisionId、status、summary、evidenceRefs、metrics');
  });

  it('returns only a bounded worker report event to the leader', () => {
    const worker = {
      workerId: 'slice_a', sessionId: 'session_a', rootMessageId: 'om_a', title: 'A', assignment: 'task',
      dependsOn: [], status: 'reported', attempts: [], createdAt: '', updatedAt: '', lastResult: 'review complete',
    } satisfies AgentTeamWorker;
    const team = {
      teamId: 'team_x', name: 'alpha', objective: 'review', larkAppId: 'cli_x', chatId: 'oc_x',
      leaderSessionId: 'leader_x', status: 'active', maxActiveWorkers: 3, createdAt: '', updatedAt: '', workers: [worker],
      revisions: [], reports: [], reportOutbox: [], leaderSeenReportIds: [],
      metrics: {
        queueToStartMs: [], terminalToLeaderAckMs: [], interruptAckMs: [], supersededAttempts: 0,
        duplicateReports: 0, duplicateLeaderSuppressions: 0, quarantinedStaleResults: 0, invalidResults: 0,
        prematureDependencyStarts: 0, staleResultsAccepted: 0, duplicateLeaderEffects: 0, falseInterruptTerminals: 0,
      },
    } satisfies AgentTeam;

    const prompt = buildAgentTeamLeaderReportPrompt(team, worker);
    expect(prompt).toContain('你仍是 supervisor');
    expect(prompt).toContain('review complete');
    expect(prompt).not.toContain('assignment: task');
  });
});
