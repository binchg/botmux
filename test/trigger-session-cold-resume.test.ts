import { beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ fork: vi.fn(), create: vi.fn(), post: vi.fn(), remember: vi.fn() }));
vi.mock('../src/core/worker-pool.js', () => ({ forkWorker: mocks.fork, getCurrentCliVersion: () => 'test' }));
vi.mock('../src/core/session-manager.js', () => ({
  buildFollowUpContent: (p: string) => p, buildNewTopicPrompt: (p: string) => p,
  ensureSessionWhiteboard: vi.fn(), getAvailableBots: async () => [], rememberLastCliInput: mocks.remember,
}));
vi.mock('../src/core/session-activity.js', () => ({ markSessionActivity: vi.fn() }));
vi.mock('../src/services/session-store.js', () => ({ createSession: mocks.create, updateSession: vi.fn() }));
vi.mock('../src/services/groups-store.js', () => ({ isInChat: async () => true }));
vi.mock('../src/services/chat-reply-mode-store.js', () => ({ resolveRegularGroupMode: () => 'new-topic' }));
vi.mock('../src/im/lark/client.js', () => ({ sendMessage: mocks.post, getChatMode: async () => 'topic' }));
vi.mock('../src/bot-registry.js', async (original) => ({
  ...await original<typeof import('../src/bot-registry.js')>(),
  getBot: () => ({ config: { cliId: 'codex', locale: 'en' }, botName: 'test', botOpenId: 'test' }),
}));
import { triggerSessionTurn } from '../src/core/trigger-session.js';
import type { DaemonSession } from '../src/core/types.js';
import type { TriggerRequest } from '../src/services/trigger-types.js';
function fixture(worker: any = null) {
  const ds = { session: { sessionId: 'original', rootMessageId: 'original-root', cliId: 'codex' },
    worker, workerPort: worker && !worker.killed ? 1234 : null, chatId: 'chat', larkAppId: 'app', scope: 'thread', hasHistory: true } as DaemonSession;
  const activeSessions = new Map([['original-key', ds]]);
  const req: TriggerRequest = { source: { type: 'ui' }, target: { kind: 'turn', sessionId: 'original' },
    envelope: { sourceName: 'Windows post-reboot continuation', format: 'json', trusted: false } };
  return { ds, activeSessions, req };
}
beforeEach(() => {
  vi.clearAllMocks();
  mocks.fork.mockImplementation(ds => { ds.worker = { killed: false, exitCode: null, signalCode: null, send: vi.fn() }; });
});
describe('explicit trigger session keeps its original thread', () => {
  it.each([null, { killed: true }])('cold or killed worker resumes original history (%s)', async worker => {
    const { ds, activeSessions, req } = fixture(worker);
    const result = await triggerSessionTurn(req, { larkAppId: 'app', activeSessions });
    expect(result.ok).toBe(true); expect(result.target?.sessionId).toBe('original');
    expect(mocks.fork).toHaveBeenCalledWith(ds, expect.stringContaining('post-reboot'), true, undefined);
    expect(mocks.create).not.toHaveBeenCalled(); expect(mocks.post).not.toHaveBeenCalled();
    expect(activeSessions.size).toBe(1); expect(ds.session.rootMessageId).toBe('original-root');
  });
  it('live worker receives the turn without respawning', async () => {
    const worker = { killed: false, exitCode: null, signalCode: null, send: vi.fn() }; const { req, activeSessions } = fixture(worker);
    await triggerSessionTurn(req, { larkAppId: 'app', activeSessions });
    expect(worker.send).toHaveBeenCalledOnce(); expect(mocks.fork).not.toHaveBeenCalled();
  });
  it('async cold resume keeps both original session and turn correlation', async () => {
    const { ds, req, activeSessions } = fixture(); req.options = { asyncReturnSessionId: true };
    const result = await triggerSessionTurn(req, { larkAppId: 'app', activeSessions });
    expect(result.target?.sessionId).toBe('original');
    expect(mocks.fork).toHaveBeenCalledWith(ds, expect.any(String), true, result.triggerId);
    expect(ds.asyncTriggerResults?.has(result.triggerId!)).toBe(true);
  });
  it('waiting cold resume resolves the correlated output', async () => {
    const { ds, req, activeSessions } = fixture(); req.options = { waitForFinalOutput: true, timeoutMs: 1000 };
    mocks.fork.mockImplementationOnce((_ds, _prompt, _resume, turnId) => ds.pendingWaitPromises!.get(turnId)!.resolve('done'));
    const result = await triggerSessionTurn(req, { larkAppId: 'app', activeSessions });
    expect(result.output?.content).toBe('done'); expect(result.target?.sessionId).toBe('original');
    expect(mocks.create).not.toHaveBeenCalled();
  });
  it('missing explicit session fails instead of creating a topic', async () => {
    const { req } = fixture(); const result = await triggerSessionTurn(req, { larkAppId: 'app', activeSessions: new Map() });
    expect(result.errorCode).toBe('session_not_found'); expect(mocks.create).not.toHaveBeenCalled(); expect(mocks.post).not.toHaveBeenCalled();
  });
  it('failed worker resume reports failure without opening another topic', async () => {
    const { req, activeSessions } = fixture();
    mocks.fork.mockImplementationOnce(() => { throw new Error('resume failed'); });
    await expect(triggerSessionTurn(req, { larkAppId: 'app', activeSessions })).rejects.toThrow('resume failed');
    expect(mocks.create).not.toHaveBeenCalled(); expect(mocks.post).not.toHaveBeenCalled();
    expect(activeSessions.size).toBe(1);
  });

});
