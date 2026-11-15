import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { config } from '../src/config.js';
import { writeSessionModel, writeSessionModelRuntime, readSessionModel } from '../src/services/session-model-store.js';
import { sessionModelCardElements, buildSessionModelCard, sessionModelButton } from '../src/im/lark/session-model-card.js';
import { handleSessionModelAction } from '../src/im/lark/session-model-card-action.js';
import * as transcriptResolver from '../src/services/transcript-resolver.js';
import * as statistics from '../src/services/codex-session-statistics.js';

vi.mock('../src/services/codex-app-threads.js', () => ({ listCodexAppModels: vi.fn(async () => [
  { model: 'test-a', defaultReasoningEffort: 'medium', supportedReasoningEfforts: [{ reasoningEffort: 'medium' }, { reasoningEffort: 'high' }], serviceTiers: [{ id: 'priority' }] },
  { model: 'test-b', defaultReasoningEffort: 'low', supportedReasoningEfforts: [{ reasoningEffort: 'low' }] },
]) }));
vi.mock('../src/i18n/index.js', async importOriginal => ({ ...await importOriginal<typeof import('../src/i18n/index.js')>(), localeForBot: () => 'zh' }));
vi.mock('../src/services/session-store.js', () => ({ getSession: vi.fn(() => ({ workingDir: '/home/ubuntu/my/project' })) }));
const dirs: string[] = [];
const original = config.session.dataDir;
const temp = () => { const d = mkdtempSync(join(tmpdir(), 'model-card-')); dirs.push(d); config.session.dataDir = d; return d; };
afterEach(() => { vi.restoreAllMocks(); config.session.dataDir = original; dirs.splice(0).forEach(d => rmSync(d, { recursive: true, force: true })); });
const selection = { model: 'test-a', effort: 'medium', serviceTier: 'default' };
const context = (option: string, field = 'effort', id = 'session-a'): any => ({ actionType: 'session_model_set',
  value: { field }, action: { option }, rootId: 'root',
  ds: { session: { sessionId: id, cliId: 'codex-app', status: 'active', workingDir: tmpdir() }, larkAppId: 'app', worker: { send: vi.fn() } } });

describe('per-session model control card', () => {
  it('shows actual settings separately from pending changes and does not invent missing runtime values', () => {
    const d = temp();
    expect(JSON.stringify(sessionModelCardElements('a', 'codex-app'))).toContain('待回执');
    const first = writeSessionModel(d, 'a', selection);
    writeSessionModelRuntime(d, { sessionId: 'a', pid: process.pid, phase: 'running', revision: first.revision, selection });
    writeSessionModel(d, 'a', { ...selection, effort: 'high', serviceTier: 'priority' });
    const rows = JSON.stringify(sessionModelCardElements('a', 'codex-app'));
    expect(rows).toContain('test-a M F×');
    expect(rows).toContain('→ test-a H F√ 待生效');
    expect(rows).toContain('📁 /home/ubuntu/my/project');
    expect(sessionModelCardElements('a', 'codex-app')).toHaveLength(3);
    expect(sessionModelButton('a', { root_id: 'root' }, 'claude-code')).toEqual([]);
  });
  it('reads statistics once per card and keeps exactly three lines across content updates',()=>{
    temp();
    const resolve=vi.spyOn(transcriptResolver,'resolveSessionTranscriptPath').mockReturnValue({path:'/test-rollout',kind:'codex'});
    const read=vi.spyOn(statistics,'readCodexSessionStatistics').mockReturnValue({runningMs:1000,turns:1,tools:65,inputTokens:10000000,outputTokens:0,cachedTokens:8000000,incomplete:false});
    const first=sessionModelCardElements('snapshot','codex-app','zh','card-one');
    read.mockReturnValue({runningMs:9000,turns:2,tools:70,inputTokens:20000000,outputTokens:0,cachedTokens:10000000,incomplete:false});
    expect(sessionModelCardElements('snapshot','codex-app','zh','card-one')).toEqual(first);
    expect(first).toHaveLength(3);
    expect(first.map(r=>r.text.content).every(s=>!s.includes('\n'))).toBe(true);
    expect(read).toHaveBeenCalledTimes(1);expect(resolve).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(sessionModelCardElements('snapshot','codex-app','zh','card-two'))).toContain('工具 70次');
    expect(read).toHaveBeenCalledTimes(2);
  });
  it('labels a previous receipt without an offline warning or pretending it is current', () => {
    const d = temp();
    writeSessionModelRuntime(d, { sessionId: 'a', pid: 2147483647, phase: 'completed', selection });
    const rows = JSON.stringify(sessionModelCardElements('a', 'codex-app'));
    expect(rows).toContain('上次 test-a');
    expect(rows).not.toContain('运行器离线');
    expect(rows).not.toContain('当前');
    expect(JSON.stringify(sessionModelCardElements('a', 'codex-app', 'en'))).toContain('/home/ubuntu/my/project');
  });
  it('applies only to the bound session, preserving the other session and speed', async () => {
    const d = temp(); writeSessionModel(d, 'session-a', { ...selection, serviceTier: 'priority' });
    const other = writeSessionModel(d, 'session-b', selection);
    const result = await handleSessionModelAction(context('high'));
    expect(result.toast.type).toBe('success');
    expect(readSessionModel(d, 'session-a')).toMatchObject({ effort: 'high', serviceTier: 'priority' });
    expect(readSessionModel(d, 'session-b')).toEqual(other);
  });
  it('normalizes incompatible effort and fast when switching model, rejects unsupported fast', async () => {
    const d = temp(); writeSessionModel(d, 'session-a', { ...selection, effort: 'high', serviceTier: 'priority' });
    expect((await handleSessionModelAction(context('test-b', 'model'))).toast.type).toBe('success');
    expect(readSessionModel(d, 'session-a')).toMatchObject({ model: 'test-b', effort: 'low', serviceTier: 'default' });
    expect((await handleSessionModelAction(context('priority', 'serviceTier'))).toast.type).toBe('error');
    expect(readSessionModel(d, 'session-a')?.serviceTier).toBe('default');
  });
  it('rejects closed and adopted sessions without creating settings', async () => {
    const d = temp(); const c = context('high'); c.ds.session.status = 'closed';
    expect((await handleSessionModelAction(c)).toast.type).toBe('error');
    c.ds.session.status = 'active'; c.ds.adoptedFrom = 'tmux';
    expect((await handleSessionModelAction(c)).toast.type).toBe('error');
    expect(readSessionModel(d, 'session-a')).toBeUndefined();
  });
});
