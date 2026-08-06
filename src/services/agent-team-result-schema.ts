/** Codex App strict Structured Outputs schema for Agent Team finals. */
export function agentTeamOutputSchema(content: string): Record<string, unknown> | undefined {
  if (!content.includes('<botmux_agent_team>') && !content.includes('<botmux_agent_team_guidance>')) return undefined;
  return {
    type: 'object',
    additionalProperties: false,
    required: ['attemptId', 'revisionId', 'status', 'summary', 'evidenceRefs', 'metrics'],
    properties: {
      attemptId: { type: 'string', minLength: 1 },
      revisionId: { type: 'string', minLength: 1 },
      status: { type: 'string', enum: ['succeeded', 'failed', 'blocked', 'interrupted'] },
      summary: { type: 'string', minLength: 1 },
      evidenceRefs: { type: 'array', items: { type: 'string' } },
      // Strict Structured Outputs forbids arbitrary object keys. Keep named
      // metrics as a list and normalize it back to a map in the Team store.
      metrics: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['name', 'value'],
          properties: {
            name: { type: 'string', minLength: 1 },
            value: { type: 'number' },
          },
        },
      },
    },
  };
}
