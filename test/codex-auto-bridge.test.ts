import { it, expect, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, appendFileSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { CodexAutoBridge } from '../src/services/codex-auto-bridge.js';

const done = (id: string, text: string, timestamp = new Date().toISOString()) => JSON.stringify({ timestamp, type: 'event_msg', payload: { type: 'task_complete', turn_id: id, last_agent_message: text } }) + '\n';
function file(home: string, id: string, body = '') {
  mkdirSync(join(home, 'sessions'), { recursive: true });
  const path = join(home, 'sessions', `rollout-${id}.jsonl`);
  writeFileSync(path, JSON.stringify({ type: 'session_meta', payload: { id, cwd: home } }) + '\n' + body);
  return path;
}
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'codex-auto-'));
  const homes = [join(dir, 'default'), join(dir, 'botmux')];
  const cfg = { codexHomes: homes, larkAppId: 'app', chatId: 'chat', ownerOpenId: 'owner' };
  const stateFile = join(dir, 'state', 'registry.json');
  return { dir, homes, cfg, stateFile };
}

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

it('forks an existing archive once, persists its reply mapping, and leaves the original untouched', async () => {
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
    const before = readFileSync(original, 'utf8');
    await bridge.receive('root', 'app', 'owner', 'q1', 'first'); await bridge.scan();
    await vi.waitFor(() => expect(turns).toBe(1));
    const restored = new CodexAutoBridge(f.cfg, f.stateFile, deps);
    await restored.receive('root', 'app', 'owner', 'q2', 'second'); await restored.scan();
    await vi.waitFor(() => expect(turns).toBe(2));
    expect(forks).toBe(1); expect(readFileSync(original, 'utf8')).toBe(before);
  } finally { rmSync(f.dir, { recursive: true, force: true }); }
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
