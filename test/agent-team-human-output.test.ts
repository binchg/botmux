import { describe, expect, it } from 'vitest';
import { buildTitledMarkdownCard } from '../src/im/lark/md-card.js';
import {
  agentTeamMilestoneDeliveryPolicy,
  agentTeamReportDeliveryPolicy,
  agentTeamWorkerFinalDeliveryPolicy,
  agentTeamUrlLabel,
  renderAgentTeamHumanOutput,
} from '../src/services/agent-team-human-output.js';
import type { AgentTeamMilestone, AgentTeamReport } from '../src/services/agent-team-store.js';

const bitsUrl = 'https://bits.bytedance.net/bytebus/devops/code/detail/8303533?tab=changes&devops_space_type=client';

function milestone(overrides: Partial<AgentTeamMilestone> = {}): AgentTeamMilestone {
  return {
    milestoneId: 'milestone_1',
    workerId: 'human-output-renderer',
    attemptId: 'attempt_1',
    revisionId: 'rev_1',
    type: 'build_started',
    summary: '仅显示回归，不修改 MR；构建节点已开始。',
    url: bitsUrl,
    evidenceRefs: [],
    latestArtifacts: { bitsUrl, bitsMrId: '8303533' },
    createdAt: '2026-08-07T00:00:00.000Z',
    deliveryState: 'pending',
    ...overrides,
  };
}

function report(overrides: Partial<AgentTeamReport> = {}): AgentTeamReport {
  return {
    reportId: 'report_1',
    workerId: 'human-output-renderer',
    attemptId: 'attempt_1',
    revisionId: 'rev_1',
    turnId: 'turn_1',
    lastUuid: 'uuid_1',
    status: 'succeeded',
    summary: '修复、测试和 live readback 均已完成。',
    evidenceRefs: [],
    metrics: {},
    latestArtifacts: { bitsUrl, bitsMrId: '8303533' },
    createdAt: '2026-08-07T00:00:00.000Z',
    terminalAt: '2026-08-07T00:00:00.000Z',
    deliveryState: 'pending',
    ...overrides,
  };
}

describe('Agent Team human output renderer', () => {
  it('decouples leader supervision from the user-visible allowlist', () => {
    for (const type of ['audit_eligible', 'commit_pushed', 'build_started'] as const) {
      expect(agentTeamMilestoneDeliveryPolicy(type)).toEqual({ userVisible: false, injectLeader: true });
    }
    for (const type of ['bits_mr_ready', 'build_terminal', 'human_required'] as const) {
      expect(agentTeamMilestoneDeliveryPolicy(type)).toEqual({ userVisible: true, injectLeader: true });
    }
    expect(agentTeamReportDeliveryPolicy('succeeded')).toEqual({ userVisible: false, injectLeader: true });
    expect(agentTeamReportDeliveryPolicy('blocked')).toEqual({ userVisible: true, injectLeader: true });
    expect(agentTeamWorkerFinalDeliveryPolicy('succeeded')).toEqual({ userVisible: true, injectLeader: true });
    expect(agentTeamReportDeliveryPolicy('invalid')).toEqual({ userVisible: false, injectLeader: false });
    expect(agentTeamWorkerFinalDeliveryPolicy('invalid')).toEqual({ userVisible: false, injectLeader: false });
  });

  it('extracts short semantic labels for supported URL families', () => {
    expect(agentTeamUrlLabel(bitsUrl)).toBe('MR 8303533');
    expect(agentTeamUrlLabel('https://meego.larkoffice.com/3040/story/detail/7346160613')).toBe('Meego 7346160613');
    expect(agentTeamUrlLabel('https://hummer.bytedance.net/singlebuild/overview?id=100646901&source=RemoteX')).toBe('RemoteX 100646901');
    expect(agentTeamUrlLabel('https://github.com/binchg/botmux/tree/dev')).toBe('GitHub');
  });

  it('renders the exact MR label while preserving the complete href query', () => {
    const output = renderAgentTeamHumanOutput({ kind: 'milestone', workerId: 'human-output-renderer', milestone: milestone() });
    expect(output.markdown.split('\n')[0]).toBe(`🟦 [MR 8303533](${bitsUrl})`);
    expect(output.markdown).toContain(`](${bitsUrl})`);
    expect(output.markdown.replace(/\]\(https?:\/\/[^)]*\)/gu, ']')).not.toMatch(/https?:\/\//u);
  });

  it('does not truncate or rewrite a long URL href', () => {
    const longUrl = `https://bits.bytedance.net/bytebus/devops/code/detail/8303533?token=${'x'.repeat(2600)}&sig=a!`;
    const output = renderAgentTeamHumanOutput({
      kind: 'milestone', workerId: 'worker-a', milestone: milestone({ url: longUrl, latestArtifacts: { bitsUrl: longUrl } }),
    });
    expect(output.markdown).toContain(`[MR 8303533](${longUrl})`);
  });

  it('puts multiple short links on one line separated by middle dots', () => {
    const meego = 'https://meego.larkoffice.com/3040/story/detail/7346160613?from=team';
    const remote = 'https://hummer.bytedance.net/singlebuild/overview?id=100646901&source=RemoteX';
    const output = renderAgentTeamHumanOutput({
      kind: 'milestone',
      workerId: 'worker-a',
      milestone: milestone({ summary: `相关 ${meego}\n构建 ${remote}` }),
    });
    expect(output.markdown.split('\n')[0]).toBe(
      `🟦 [MR 8303533](${bitsUrl}) · [Meego 7346160613](${meego}) · [RemoteX 100646901](${remote})`,
    );
  });

  it('collapses blank lines, trims Chinese detail and caps the body at four non-empty lines', () => {
    const output = renderAgentTeamHumanOutput({
      kind: 'report',
      workerId: 'worker-a',
      report: report({ summary: `  第一段。\n\n${'中文'.repeat(160)}\n\n下一步。  ` }),
    });
    const lines = output.markdown.split('\n');
    expect(lines.length).toBeLessThanOrEqual(4);
    expect(lines.every(line => line.length > 0 && line === line.trim())).toBe(true);
    expect(output.markdown).not.toContain('\n\n');
    expect(lines.at(-1)?.endsWith('…')).toBe(true);
  });

  it('uses the current Lark v2 markdown element so the short label is a blue link', () => {
    const output = renderAgentTeamHumanOutput({ kind: 'report', workerId: 'worker-a', report: report() });
    const card = JSON.parse(buildTitledMarkdownCard({
      title: output.title,
      md: output.markdown,
      brand: '',
      template: output.template,
    }));
    expect(card.header.template).toBe('green');
    expect(card.body.elements[0]).toMatchObject({
      tag: 'markdown',
      content: expect.stringContaining(`[MR 8303533](${bitsUrl})`),
    });
    expect(card.body.elements[0].content).not.toContain(`\n${bitsUrl}`);
  });
});
