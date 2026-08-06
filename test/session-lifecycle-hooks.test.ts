import { EventEmitter } from 'node:events';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { emitHookEventMock, updateMessageMock, deleteMessageMock } = vi.hoisted(() => ({
  emitHookEventMock: vi.fn(),
  updateMessageMock: vi.fn(async () => {}),
  deleteMessageMock: vi.fn(async () => {}),
}));

vi.mock('../src/services/hook-runner.js', () => ({
  emitHookEvent: (...args: unknown[]) => emitHookEventMock(...args),
}));

vi.mock('../src/im/lark/client.js', () => {
  class MessageWithdrawnError extends Error {
    constructor(id: string) { super(`withdrawn: ${id}`); this.name = 'MessageWithdrawnError'; }
  }
  return {
    updateMessage: (...args: unknown[]) => updateMessageMock(...args),
    deleteMessage: (...args: unknown[]) => deleteMessageMock(...args),
    MessageWithdrawnError,
  };
});

vi.mock('../src/im/lark/card-builder.js', () => ({
  buildStreamingCard: vi.fn(() => '{"type":"streaming"}'),
  buildSessionCard: vi.fn(() => '{"type":"session"}'),
  buildTuiPromptCard: vi.fn(() => '{"type":"tui"}'),
  buildTuiPromptResolvedCard: vi.fn(() => '{"type":"tui-resolved"}'),
  getCliDisplayName: vi.fn(() => 'Claude'),
}));

vi.mock('../src/bot-registry.js', () => ({
  getBot: vi.fn(() => ({
    config: { larkAppId: 'app_test', larkAppSecret: 'secret', cliId: 'claude-code' },
    resolvedAllowedUsers: [],
    botOpenId: 'ou_bot',
    botName: 'TestBot',
  })),
  getAllBots: vi.fn(() => []),
}));

vi.mock('../src/config.js', () => ({
  config: {
    web: { externalHost: 'localhost' },
    session: { dataDir: '/tmp/test-sessions' },
    daemon: { backendType: 'tmux', cliId: 'claude-code' },
  },
}));

vi.mock('../src/services/session-store.js', () => ({
  closeSession: vi.fn(),
  updateSession: vi.fn(),
  updateSessionPid: vi.fn(),
}));

vi.mock('../src/services/frozen-card-store.js', () => ({
  loadFrozenCards: vi.fn(() => new Map()),
  saveFrozenCards: vi.fn(),
}));

vi.mock('../src/core/session-manager.js', () => ({
  ensureSessionWhiteboard: vi.fn(),
  persistStreamCardState: vi.fn(),
}));

vi.mock('../src/core/dashboard-events.js', () => ({
  dashboardEventBus: { publish: vi.fn() },
}));

vi.mock('../src/core/dashboard-rows.js', () => ({
  composeRowFromActive: vi.fn(() => ({ tokenUsage: null })),
}));

vi.mock('../src/skills/installer.js', () => ({
  ensureSkills: vi.fn(),
}));

vi.mock('../src/adapters/cli/registry.js', () => ({
  createCliAdapterSync: vi.fn(),
}));

vi.mock('../src/adapters/cli/claude-code.js', () => ({
  claudeJsonlPathForSession: vi.fn(),
}));

vi.mock('../src/adapters/backend/tmux-backend.js', () => ({
  TmuxBackend: class {},
}));

vi.mock('../src/utils/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() },
}));

vi.mock('@larksuiteoapi/node-sdk', () => ({
  Client: class { constructor() {} },
  WSClient: class { start() {} },
  EventDispatcher: class { register() {} },
  LoggerLevel: { info: 2 },
}));

import {
  __testOnly_resetSessionLifecycleHooks,
  emitSessionLifecycleHook,
  emitSessionStateTransitionHook,
  setSessionLifecycleShutdown,
} from '../src/services/session-lifecycle-hooks.js';
import {
  beginCodexAppProgressTurn,
  initWorkerPool,
  __testOnly_setupWorkerHandlers,
} from '../src/core/worker-pool.js';
import type { DaemonSession } from '../src/core/types.js';
import { commitTerminalSend, prepareTerminalSend } from '../src/services/terminal-send-barrier.js';

function makeFakeWorker() {
  const worker = new EventEmitter() as any;
  worker.killed = false;
  worker.send = vi.fn();
  worker.kill = vi.fn();
  worker.pid = 12345;
  worker.stdout = new EventEmitter();
  worker.stderr = new EventEmitter();
  return worker;
}

function makeDs(overrides?: Partial<DaemonSession>): DaemonSession {
  return {
    session: {
      sessionId: 'sid-lifecycle-test',
      rootMessageId: 'om_root',
      chatId: 'oc_chat',
      title: 'Lifecycle Test',
      status: 'active',
      createdAt: new Date('2026-05-27T00:00:00.000Z').toISOString(),
      chatType: 'group',
      cliId: 'claude-code',
      workingDir: '/repo',
    },
    worker: makeFakeWorker(),
    workerPort: 9999,
    workerToken: 'tok',
    larkAppId: 'app_test',
    chatId: 'oc_chat',
    chatType: 'group',
    scope: 'thread',
    spawnedAt: 1234,
    cliVersion: '1.0',
    lastMessageAt: 5678,
    hasHistory: false,
    workingDir: '/repo',
    displayMode: 'hidden',
    streamCardId: 'om_card',
    streamCardNonce: 'nonce',
    lastScreenContent: '',
    lastScreenStatus: 'working',
    currentTurnTitle: 'Lifecycle Test',
    ...overrides,
  } as DaemonSession;
}

async function flush(): Promise<void> {
  await new Promise(resolve => setTimeout(resolve, 0));
}

beforeEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
  __testOnly_resetSessionLifecycleHooks();
});

describe('session lifecycle hook helper', () => {
  it('emits session.start payload with session context', () => {
    emitSessionLifecycleHook(makeDs(), 'session.start', { reason: 'new_topic' });

    expect(emitHookEventMock).toHaveBeenCalledWith('session.start', expect.objectContaining({
      sessionId: 'sid-lifecycle-test',
      chatId: 'oc_chat',
      chatType: 'group',
      larkAppId: 'app_test',
      scope: 'thread',
      anchor: 'om_root',
      title: 'Lifecycle Test',
      cliId: 'claude-code',
      workingDir: '/repo',
      reason: 'new_topic',
    }));
  });

  it('deduplicates repeated session.idle transitions for 10 seconds', () => {
    vi.useFakeTimers();
    const ds = makeDs();

    emitSessionStateTransitionHook(ds, 'working', 'idle', { source: 'screen_update' });
    emitSessionStateTransitionHook(ds, 'working', 'idle', { source: 'screen_update' });
    expect(emitHookEventMock).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(10_001);
    emitSessionStateTransitionHook(ds, 'working', 'idle', { source: 'screen_update' });
    expect(emitHookEventMock).toHaveBeenCalledTimes(2);
  });

  it('silences session.exit while daemon shutdown is active', () => {
    setSessionLifecycleShutdown(true);

    emitSessionLifecycleHook(makeDs(), 'session.exit', { reason: 'daemon_shutdown' });

    expect(emitHookEventMock).not.toHaveBeenCalled();
  });

  it('prunes lastIdleEmits entries for the session on session.exit', () => {
    vi.useFakeTimers();
    const ds = makeDs();

    emitSessionStateTransitionHook(ds, 'working', 'idle', { source: 'screen_update' });
    expect(emitHookEventMock).toHaveBeenCalledTimes(1);

    // session.exit should prune dedup state
    emitSessionLifecycleHook(ds, 'session.exit', { reason: 'exit_code_0' });

    // After exit prune, re-idle for same session should fire again immediately
    vi.advanceTimersByTime(0);
    emitSessionStateTransitionHook(ds, 'working', 'idle', { source: 'screen_update' });
    // session.exit + second idle = 3 total calls
    expect(emitHookEventMock).toHaveBeenCalledTimes(3);
  });
});

describe('worker-pool lifecycle hook integration', () => {
  let sessionReplyMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    sessionReplyMock = vi.fn(async () => 'om_reply');
    initWorkerPool({
      sessionReply: sessionReplyMock,
      getSessionWorkingDir: () => '/repo',
      getActiveCount: () => 1,
      closeSession: vi.fn(),
    });
  });

  it('emits session.idle on screen_update status edges', async () => {
    const worker = makeFakeWorker();
    const ds = makeDs({ worker, lastScreenStatus: 'working' });
    __testOnly_setupWorkerHandlers(ds, worker);

    worker.emit('message', { type: 'screen_update', content: 'ready', status: 'idle' });
    await flush();

    expect(emitHookEventMock).toHaveBeenCalledWith('session.idle', expect.objectContaining({
      sessionId: 'sid-lifecycle-test',
      prevState: 'working',
      newState: 'idle',
      source: 'screen_update',
    }));
  });

  it('reuses the idle transition helper for screenshot_uploaded status edges', async () => {
    const worker = makeFakeWorker();
    const ds = makeDs({ worker, lastScreenStatus: 'working' });
    __testOnly_setupWorkerHandlers(ds, worker);

    worker.emit('message', { type: 'screenshot_uploaded', imageKey: 'img', status: 'idle' });
    await flush();

    expect(emitHookEventMock).toHaveBeenCalledWith('session.idle', expect.objectContaining({
      sessionId: 'sid-lifecycle-test',
      prevState: 'working',
      newState: 'idle',
      source: 'screenshot_uploaded',
    }));
  });

  it('emits session.requires_attention from tui_prompt and user_notify IPC', async () => {
    const worker = makeFakeWorker();
    const ds = makeDs({ worker });
    __testOnly_setupWorkerHandlers(ds, worker);

    worker.emit('message', {
      type: 'tui_prompt',
      description: 'Approve command?',
      options: [{ text: 'Yes', selected: false }],
      multiSelect: false,
    });
    worker.emit('message', { type: 'user_notify', message: 'Need manual input' });
    await flush();

    expect(emitHookEventMock).toHaveBeenCalledWith('session.requires_attention', expect.objectContaining({
      reason: 'tui_prompt',
      description: 'Approve command?',
      optionsCount: 1,
    }));
    expect(emitHookEventMock).toHaveBeenCalledWith('session.requires_attention', expect.objectContaining({
      reason: 'user_notify',
      message: 'Need manual input',
    }));
  });

  it('emits session.exit and posts a persistent attention reply from unexpected worker exit', async () => {
    const worker = makeFakeWorker();
    const ds = makeDs({ worker });
    __testOnly_setupWorkerHandlers(ds, worker);

    worker.emit('exit', 1);
    await flush();

    expect(emitHookEventMock).toHaveBeenCalledWith('session.exit', expect.objectContaining({
      sessionId: 'sid-lifecycle-test',
      reason: 'exit_code_1',
      code: 1,
    }));
    expect(emitHookEventMock).toHaveBeenCalledWith('session.requires_attention', expect.objectContaining({
      sessionId: 'sid-lifecycle-test',
      reason: 'worker_process_exit',
      code: 1,
    }));
    expect(sessionReplyMock).toHaveBeenCalledWith(
      'om_root',
      expect.stringContaining('继续'),
      'text',
      'app_test',
      undefined,
    );
  });

  it('does not post late Codex App progress after a terminal send marker', async () => {
    const worker = makeFakeWorker();
    const ds = makeDs({ worker });
    await prepareTerminalSend(ds, { requestId: 'terminal-progress', turnId: 'lark-turn' });
    commitTerminalSend(ds, 'terminal-progress');
    __testOnly_setupWorkerHandlers(ds, worker);

    worker.emit('message', {
      type: 'progress_output',
      turnId: 'codex-app-turn',
      content: '这是一条完整但已经迟到的进度。',
    });
    await flush();

    expect(sessionReplyMock).not.toHaveBeenCalled();
    expect(updateMessageMock).not.toHaveBeenCalled();
    expect(deleteMessageMock).not.toHaveBeenCalled();
  });

  it('keeps an internal Team final in leader control flow without any user message or retraction', async () => {
    const onSessionFinalOutput = vi.fn(async () => ({ action: 'suppress' as const }));
    initWorkerPool({
      sessionReply: sessionReplyMock,
      getSessionWorkingDir: () => '/repo',
      getActiveCount: () => 1,
      closeSession: vi.fn(),
      onSessionFinalOutput,
    });
    const worker = makeFakeWorker();
    const ds = makeDs({ worker });
    ds.session.agentTeam = {
      teamId: 'team_1', role: 'worker', leaderSessionId: 'leader_1', workerId: 'worker_a',
    };
    __testOnly_setupWorkerHandlers(ds, worker);

    worker.emit('message', {
      type: 'final_output', turnId: 'team-internal', lastUuid: 'team-internal-final',
      content: '{"attemptId":"attempt_1","revisionId":"rev_1","status":"succeeded","summary":"done","evidenceRefs":[],"metrics":[]}',
    });
    await flush();

    expect(onSessionFinalOutput).toHaveBeenCalledTimes(1);
    expect(sessionReplyMock).not.toHaveBeenCalled();
    expect(updateMessageMock).not.toHaveBeenCalled();
    expect(deleteMessageMock).not.toHaveBeenCalled();
  });

  it('keeps Codex App heartbeats internal even when the activity changes', async () => {
    const worker = makeFakeWorker();
    const ds = makeDs({ worker });
    __testOnly_setupWorkerHandlers(ds, worker);

    worker.emit('message', {
      type: 'progress_output',
      kind: 'heartbeat',
      turnId: 'codex-app-turn',
      content: '正在执行：搜索代码（worker.ts）\n- 本轮已持续：约 1 分钟',
    });
    await flush();
    worker.emit('message', {
      type: 'progress_output',
      kind: 'heartbeat',
      turnId: 'codex-app-turn',
      content: '正在执行：运行 Codex Hook（工具完成后检查）\n- 本轮已持续：约 2 分钟',
    });
    await flush();

    expect(sessionReplyMock).not.toHaveBeenCalled();
    expect(updateMessageMock).not.toHaveBeenCalled();
    expect(deleteMessageMock).not.toHaveBeenCalled();
  });

  it('appends assistant progress but suppresses heartbeat output across turn ids', async () => {
    const worker = makeFakeWorker();
    const ds = makeDs({ worker });
    __testOnly_setupWorkerHandlers(ds, worker);

    worker.emit('message', {
      type: 'progress_output',
      kind: 'assistant',
      turnId: 'codex-native-turn',
      content: '建档已完成，Hook 与 Harness 校验已开始。',
    });
    await flush();
    worker.emit('message', {
      type: 'progress_output',
      kind: 'heartbeat',
      turnId: 'lark-user-turn',
      content: '正在执行：搜索代码 worker.ts｜进展：已完成建档｜本轮约 40 秒。',
    });
    await flush();

    expect(sessionReplyMock).toHaveBeenCalledTimes(1);
    expect(String(sessionReplyMock.mock.calls[0][1])).toContain('建档已完成');
    expect(updateMessageMock).not.toHaveBeenCalled();
    expect(deleteMessageMock).not.toHaveBeenCalled();
  });

  it('never forwards split structured JSON progress from an Agent Team worker', async () => {
    const worker = makeFakeWorker();
    const ds = makeDs({ worker });
    ds.session.agentTeam = {
      teamId: 'team_1', role: 'worker', leaderSessionId: 'leader_1', workerId: 'worker_a',
    };
    __testOnly_setupWorkerHandlers(ds, worker);

    worker.emit('message', {
      type: 'progress_output', kind: 'assistant', turnId: 'team-turn', content: '{"attemptId":"attempt_1",',
    });
    worker.emit('message', {
      type: 'progress_output', kind: 'assistant', turnId: 'team-turn', content: '"revisionId":"rev_1"}',
    });
    await flush();

    expect(sessionReplyMock).not.toHaveBeenCalled();
    expect(updateMessageMock).not.toHaveBeenCalled();
    expect(deleteMessageMock).not.toHaveBeenCalled();
  });

  it('renders an Agent Team final as the callback short card and never leaks the raw JSON', async () => {
    const onSessionFinalOutput = vi.fn(async () => ({
      action: 'deliver' as const,
      humanContent: '✅ [MR 8303533](https://bits.bytedance.net/bytebus/devops/code/detail/8303533?tab=changes&x=1)\n范围：worker_a\n状态：测试通过',
      cardJson: JSON.stringify({
        schema: '2.0',
        body: { elements: [{ tag: 'markdown', content: '✅ [MR 8303533](https://bits.bytedance.net/bytebus/devops/code/detail/8303533?tab=changes&x=1)\n范围：worker_a\n状态：测试通过' }] },
      }),
    }));
    initWorkerPool({
      sessionReply: sessionReplyMock,
      getSessionWorkingDir: () => '/repo',
      getActiveCount: () => 1,
      closeSession: vi.fn(),
      onSessionFinalOutput,
    });
    const worker = makeFakeWorker();
    const ds = makeDs({ worker });
    ds.session.agentTeam = {
      teamId: 'team_1', role: 'worker', leaderSessionId: 'leader_1', workerId: 'worker_a',
    };
    __testOnly_setupWorkerHandlers(ds, worker);
    const raw = '{"attemptId":"attempt_1","revisionId":"rev_1","status":"succeeded","summary":"done","evidenceRefs":[],"metrics":[]}';

    worker.emit('message', { type: 'final_output', turnId: 'team-turn', lastUuid: 'team-final-1', content: raw });
    await flush();
    await flush();

    expect(onSessionFinalOutput).toHaveBeenCalledWith(ds, expect.objectContaining({ content: raw }));
    expect(sessionReplyMock).toHaveBeenCalledTimes(1);
    expect(sessionReplyMock.mock.calls[0][2]).toBe('interactive');
    expect(String(sessionReplyMock.mock.calls[0][1])).toContain('[MR 8303533](');
    expect(String(sessionReplyMock.mock.calls[0][1])).not.toContain('attemptId');
    expect(updateMessageMock).not.toHaveBeenCalled();
    expect(deleteMessageMock).not.toHaveBeenCalled();
  });

  it('posts a new progress card for the next Lark user turn', async () => {
    const worker = makeFakeWorker();
    const ds = makeDs({ worker });
    __testOnly_setupWorkerHandlers(ds, worker);

    worker.emit('message', {
      type: 'progress_output',
      kind: 'assistant',
      turnId: 'first-user-turn',
      content: '第一轮正在排查。',
    });
    await flush();

    beginCodexAppProgressTurn(ds);
    await flush();
    worker.emit('message', {
      type: 'progress_output',
      kind: 'assistant',
      turnId: 'second-user-turn',
      content: '第二轮继续处理。',
    });
    await flush();

    expect(sessionReplyMock).toHaveBeenCalledTimes(2);
    expect(updateMessageMock).not.toHaveBeenCalled();
  });
});
