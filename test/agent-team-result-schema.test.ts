import { describe, expect, it } from 'vitest';
import { agentTeamOutputSchema } from '../src/services/agent-team-result-schema.js';

function assertStrictObjectSchemas(node: unknown): void {
  if (!node || typeof node !== 'object' || Array.isArray(node)) return;
  const schema = node as Record<string, any>;
  if (schema.type === 'object') {
    const properties = Object.keys(schema.properties ?? {}).sort();
    const required = [...(schema.required ?? [])].sort();
    expect(schema.additionalProperties).toBe(false);
    expect(required).toEqual(properties);
  }
  for (const value of Object.values(schema)) assertStrictObjectSchemas(value);
}

describe('Agent Team strict output schema', () => {
  it('uses required keys exactly matching properties at every object level', () => {
    const schema = agentTeamOutputSchema('<botmux_agent_team>');
    expect(schema).toBeDefined();
    assertStrictObjectSchemas(schema);
    expect((schema as any).properties.metrics.type).toBe('array');
  });

  it('does not affect ordinary Codex App turns', () => {
    expect(agentTeamOutputSchema('<user_message>hello</user_message>')).toBeUndefined();
  });
});
