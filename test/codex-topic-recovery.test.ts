import { it, expect, vi } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { recoverCodexTopic } from '../src/services/codex-topic-recovery.js';

it('reuses only a verified root mapped to the same native session and chat', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'codex-topic-'));
  try {
    writeFileSync(join(dir, 'history.json'), JSON.stringify({ source: { cliSessionId: 'old-session' },
      nativeSource: { larkAppId: 'bot', rootMessageId: 'om_correct' } }));
    const get = vi.fn(async () => ({ items: [{ chat_id: 'chat', msg_type: 'text', body: { content: '{"text":"Real topic"}' } }] }));
    expect(await recoverCodexTopic(dir, 'old-session', 'bot', 'chat', get)).toBe('om_correct');
    expect(await recoverCodexTopic(dir, 'new-session', 'bot', 'chat', get)).toBeUndefined();
    expect(get).toHaveBeenCalledTimes(1);
    expect(await recoverCodexTopic(dir, 'old-session', 'bot', 'other-chat', get)).toBeUndefined();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

it('does not reuse an injected plugin topic or create a duplicate on lookup failure', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'codex-topic-'));
  try {
    writeFileSync(join(dir, 'history.json'), JSON.stringify({ source: { cliSessionId: 'old-session' },
      nativeSource: { larkAppId: 'bot', rootMessageId: 'om_old' } }));
    expect(await recoverCodexTopic(dir, 'old-session', 'bot', 'chat', async () => ({ items: [{ chat_id: 'chat',
      body: { content: '{"text":"<recommended_plugins>private</recommended_plugins>"}' } }] }))).toBeUndefined();
    await expect(recoverCodexTopic(dir, 'old-session', 'bot', 'chat', async () => { throw Error('api unavailable'); }))
      .rejects.toThrow('api unavailable');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
