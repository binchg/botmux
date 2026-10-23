import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { dispatchSessionMessage, requestsSeparateSession } from '../src/im/lark/regular-group-continuation.js';
import { __resetAnchorQueues } from '../src/utils/anchor-serializer.js';
import type { EventHandlers, RoutingContext } from '../src/im/lark/event-dispatcher.js';

describe('新开会话必须是明确指令', () => {
  it.each(['新开一个会话，修复问题', '请新建一个 Codex 会话：任务', '/t 任务', '/topic'])('接受 %s', text => {
    expect(requestsSeparateSession(text)).toBe(true);
  });
  it.each(['除非我明确要求新开一个会话', '不要新开一个会话', '他说“新开一个会话”', '新开一个会话的功能坏了', '继续；新开一个会话是什么意思', '/test', ''])('不误判 %s', text => {
    expect(requestsSeparateSession(text)).toBe(false);
  });
});

describe('群会话创建串行与执行时回读', () => {
  beforeEach(() => { __resetAnchorQueues(); vi.useFakeTimers(); });
  afterEach(() => vi.useRealTimers());
  const ctx: RoutingContext = { chatId: 'chat', anchor: 'chat', scope: 'chat', chatType: 'group', larkAppId: 'app', messageId: 'first' };

  it('首条创建超过五秒时，后续消息仍等待，并追加到已创建的会话', async () => {
    let created = false;
    let release!: () => void;
    const pending = new Promise<void>(resolve => { release = resolve; });
    const handlers: EventHandlers = {
      handleCardAction: vi.fn(),
      isSessionOwner: () => created,
      handleNewTopic: vi.fn(async () => { await pending; created = true; }),
      handleThreadReply: vi.fn(async () => {}),
    };
    const first = dispatchSessionMessage(handlers, 'first', ctx, false);
    const second = dispatchSessionMessage(handlers, 'second', { ...ctx, messageId: 'second' }, false);
    await vi.advanceTimersByTimeAsync(6000);
    expect(handlers.handleNewTopic).toHaveBeenCalledTimes(1);
    expect(handlers.handleThreadReply).not.toHaveBeenCalled();
    release();
    await Promise.all([first, second]);
    expect(handlers.handleNewTopic).toHaveBeenCalledTimes(1);
    expect(handlers.handleThreadReply).toHaveBeenCalledWith('second', expect.objectContaining({ anchor: 'chat' }));
  });

  it('前一条失败不锁死群', async () => {
    const handlers: EventHandlers = {
      handleCardAction: vi.fn(), isSessionOwner: () => false,
      handleNewTopic: vi.fn().mockRejectedValueOnce(new Error('failed')).mockResolvedValue(undefined),
      handleThreadReply: vi.fn(async () => {}),
    };
    await expect(dispatchSessionMessage(handlers, 'first', ctx, false)).rejects.toThrow('failed');
    await dispatchSessionMessage(handlers, 'next', ctx, false);
    expect(handlers.handleNewTopic).toHaveBeenCalledTimes(2);
  });

  it('另一个群不受当前群的创建等待影响', async () => {
    let release!: () => void;
    const pending = new Promise<void>(resolve => { release = resolve; });
    const handlers: EventHandlers = {
      handleCardAction: vi.fn(), isSessionOwner: () => false,
      handleNewTopic: vi.fn().mockImplementationOnce(() => pending).mockResolvedValue(undefined),
      handleThreadReply: vi.fn(async () => {}),
    };
    const first = dispatchSessionMessage(handlers, 'first', ctx, false);
    await vi.advanceTimersByTimeAsync(0);
    await dispatchSessionMessage(handlers, 'other', { ...ctx, chatId: 'other', anchor: 'other' }, false);
    expect(handlers.handleNewTopic).toHaveBeenCalledTimes(2);
    release();
    await first;
  });
});
