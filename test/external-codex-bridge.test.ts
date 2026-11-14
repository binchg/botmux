import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync, appendFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ExternalCodexBridge, consumeExternalCodex, type ExternalCodexCursor } from '../src/services/external-codex-bridge.js';

const event = (payload: unknown) => JSON.stringify({ type: 'event_msg', payload }) + '\n';
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'external-codex-'));
  const rolloutPath = join(dir, 'rollout.jsonl');
  writeFileSync(rolloutPath, JSON.stringify({ type: 'session_meta', payload: { id: 'fork' } }) + '\n' + event({ type: 'task_complete', turn_id: 'old', last_agent_message: 'archive' }));
  const binding = { threadId: 'fork', rolloutPath, cwd: dir, chatId: 'chat', larkAppId: 'app', rootMessageId: 'root', ownerOpenId: 'owner' };
  return { dir, rolloutPath, binding, stateFile: join(dir, 'state.json'), cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}
describe('external Codex fork bridge', () => {
  it('does not replay history, retries a failed delivery with the same UUID, and deduplicates completion copies after restart', async () => {
    const f = fixture();
    const deliveries: Array<{ text: string; uuid: string }> = [];
    let failed = false;
    const deps = { reply: async (_: unknown, text: string, uuid: string) => {
      deliveries.push({ text, uuid });
      if (!failed) { failed = true; throw new Error('network'); }
    }, turn: async () => {}, error: () => {} };
    try {
      const bridge = new ExternalCodexBridge([f.binding], f.stateFile, deps);
      await bridge.tick();
      expect(deliveries).toEqual([]);
      const completed = event({ type: 'task_complete', turn_id: 'new', last_agent_message: '测试回复' });
      appendFileSync(f.rolloutPath, completed);
      await expect(bridge.tick()).rejects.toThrow('network');
      const restored = new ExternalCodexBridge([f.binding], f.stateFile, deps);
      await restored.tick();
      expect(deliveries).toHaveLength(2);
      expect(deliveries[0]).toEqual(deliveries[1]);
      appendFileSync(f.rolloutPath, completed);
      await restored.tick();
      expect(deliveries).toHaveLength(2);
    } finally { f.cleanup(); }
  });
  it('waits for the running UI turn, rejects other senders, and persists input deduplication', async () => {
    const f = fixture(); const turns: string[] = [];
    appendFileSync(f.rolloutPath, event({ type: 'task_started' }));
    const deps = { reply: async () => {}, turn: async (_: unknown, text: string, checkpoint: () => void) => { checkpoint(); turns.push(text); }, error: () => {} };
    try {
      const bridge = new ExternalCodexBridge([f.binding], f.stateFile, deps);
      expect(await bridge.receive('elsewhere', 'app', 'owner', 'm0', 'wrong')).toBe(false);
      await bridge.receive('root', 'app', 'stranger', 'm1', 'wrong');
      await bridge.receive('root', 'app', 'owner', 'm2', 'follow up');
      await bridge.tick(); expect(turns).toEqual([]);
      appendFileSync(f.rolloutPath, event({ type: 'task_complete', turn_id: 'ui' }));
      await bridge.tick(); expect(turns).toEqual(['follow up']);
      const restored = new ExternalCodexBridge([f.binding], f.stateFile, deps);
      await restored.receive('root', 'app', 'owner', 'm2', 'follow up');
      await restored.tick(); expect(turns).toHaveLength(1);
    } finally { f.cleanup(); }
  });
  it('does not resubmit an uncertain started input after restart', async () => {
    const f = fixture(); let calls = 0;
    const deps = { reply: async () => {}, turn: async (_: unknown, _text: string, checkpoint: () => void) => { calls++; checkpoint(); throw new Error('crash'); }, error: () => {} };
    try {
      const bridge = new ExternalCodexBridge([f.binding], f.stateFile, deps);
      await bridge.receive('root', 'app', 'owner', 'm', 'question');
      await expect(bridge.tick()).rejects.toThrow('crash');
      await new ExternalCodexBridge([f.binding], f.stateFile, deps).tick();
      expect(calls).toBe(1);
    } finally { f.cleanup(); }
  });
  it('preserves a split UTF-8 completion line and refuses mismatched metadata', async () => {
    const f = fixture(); const delivered: string[] = [];
    const deps = { reply: async (_: unknown, text: string) => { delivered.push(text); }, turn: async () => {}, error: () => {} };
    try {
      const bridge = new ExternalCodexBridge([f.binding], f.stateFile, deps);
      const data = Buffer.from(event({ type: 'task_complete', turn_id: 'unicode', last_agent_message: '中文' }));
      const cut = data.indexOf(Buffer.from('中文')) + 1;
      appendFileSync(f.rolloutPath, data.subarray(0, cut)); await bridge.tick(); expect(delivered).toEqual([]);
      appendFileSync(f.rolloutPath, data.subarray(cut)); await bridge.tick(); expect(delivered).toEqual(['中文']);
      expect(() => new ExternalCodexBridge([{ ...f.binding, threadId: 'original' }], f.stateFile, deps)).toThrow('metadata mismatch');
    } finally { f.cleanup(); }
  });
});
