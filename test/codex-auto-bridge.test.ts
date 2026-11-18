import { it, expect, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, appendFileSync, readFileSync, rmSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { CodexAutoBridge } from '../src/services/codex-auto-bridge.js';

const done = (id: string, text: string, timestamp = new Date().toISOString()) => JSON.stringify({ timestamp, type: 'event_msg', payload: { type: 'task_complete', turn_id: id, last_agent_message: text } }) + '\n';
function file(home: string, id: string, body = '') {
  mkdirSync(join(home, 'sessions'), { recursive: true });
  const path = join(home, 'sessions', `rollout-${id}.jsonl`);
  writeFileSync(path, JSON.stringify({ type: 'session_meta', payload: { id, cwd: home } }) + '\n' + JSON.stringify({ type: 'event_msg', payload: { type: 'user_message', message: `Original user input ${id}` } }) + '\n' + body);
  return path;
}
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'codex-auto-'));
  const homes = [join(dir, 'default'), join(dir, 'botmux')];
  const cfg = { codexHomes: homes, larkAppId: 'app', chatId: 'chat', ownerOpenId: 'owner' };
  const stateFile = join(dir, 'state', 'registry.json');
  return { dir, homes, cfg, stateFile };
}

it('keeps an existing topic bound when Codex archives its transcript', async () => {
  const f = fixture(); const original = file(f.homes[0], 'archived');
  const replies: string[] = [];
  const deps = { topic: async () => 'root', reply: async (_: unknown, text: string) => { replies.push(text); }, received: async () => {},
    turn: async () => {}, excluded: () => new Set<string>(), error: (e: unknown) => { throw e; } };
  try {
    const bridge = new CodexAutoBridge(f.cfg, f.stateFile, deps);
    await bridge.scan(); appendFileSync(original, done('new', 'answer')); await bridge.scan();
    await vi.waitFor(() => expect(replies).toContain('answer'));
    const archive = join(f.homes[0], 'archived_sessions', 'rollout-archived.jsonl');
    mkdirSync(join(f.homes[0], 'archived_sessions')); renameSync(original, archive);
    const restored = new CodexAutoBridge(f.cfg, f.stateFile, deps);
    expect(restored.owns('root', 'app')).toBe(true);
    const saved = JSON.parse(readFileSync(f.stateFile, 'utf8'));
    expect(Object.values(saved.bindings)[0]).toMatchObject({ rolloutPath: archive });
    restored.stop(); bridge.stop();
  } finally { rmSync(f.dir, { recursive: true, force: true }); }
});

it('discovers every active thread across both libraries, skips history and excludes native botmux threads', async () => {
  const f = fixture(); const topics: string[] = [], replies: string[] = [], errors: unknown[] = [];
  const archive = file(f.homes[0], 'archive', done('old', 'old history', '2020-01-01T00:00:00Z'));
  const bridge = new CodexAutoBridge(f.cfg, f.stateFile, {
    topic: async b => { topics.push(b.threadId); return 'root-' + b.threadId; },
    reply: async (_, text) => { replies.push(text); }, turn: async () => {}, fork: async () => { throw new Error('unexpected fork'); },
    excluded: () => new Set(['managed']), error: e => errors.push(e),
  });
  try {
    await bridge.scan(); expect(topics).toEqual([]);
    appendFileSync(archive, done('archive-new', 'archive activity'));
    file(f.homes[1], 'new', done('inherited', 'inherited history', '2020-01-01T00:00:00Z') + done('new', 'new session'));
    file(f.homes[0], 'managed', done('managed', 'already forwarded'));
    await bridge.scan();
    await vi.waitFor(() => expect(replies.sort()).toEqual(['archive activity', 'new session']));
    expect(topics.sort()).toEqual(['archive', 'new']); expect(errors).toEqual([]);
    await bridge.scan(); expect(topics).toHaveLength(2);
    expect(bridge.owns('root-new', 'app')).toBe(true);
  } finally { bridge.stop(); rmSync(f.dir, { recursive: true, force: true }); }
});

it('resumes the original topic thread directly across restart without creating a fork', async () => {
  const f = fixture(); let forks = 0, turns = 0;
  const original = file(f.homes[0], 'original');
  const deps = {
    topic: async () => 'root', reply: async () => {}, excluded: () => new Set<string>(), error: (e: unknown) => { throw e; },
    fork: async (b: any) => { forks++; return { threadId: 'one-fork', rolloutPath: file(b.codexHome, 'one-fork') }; },
    turn: async (b: any, text: string, checkpoint: () => void) => { checkpoint(); turns++; appendFileSync(b.rolloutPath, done('reply-' + turns, text)); },
  };
  try {
    const bridge = new CodexAutoBridge(f.cfg, f.stateFile, deps);
    await bridge.scan(); appendFileSync(original, done('activity', 'visible activity')); await bridge.scan();
    // Existing readOnly/targetKey flags came from the old automatic-fork
    // policy. They must not redirect a normal follow-up after restart.
    const saved = JSON.parse(readFileSync(f.stateFile, 'utf8'));
    const entry = Object.values(saved.bindings)[0] as any;
    entry.readOnly = true; entry.targetKey = 'legacy-test-fork';
    writeFileSync(f.stateFile, JSON.stringify(saved));
    const legacy = new CodexAutoBridge(f.cfg, f.stateFile, deps);
    await legacy.receive('root', 'app', 'owner', 'q1', 'first'); await legacy.scan();
    await vi.waitFor(() => expect(turns).toBe(1));
    const restored = new CodexAutoBridge(f.cfg, f.stateFile, deps);
    await restored.receive('root', 'app', 'owner', 'q2', 'second'); await restored.scan();
    await vi.waitFor(() => expect(turns).toBe(2));
    expect(forks).toBe(0);
    expect(readFileSync(original, 'utf8')).toContain('first');
    expect(readFileSync(original, 'utf8')).toContain('second');
  } finally { rmSync(f.dir, { recursive: true, force: true }); }
});

it('routes a group member follow-up to the exact mapped original thread without forking', async () => {
  const f = fixture();
  const original = file(f.homes[0], 'imported');
  const turn = vi.fn(async (b: any, text: string, checkpoint: () => void) => {
    expect(b.threadId).toBe('imported');
    expect(b.rolloutPath).toBe(original);
    expect(text).toBe('question');
    checkpoint();
  });
  const fork = vi.fn(async () => { throw new Error('unexpected fork'); });
  const bridge = new CodexAutoBridge({ ...f.cfg, writableThreadIds: ['fixed-test-fork'], allowGroupMembers: true }, f.stateFile, {
    topic: async () => 'root', reply: async () => {}, turn, fork,
    excluded: () => new Set(), error: e => { throw e; },
  });
  try {
    await bridge.scan();
    appendFileSync(original, done('historical-turn', 'historical answer'));
    await bridge.scan();
    expect(bridge.owns('root', 'app')).toBe(true);
    expect(await bridge.receive('root', 'app', 'ou_another_member', 'follow-up', 'question')).toBe(true);
    await bridge.scan();
    await vi.waitFor(() => expect(turn).toHaveBeenCalledTimes(1));
    expect(fork).not.toHaveBeenCalled();
  } finally { bridge.stop(); rmSync(f.dir, { recursive: true, force: true }); }
});

it('skips botmux origins before their native session identity has been saved', async () => {
  const f = fixture();
  const topic = vi.fn(async (_b: { threadId: string }) => 'root'), reply = vi.fn(async () => {});
  const bridge = new CodexAutoBridge(f.cfg, f.stateFile, {
    topic, reply, turn: async () => {}, fork: async () => { throw new Error('unexpected fork'); },
    excluded: () => new Set(), error: e => { throw e; },
  });
  try {
    await bridge.scan();
    const path = file(f.homes[1], 'native');
    writeFileSync(path, JSON.stringify({ type: 'session_meta', payload: {
      id: 'native', cwd: f.homes[1], originator: 'botmux-codex-app', source: 'vscode',
    } }) + '\n' + done('native', 'already forwarded'));
    file(f.homes[0], 'vscode', done('vscode', 'external reply'));
    await bridge.scan();
    await vi.waitFor(() => expect(reply).toHaveBeenCalledTimes(1));
    expect(topic).toHaveBeenCalledTimes(1);
    expect(topic.mock.calls[0][0].threadId).toBe('vscode');
  } finally { bridge.stop(); rmSync(f.dir, { recursive: true, force: true }); }
});

it('stops forwarding and routing an existing binding when native botmux takes ownership, including restart', async () => {
  const f = fixture(); const excluded = new Set<string>();
  const reply = vi.fn(async () => {}), turn = vi.fn(async () => {});
  const deps = {
    topic: async () => 'root', reply, turn, fork: async () => { throw new Error('unexpected fork'); },
    excluded: () => excluded, error: (e: unknown) => { throw e; },
  };
  try {
    const bridge = new CodexAutoBridge(f.cfg, f.stateFile, deps);
    await bridge.scan();
    const path = file(f.homes[0], 'external', done('first', 'external reply'));
    await bridge.scan();
    await vi.waitFor(() => expect(reply).toHaveBeenCalledTimes(1));
    excluded.add('external');
    appendFileSync(path, done('second', 'native reply'));
    await bridge.scan();
    expect(bridge.owns('root', 'app')).toBe(false);
    expect(await bridge.receive('root', 'app', 'owner', 'q', 'do not send')).toBe(false);
    const restored = new CodexAutoBridge(f.cfg, f.stateFile, deps);
    await restored.scan();
    expect(restored.owns('root', 'app')).toBe(false);
    expect(reply).toHaveBeenCalledTimes(1);
    expect(turn).not.toHaveBeenCalled();
    // Stale persisted bindings must also be filtered by origin without store IDs.
    const lines = readFileSync(path, 'utf8').split('\n');
    const meta = JSON.parse(lines[0]); meta.payload.originator = 'botmux-codex-app';
    lines[0] = JSON.stringify(meta); writeFileSync(path, lines.join('\n'));
    excluded.clear();
    const byOrigin = new CodexAutoBridge(f.cfg, f.stateFile, deps);
    await byOrigin.scan();
    expect(byOrigin.owns('root', 'app')).toBe(false);
    expect(reply).toHaveBeenCalledTimes(1);
  } finally { rmSync(f.dir, { recursive: true, force: true }); }
});


it('creates topics from the exact original user message, never assistant-only or environment rows', async () => {
  const f = fixture(); const topic = vi.fn(async () => 'root'); const turn = vi.fn(async () => {}); const reply = vi.fn(async () => {});
  const bridge = new CodexAutoBridge(f.cfg, f.stateFile, { topic, turn, reply, excluded: () => new Set(), error: e => { throw e; } });
  try {
    await bridge.scan();
    const path = file(f.homes[0], 'main');
    const meta = readFileSync(path, 'utf8').split('\n')[0];
    writeFileSync(path, meta + '\n' + JSON.stringify({ type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '<environment_context>not a prompt</environment_context>' }] } }) + '\n' + done('hook', 'assistant Hook output'));
    await bridge.scan(); expect(topic).not.toHaveBeenCalled();
    const input = '  测试会话，从 vscode 原样同步。\n保留换行、空格和 /media/ubuntu 路径。\n';
    appendFileSync(path, JSON.stringify({ type: 'event_msg', payload: { type: 'user_message', message: input } }) + '\n');
    await bridge.scan(); expect(topic).toHaveBeenCalledTimes(1); expect(topic.mock.calls[0][0].firstUserMessage).toBe(input);
    expect(reply).not.toHaveBeenCalled(); expect(turn).not.toHaveBeenCalled();
  } finally { bridge.stop(); rmSync(f.dir, { recursive: true, force: true }); }
});

it('filters native subagents and newly discovered forks; main scans only forward and never invoke Codex', async () => {
  const f = fixture(); const topic = vi.fn(async b => 'root-' + b.threadId), turn = vi.fn(async () => {}), reply = vi.fn(async () => {}), fork = vi.fn();
  const deps = { topic, turn, reply, fork, excluded: () => new Set<string>(), error: e => { throw e; } };
  const bridge = new CodexAutoBridge(f.cfg, f.stateFile, deps);
  try {
    await bridge.scan();
    file(f.homes[0], 'main', done('main-turn', 'VS Code main result'));
    const child = file(f.homes[0], 'child', done('child-turn', 'different internal subagent result'));
    const lines = readFileSync(child, 'utf8').split('\n'); const m = JSON.parse(lines[0]); m.payload.forked_from_id = 'main'; m.payload.source = { subagent: { thread_spawn: { parent_thread_id: 'main' } } }; lines[0] = JSON.stringify(m); writeFileSync(child, lines.join('\n'));
    const forked = file(f.homes[0], 'branch', done('fork-turn', 'fork result'));
    const branch = readFileSync(forked, 'utf8').split('\n'); const fm = JSON.parse(branch[0]); fm.payload.forked_from_id = 'main'; branch[0] = JSON.stringify(fm); writeFileSync(forked, branch.join('\n'));
    await bridge.scan(); await vi.waitFor(() => expect(reply).toHaveBeenCalledTimes(1));
    expect(topic).toHaveBeenCalledTimes(1); expect(topic.mock.calls[0][0].threadId).toBe('main'); expect(reply.mock.calls[0][1]).toBe('VS Code main result');
    expect(turn).not.toHaveBeenCalled(); expect(fork).not.toHaveBeenCalled();
    // A previously leaked child topic becomes a tombstone, including after restart.
    const saved = JSON.parse(readFileSync(f.stateFile, 'utf8')); saved.bindings.leaked = { ...Object.values(saved.bindings)[0], threadId: 'child', rolloutPath: child, rootMessageId: 'leaked-root' }; writeFileSync(f.stateFile, JSON.stringify(saved));
    const restored = new CodexAutoBridge(f.cfg, f.stateFile, deps); await restored.scan();
    expect(restored.owns('leaked-root', 'app')).toBe(false);
    expect(await restored.receive('leaked-root', 'app', 'owner', 'duplicate', 'do not start work')).toBe(true);
    expect(turn).not.toHaveBeenCalled(); expect(topic).toHaveBeenCalledTimes(1);
  } finally { bridge.stop(); rmSync(f.dir, { recursive: true, force: true }); }
});


it('deduplicates the same thread copied across Codex libraries without starting work', async () => {
  const f = fixture(); const topic = vi.fn(async () => 'root'), reply = vi.fn(async () => {}), turn = vi.fn(async () => {});
  const bridge = new CodexAutoBridge(f.cfg, f.stateFile, { topic, reply, turn, excluded: () => new Set(), error: e => { throw e; } });
  try {
    await bridge.scan(); file(f.homes[0], 'same-thread', done('turn', 'one result')); file(f.homes[1], 'same-thread', done('turn', 'one result'));
    await bridge.scan(); await vi.waitFor(() => expect(reply).toHaveBeenCalledTimes(1));
    expect(topic).toHaveBeenCalledTimes(1); expect(turn).not.toHaveBeenCalled();
    await bridge.scan(); expect(topic).toHaveBeenCalledTimes(1); expect(Object.keys(JSON.parse(readFileSync(f.stateFile, 'utf8')).bindings)).toHaveLength(1);
  } finally { bridge.stop(); rmSync(f.dir, { recursive: true, force: true }); }
});


it('preserves an explicitly bound existing test fork and deduplicates repeated follow-up IDs', async () => {
  const f = fixture(); let turns = 0; const forkPath = file(f.homes[0], 'explicit-test');
  const lines = readFileSync(forkPath, 'utf8').split('\n'); const meta = JSON.parse(lines[0]); meta.payload.forked_from_id = 'original'; meta.payload.source = 'vscode'; lines[0] = JSON.stringify(meta); writeFileSync(forkPath, lines.join('\n'));
  const key = createHash('sha256').update(`${f.homes[0]}:explicit-test`).digest('hex');
  mkdirSync(join(f.dir, 'state'), { recursive: true });
  writeFileSync(f.stateFile, JSON.stringify({ initialized: true, startedAt: Date.now(), baselines: {}, bindings: { [key]: { threadId: 'explicit-test', rolloutPath: forkPath, cwd: f.homes[0], codexHome: f.homes[0], larkAppId: 'app', chatId: 'chat', ownerOpenId: 'owner', rootMessageId: 'explicit-root', readOnly: false } } }));
  const topic = vi.fn(async () => 'unexpected');
  const bridge = new CodexAutoBridge(f.cfg, f.stateFile, { topic, reply: async () => {}, turn: async (b, text, checkpoint) => { expect(b.threadId).toBe('explicit-test'); expect(text).toBe('exact user input'); checkpoint(); turns++; }, excluded: () => new Set(), error: e => { throw e; } });
  try {
    expect(await bridge.receive('explicit-root', 'app', 'owner', 'message-1', 'exact user input')).toBe(true);
    await bridge.receive('explicit-root', 'app', 'owner', 'message-1', 'exact user input');
    await bridge.scan(); await vi.waitFor(() => expect(turns).toBe(1));
    expect(topic).not.toHaveBeenCalled(); expect(JSON.parse(readFileSync(f.stateFile, 'utf8')).bindings[key].threadId).toBe('explicit-test');
  } finally { bridge.stop(); rmSync(f.dir, { recursive: true, force: true }); }
});
