import { describe, expect, it, vi } from 'vitest';
import { runAgentTeamCommand } from '../src/cli/agent-team-command.js';

describe('botmux team CLI help', () => {
  it('documents structured guidance, reuse and leader capacity without Workflow', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      expect(await runAgentTeamCommand(['help'])).toBe(0);
      const help = String(log.mock.calls[0]?.[0] ?? '');
      expect(help).toContain('--max-active-workers <1..6>');
      expect(help).toContain('botmux team configure');
      expect(help).toContain('--clear-depends-on');
      expect(help).toContain('--reuse-key <稳定任务坐标>');
      expect(help).toContain('--kind correction|replacement|addition|status_query');
      expect(help).toContain('audit_eligible|commit_pushed|bits_mr_ready|build_started|build_terminal');
      expect(help).toContain('--branch <分支>');
      expect(help).toContain('--build-job <构建节点或URL>');
      expect(help).toContain('BITS URL 立即进入 leader 可见 outbox');
      expect(help).toContain('必须等 Codex App Server 回执');
      expect(help).toContain('不是 Codex sub-agent，也不是已下线的 Botmux Workflow');
    } finally {
      log.mockRestore();
    }
  });

  it('sends persistent max-worker and dependency configuration to the Team endpoint', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({ ok: true, changed: true }), {
      status: 200, headers: { 'content-type': 'application/json' },
    }));
    const write = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    try {
      expect(await runAgentTeamCommand([
        'configure', '--team', 'team_main', '--max-active-workers', '4',
        '--worker', 'alpha-audit-rule', '--clear-depends-on',
      ], { sessionId: 'leader_1', larkAppId: 'cli_team', ipcPort: 7788 })).toBe(0);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      const [url, init] = fetchMock.mock.calls[0];
      expect(url).toBe('http://127.0.0.1:7788/api/agent-teams/team_main/configure');
      expect(JSON.parse(String(init?.body))).toEqual({
        actorSessionId: 'leader_1',
        maxActiveWorkers: 4,
        workerId: 'alpha-audit-rule',
        clearDependsOn: true,
      });
    } finally {
      write.mockRestore();
      fetchMock.mockRestore();
    }
  });
});
