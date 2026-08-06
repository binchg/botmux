import { describe, expect, it } from 'vitest';
import {
  AgentTeamProgressGate,
  isAgentTeamMachineOutput,
} from '../src/services/agent-team-output-filter.js';

const result = JSON.stringify({
  attemptId: 'attempt_1',
  revisionId: 'rev_1',
  status: 'succeeded',
  summary: '完成',
  evidenceRefs: [],
  metrics: [{ name: 'tests', value: 1 }],
});

describe('Agent Team outbound machine filter', () => {
  it('delivers ordinary Chinese, Markdown links and code unchanged', () => {
    const gate = new AgentTeamProgressGate();
    const content = '容量根因已经定位。\n[MR 8303533](https://bits.bytedance.net/x?id=8303533)\n```ts\nconst limit = 8;\n```';
    expect(gate.filter('turn-human', content, true)).toEqual({ action: 'deliver', content });
    expect(gate.filter('turn-human', content, true)).toEqual({ action: 'suppress' });
  });

  it('does not mistake non-JSON braces or schema words in prose for machine output', () => {
    const gate = new AgentTeamProgressGate();
    for (const content of [
      '普通说明：{这里是占位符}，attemptId 只是字段名。',
      '{attemptId: "示例", revisionId: "仍是普通文本"}',
      '{"attemptId":"示例"} 后面还有中文解释。',
    ]) {
      expect(gate.filter('turn-braces', content, true)).toEqual({ action: 'deliver', content });
    }
  });

  it('buffers split schema JSON and suppresses it only after strict structural recognition', () => {
    const gate = new AgentTeamProgressGate();
    const splitAt = result.indexOf('"summary"');
    expect(gate.filter('turn-json', result.slice(0, splitAt))).toEqual({ action: 'buffer' });
    expect(gate.filter('turn-json', result.slice(splitAt))).toEqual({ action: 'suppress' });
  });

  it('suppresses exact result JSON, fenced result JSON and explicitly typed envelopes', () => {
    expect(isAgentTeamMachineOutput(result)).toBe(true);
    expect(isAgentTeamMachineOutput(`\`\`\`json\n${result}\n\`\`\``)).toBe(true);
    expect(isAgentTeamMachineOutput(`<botmux_agent_team_result>${result}</botmux_agent_team_result>`)).toBe(true);
    expect(isAgentTeamMachineOutput(JSON.stringify({ type: 'agent_team_result', result: JSON.parse(result) }))).toBe(true);
    expect(isAgentTeamMachineOutput(JSON.stringify({ type: 'progress', result: JSON.parse(result) }))).toBe(false);
  });
});
