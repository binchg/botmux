const RESULT_KEYS = new Set(['attemptId', 'revisionId', 'status', 'summary', 'evidenceRefs', 'metrics']);
const MACHINE_ENVELOPE_TYPES = new Set(['agent_team_result', 'botmux_agent_team_result']);

type JsonPrefixState = 'complete' | 'incomplete' | 'invalid';

function resultShaped(value: unknown): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record);
  return keys.length === RESULT_KEYS.size && keys.every(key => RESULT_KEYS.has(key));
}

function parsedMachineEnvelope(value: unknown): boolean {
  if (resultShaped(value)) return true;
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  const kind = typeof record.type === 'string' ? record.type : typeof record.kind === 'string' ? record.kind : '';
  if (!MACHINE_ENVELOPE_TYPES.has(kind)) return false;
  return resultShaped(record.result) || resultShaped(record.payload);
}

function parseMachineJson(value: string): boolean {
  try { return parsedMachineEnvelope(JSON.parse(value)); } catch { return false; }
}

/** Only exact Team result JSON or an explicitly typed Team result envelope is machine-only. */
export function isAgentTeamMachineOutput(value: string): boolean {
  const text = value.trim();
  if (!text) return false;
  const tagged = /^<botmux_agent_team_result>\s*([\s\S]*?)\s*<\/botmux_agent_team_result>$/u.exec(text)?.[1];
  if (tagged !== undefined) return parseMachineJson(tagged);
  const fenced = /^```(?:json)?\s*([\s\S]*?)\s*```$/iu.exec(text)?.[1];
  return parseMachineJson(fenced ?? text);
}

interface PrefixResult { state: JsonPrefixState; index: number }

function skipWhitespace(text: string, start: number): number {
  let index = start;
  while (index < text.length && /\s/u.test(text[index])) index += 1;
  return index;
}

function parseStringPrefix(text: string, start: number): PrefixResult {
  if (text[start] !== '"') return { state: 'invalid', index: start };
  for (let index = start + 1; index < text.length; index += 1) {
    const char = text[index];
    if (char === '"') return { state: 'complete', index: index + 1 };
    if (char === '\\') {
      index += 1;
      if (index >= text.length) return { state: 'incomplete', index };
      if (text[index] === 'u') {
        const hex = text.slice(index + 1, index + 5);
        if (hex.length < 4) return /^[0-9a-f]*$/iu.test(hex)
          ? { state: 'incomplete', index: text.length }
          : { state: 'invalid', index };
        if (!/^[0-9a-f]{4}$/iu.test(hex)) return { state: 'invalid', index };
        index += 4;
      } else if (!/["\\/bfnrt]/u.test(text[index])) {
        return { state: 'invalid', index };
      }
    } else if (char.charCodeAt(0) < 0x20) {
      return { state: 'invalid', index };
    }
  }
  return { state: 'incomplete', index: text.length };
}

function parseLiteralPrefix(text: string, start: number, literal: string): PrefixResult {
  const available = text.slice(start, start + literal.length);
  if (literal.startsWith(available) && available.length < literal.length) {
    return { state: 'incomplete', index: text.length };
  }
  return available === literal
    ? { state: 'complete', index: start + literal.length }
    : { state: 'invalid', index: start };
}

function parseNumberPrefix(text: string, start: number): PrefixResult {
  let index = start;
  if (text[index] === '-') {
    index += 1;
    if (index >= text.length) return { state: 'incomplete', index };
  }
  if (text[index] === '0') index += 1;
  else if (/[1-9]/u.test(text[index] ?? '')) {
    while (/[0-9]/u.test(text[index] ?? '')) index += 1;
  } else return { state: 'invalid', index };
  if (text[index] === '.') {
    index += 1;
    if (index >= text.length) return { state: 'incomplete', index };
    if (!/[0-9]/u.test(text[index])) return { state: 'invalid', index };
    while (/[0-9]/u.test(text[index] ?? '')) index += 1;
  }
  if (text[index] === 'e' || text[index] === 'E') {
    index += 1;
    if (index >= text.length) return { state: 'incomplete', index };
    if (text[index] === '+' || text[index] === '-') {
      index += 1;
      if (index >= text.length) return { state: 'incomplete', index };
    }
    if (!/[0-9]/u.test(text[index])) return { state: 'invalid', index };
    while (/[0-9]/u.test(text[index] ?? '')) index += 1;
  }
  return { state: 'complete', index };
}

function parseValuePrefix(text: string, start: number): PrefixResult {
  const index = skipWhitespace(text, start);
  if (index >= text.length) return { state: 'incomplete', index };
  if (text[index] === '"') return parseStringPrefix(text, index);
  if (text[index] === '{') return parseObjectPrefix(text, index);
  if (text[index] === '[') return parseArrayPrefix(text, index);
  if (text[index] === 't') return parseLiteralPrefix(text, index, 'true');
  if (text[index] === 'f') return parseLiteralPrefix(text, index, 'false');
  if (text[index] === 'n') return parseLiteralPrefix(text, index, 'null');
  if (text[index] === '-' || /[0-9]/u.test(text[index])) return parseNumberPrefix(text, index);
  return { state: 'invalid', index };
}

function parseObjectPrefix(text: string, start: number): PrefixResult {
  let index = skipWhitespace(text, start + 1);
  if (index >= text.length) return { state: 'incomplete', index };
  if (text[index] === '}') return { state: 'complete', index: index + 1 };
  for (;;) {
    const key = parseStringPrefix(text, index);
    if (key.state !== 'complete') return key;
    index = skipWhitespace(text, key.index);
    if (index >= text.length) return { state: 'incomplete', index };
    if (text[index] !== ':') return { state: 'invalid', index };
    const value = parseValuePrefix(text, index + 1);
    if (value.state !== 'complete') return value;
    index = skipWhitespace(text, value.index);
    if (index >= text.length) return { state: 'incomplete', index };
    if (text[index] === '}') return { state: 'complete', index: index + 1 };
    if (text[index] !== ',') return { state: 'invalid', index };
    index = skipWhitespace(text, index + 1);
    if (index >= text.length) return { state: 'incomplete', index };
  }
}

function parseArrayPrefix(text: string, start: number): PrefixResult {
  let index = skipWhitespace(text, start + 1);
  if (index >= text.length) return { state: 'incomplete', index };
  if (text[index] === ']') return { state: 'complete', index: index + 1 };
  for (;;) {
    const value = parseValuePrefix(text, index);
    if (value.state !== 'complete') return value;
    index = skipWhitespace(text, value.index);
    if (index >= text.length) return { state: 'incomplete', index };
    if (text[index] === ']') return { state: 'complete', index: index + 1 };
    if (text[index] !== ',') return { state: 'invalid', index };
    index = skipWhitespace(text, index + 1);
    if (index >= text.length) return { state: 'incomplete', index };
  }
}

function jsonPrefixState(value: string): JsonPrefixState {
  const text = value.trim();
  if (!text.startsWith('{') && !text.startsWith('[')) return 'invalid';
  const parsed = parseValuePrefix(text, 0);
  if (parsed.state !== 'complete') return parsed.state;
  return skipWhitespace(text, parsed.index) === text.length ? 'complete' : 'invalid';
}

export type AgentTeamProgressDecision =
  | { action: 'deliver'; content: string }
  | { action: 'buffer' }
  | { action: 'suppress' };

/** Defensive daemon-side gate for older runners that may stream JSON fragments. */
export class AgentTeamProgressGate {
  private readonly pending = new Map<string, string>();
  private readonly delivered = new Map<string, Set<string>>();

  reset(): void {
    this.pending.clear();
    this.delivered.clear();
  }

  filter(turnId: string | undefined, raw: string, complete = false): AgentTeamProgressDecision {
    const key = turnId || '__default__';
    const previous = this.pending.get(key) ?? '';
    const candidate = previous
      ? (raw.startsWith(previous) ? raw : previous + raw)
      : raw;
    if (complete) this.pending.delete(key);
    if (isAgentTeamMachineOutput(candidate)) {
      this.pending.delete(key);
      return { action: 'suppress' };
    }
    if (!complete && jsonPrefixState(candidate) === 'incomplete') {
      this.pending.set(key, candidate);
      return { action: 'buffer' };
    }
    this.pending.delete(key);
    const seen = this.delivered.get(key) ?? new Set<string>();
    this.delivered.set(key, seen);
    if (seen.has(candidate)) return { action: 'suppress' };
    seen.add(candidate);
    return { action: 'deliver', content: candidate };
  }
}
