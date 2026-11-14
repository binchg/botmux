import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { config } from '../src/config.js';
import { buildNewSessionSetupCard, pendingNewSessionModelSetup } from '../src/im/lark/new-session-setup.js';
import { handleNewSessionSetupAction } from '../src/im/lark/new-session-setup-action.js';
import { readSessionModel } from '../src/services/session-model-store.js';
import { readCodexAppModelSetup } from '../src/services/codex-app-threads.js';
import { announcePendingRepoSession } from '../src/core/session-activity.js';
import { commitRepoSelection } from '../src/im/lark/card-action-repo-selection.js';
import { rememberSessionStartPreferences, readSessionStartPreferences } from '../src/services/session-start-preferences.js';
import { getBot } from '../src/bot-registry.js';
vi.mock('../src/services/codex-app-threads.js', () => ({ readCodexAppModelSetup: vi.fn() }));
vi.mock('../src/bot-registry.js', () => ({ getBot: vi.fn(() => ({ config: { cliId: 'codex-app', requireWorkingDirSelection: true, workingDirPresets: [tmpdir()] } })) }));
vi.mock('../src/services/session-store.js', () => ({ listSessions: () => [] }));
vi.mock('../src/core/session-activity.js', () => ({ announcePendingRepoSession: vi.fn() }));
vi.mock('../src/core/session-manager.js', () => ({ getSessionWorkingDir: () => tmpdir() }));
vi.mock('../src/im/lark/card-action-repo-selection.js', () => ({ commitRepoSelection: vi.fn(async ({ ds }, path) => { ds.pendingRepo = false; ds.session.workingDir = path; }) }));
vi.mock('../src/im/lark/client.js', () => ({ deleteMessage: vi.fn(async () => {}) }));
vi.mock('../src/i18n/index.js', () => ({ localeForBot: () => 'zh', t: (key: string) => key }));
const models = [
  { model: 'model-a', defaultReasoningEffort: 'medium', supportedReasoningEfforts: [{ reasoningEffort: 'medium' }, { reasoningEffort: 'high' }], serviceTiers: [{ id: 'priority' }] },
  { model: 'model-b', defaultReasoningEffort: 'low', supportedReasoningEfforts: [{ reasoningEffort: 'low' }] },
];
let dir: string; const originalDir = config.session.dataDir;
const ds = (): any => ({ session: { sessionId: 'new-session', cliId: 'codex-app', status: 'active', ownerOpenId: 'owner' }, larkAppId: 'nene', chatId: 'chat', pendingRepo: true, pendingPrompt: 'original task', worker: null });
const context = (d: any, actionType: string, extra: any = {}): any => ({ ds: d, actionType, rootId: 'root', sKey: 'root::nene', value: {}, action: {}, larkAppId: 'nene', cardMessageId: 'old-card', operatorOpenId: 'owner', activeSessions: new Map([['root::nene', d]]), sessionReply: vi.fn(async () => 'directory-card'), lastRepoScan: new Map(), ...extra });
beforeEach(() => { vi.clearAllMocks(); dir = mkdtempSync(join(tmpdir(), 'new-session-setup-')); config.session.dataDir = dir;
  vi.mocked(readCodexAppModelSetup).mockResolvedValue({ models, defaults: { model: 'model-a', model_reasoning_effort: 'medium', service_tier: 'default' } });
});
afterEach(() => { config.session.dataDir = originalDir; rmSync(dir, { recursive: true, force: true }); });
describe('model before working-directory session setup', () => {
  it('starts with model/effort/Fast, keeps current defaults, buffers prompt and never starts CLI', async () => {
    const d = ds(); const card = await buildNewSessionSetupCard(d, [], 'root', tmpdir());
    expect(card).toContain('第 1/2 步'); expect(card).toContain('new_session_model_next'); expect(card).not.toContain('repo_manual_form');
    expect(readSessionModel(dir, 'new-session')).toMatchObject({ model: 'model-a', effort: 'medium', serviceTier: 'default' });
    expect(d.pendingPrompt).toBe('original task'); expect(d.worker).toBeNull(); expect(d.session.pendingRepoSelection.modelSetupPending).toBe(true);
    expect(announcePendingRepoSession).toHaveBeenCalled();
  });
  it('saves effort and Fast, advances to directory without a CLI, starts only once after valid selection', async () => {
    const d = ds(); await buildNewSessionSetupCard(d, [], 'root', tmpdir());
    await handleNewSessionSetupAction(context(d, 'new_session_model_set', { value: { field: 'effort' }, action: { option: 'high' } }));
    await handleNewSessionSetupAction(context(d, 'new_session_model_set', { value: { field: 'serviceTier' }, action: { option: 'priority' } }));
    const c = context(d, 'new_session_model_next'); const result = await handleNewSessionSetupAction(c);
    expect(result.toast.type).toBe('success'); expect(c.sessionReply.mock.calls[0][1]).toContain('预设目录');
    expect(c.sessionReply.mock.calls[0][1]).toContain('repo_manual_form'); expect(d.worker).toBeNull(); expect(commitRepoSelection).not.toHaveBeenCalled();
    expect(readSessionModel(dir, 'new-session')).toMatchObject({ effort: 'high', serviceTier: 'priority' });
    expect(pendingNewSessionModelSetup(d)).toBe(false);
    const choose = context(d, 'new_session_directory_select', { action: { option: tmpdir() } });
    expect((await handleNewSessionSetupAction(choose)).toast.type).toBe('success');
    expect((await handleNewSessionSetupAction(choose)).toast.type).toBe('error'); expect(commitRepoSelection).toHaveBeenCalledTimes(1);
  });
  it('normalizes incompatible options on model change and rejects unavailable Fast', async () => {
    const d = ds(); await buildNewSessionSetupCard(d, [], 'root', tmpdir());
    const choose = (field: string, option: string) => handleNewSessionSetupAction(context(d, 'new_session_model_set', { value: { field }, action: { option } }));
    await choose('serviceTier', 'priority'); await choose('model', 'model-b');
    expect(readSessionModel(dir, 'new-session')).toMatchObject({ model: 'model-b', effort: 'low', serviceTier: 'default' });
    expect((await choose('serviceTier', 'priority')).toast.type).toBe('error');
  });
  it('cannot skip model confirmation, rejects missing directory and stale session', async () => {
    const d = ds(); await buildNewSessionSetupCard(d, [], 'root', tmpdir());
    expect((await handleNewSessionSetupAction(context(d, 'new_session_directory_select', { action: { option: tmpdir() } }))).toast.type).toBe('error');
    await handleNewSessionSetupAction(context(d, 'new_session_model_next'));
    expect((await handleNewSessionSetupAction(context(d, 'new_session_directory_select', { action: { option: '/does-not-exist' } }))).toast.type).toBe('error');
    d.session.status = 'closed'; expect((await handleNewSessionSetupAction(context(d, 'new_session_model_next'))).toast.type).toBe('error');
    expect(commitRepoSelection).not.toHaveBeenCalled();
  });
  it('retains stage on delivery failure and resumes the confirmed directory stage after restoration', async () => {
    const d = ds(); await buildNewSessionSetupCard(d, [], 'root', tmpdir());
    const c = context(d, 'new_session_model_next', { sessionReply: vi.fn(async () => { throw new Error('offline'); }) });
    expect((await handleNewSessionSetupAction(c)).toast.type).toBe('error'); expect(pendingNewSessionModelSetup(d)).toBe(true);
    await handleNewSessionSetupAction(context(d, 'new_session_model_next'));
    const restored = { ...d, session: JSON.parse(JSON.stringify(d.session)), worker: null };
    const card = await buildNewSessionSetupCard(restored, [], 'root', tmpdir());
    expect(card).toContain('第 2/2 步'); expect(card).not.toContain('new_session_model_next'); expect(commitRepoSelection).not.toHaveBeenCalled();
  });
  it('shows retry on catalog failure, keeps pending and does not silently launch', async () => {
    vi.mocked(readCodexAppModelSetup).mockRejectedValueOnce(new Error('offline'));
    const d = ds(); const card = await buildNewSessionSetupCard(d, [], 'root', tmpdir());
    expect(card).toContain('new_session_model_retry'); expect(d.pendingRepo).toBe(true); expect(d.worker).toBeNull();
    const retry = await handleNewSessionSetupAction(context(d, 'new_session_model_retry'));
    expect(JSON.stringify(retry.card)).toContain('new_session_model_next');
  });
  it('prefills last confirmed model/effort/Fast and directory and offers an explicit one-click start', async () => {
    rememberSessionStartPreferences(dir, 'nene', { model: 'model-b', effort: 'low', serviceTier: 'default', sessionId: 'previous-session', revision: 'old-revision' } as any, tmpdir());
    expect(readSessionStartPreferences(dir, 'nene')?.selection).not.toHaveProperty('revision');
    rememberSessionStartPreferences(dir, 'other-bot', { model: 'model-a', effort: 'high', serviceTier: 'priority' }, '/unrelated');
    const d = ds(); const card = await buildNewSessionSetupCard(d, [], 'root', tmpdir());
    expect(card).toContain('new_session_quick_start'); expect(card).toContain('确认配置并开始'); expect(card).toContain(tmpdir());
    expect(readSessionModel(dir, 'new-session')).toMatchObject({ model: 'model-b', effort: 'low', serviceTier: 'default' });
    expect(commitRepoSelection).not.toHaveBeenCalled();
    const result = await handleNewSessionSetupAction(context(d, 'new_session_quick_start', { value: { working_dir: tmpdir() } }));
    expect(result.toast.type).toBe('success'); expect(commitRepoSelection).toHaveBeenCalledTimes(1);
    expect((await handleNewSessionSetupAction(context(d, 'new_session_quick_start', { value: { working_dir: tmpdir() } }))).toast.type).toBe('error');
    expect(commitRepoSelection).toHaveBeenCalledTimes(1);
    expect(readSessionStartPreferences(dir, 'other-bot')?.workingDir).toBe('/unrelated');
  });
  it('offers custom model controls without starting, and hides an invalid last directory', async () => {
    rememberSessionStartPreferences(dir, 'nene', { model: 'model-a', effort: 'high', serviceTier: 'priority' }, '/missing/last-directory');
    const d = ds(); const card = await buildNewSessionSetupCard(d, [], 'root', tmpdir());
    expect(card).not.toContain('new_session_quick_start');
    const custom = await handleNewSessionSetupAction(context(d, 'new_session_customize'));
    expect(JSON.stringify(custom.card)).toContain('new_session_model_set'); expect(JSON.stringify(custom.card)).toContain('new_session_model_next');
    expect(readSessionModel(dir, 'new-session')).toMatchObject({ effort: 'high', serviceTier: 'priority' });
    expect(commitRepoSelection).not.toHaveBeenCalled();
  });
  it('ignores unavailable remembered models and uses current configured defaults', async () => {
    rememberSessionStartPreferences(dir, 'nene', { model: 'removed-model', effort: 'high', serviceTier: 'priority' }, tmpdir());
    await buildNewSessionSetupCard(ds(), [], 'root', tmpdir());
    expect(readSessionModel(dir, 'new-session')).toMatchObject({ model: 'model-a', effort: 'medium', serviceTier: 'default' });
  });
  it('does not gate another bot that has not enabled explicit new-session choices', async () => {
    vi.mocked(getBot).mockReturnValueOnce({ config: { cliId: 'codex-app' } } as any);
    const d = ds(); expect(pendingNewSessionModelSetup(d)).toBe(false);
  });
});
