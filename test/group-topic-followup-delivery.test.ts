/** 验证话题免 @ 穿过入口和后续群权限门禁，最终投递到原会话。 */
import { beforeEach, expect, it, vi } from 'vitest';
import type { IncomingMessageContext } from '../src/im/lark/event-message-context.js';

const state = vi.hoisted(() => ({ allowed: true, shared: false, prepare: vi.fn() }));
vi.mock('../src/services/group-direct-mention-policy.js', () => ({ requiresDirectGroupMention: () => true }));
vi.mock('../src/services/chat-reply-mode-store.js', () => ({ resolveGroupMentionMode: () => 'always' }));
vi.mock('../src/im/lark/event-human-routing.js', () => ({ prepareHumanRouting: state.prepare }));
vi.mock('../src/im/lark/event-summary-command.js', () => ({ resolveSummaryCommandMatch: async () => null }));
vi.mock('../src/im/lark/event-group-stats.js', () => ({ getGroupStats: async () => ({ userCount: 3, botCount: 2 }) }));
vi.mock('../src/im/lark/client.js', () => ({ getChatMode: async () => 'group' }));
vi.mock('../src/im/lark/event-access.js', () => ({
  checkGroupMessageAccess: async () => 'ignore', maybeSendGrantRequestCard: vi.fn(),
}));
vi.mock('../src/im/lark/thread-user-mirror-runtime.js', () => ({ maybeMirrorThreadUserMessage: vi.fn() }));
vi.mock('../src/bot-registry.js', () => ({ getBot: () => ({ botOpenId: 'ou_bot', config: {} }) }));
vi.mock('../src/utils/logger.js', () => ({ logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

import { handleHumanMessage } from '../src/im/lark/event-human-message.js';

function context(): IncomingMessageContext {
  const message = {
    message_type: 'text', content: JSON.stringify({ text: '继续' }),
    message_id: 'message', root_id: 'root', thread_id: 'thread', chat_id: 'chat', chat_type: 'group',
  };
  const sender = { sender_type: 'user', sender_id: { open_id: 'user' } };
  return {
    data: { message, sender }, message, sender, larkAppId: 'app', chatId: 'chat', chatType: 'group', messageId: 'message',
    handlers: {
      handleCardAction: vi.fn(), handleNewTopic: vi.fn(), handleThreadReply: vi.fn(),
      isSessionOwner: anchor => anchor === (state.shared ? 'chat' : 'root'),
      resolveReplyThreadAlias: () => state.shared ? { chatId: 'chat', sessionId: 'session' } : null,
    },
  };
}

beforeEach(() => {
  state.allowed = true;
  state.shared = false;
  state.prepare.mockReset().mockImplementation(async () => ({
    senderOpenId: 'user', isAllowed: state.allowed,
    routing: { scope: state.shared ? 'chat' : 'thread', anchor: state.shared ? 'chat' : 'root' },
    routingSource: 'real-thread', replyRootId: state.shared ? 'root' : undefined,
    explicitlyMentionedThisBot: false, autoTopicSeedScope: 'chat', autoTopicSeedAnchor: 'chat',
    ownerContinuation: false, continuationOwner: false, forceTopicApplied: false, ownsSession: true,
  }));
});

it.each([false, true])('多人多机器人群已有话题免 @ 投递到原会话，共享=%s', async shared => {
  state.shared = shared;
  const input = context();
  await handleHumanMessage(input);
  expect(input.handlers.handleThreadReply).toHaveBeenCalledWith(input.data, expect.objectContaining({
    scope: shared ? 'chat' : 'thread', anchor: shared ? 'chat' : 'root',
  }));
  expect(input.handlers.handleNewTopic).not.toHaveBeenCalled();
});

it('无权限发送者不能利用已有话题免 @ 投递', async () => {
  state.allowed = false;
  const input = context();
  await handleHumanMessage(input);
  expect(input.handlers.handleThreadReply).not.toHaveBeenCalled();
  expect(input.handlers.handleNewTopic).not.toHaveBeenCalled();
});

it('话题内明确 @ 其他成员时保持静默', async () => {
  const input = context();
  input.message.content = JSON.stringify({ text: '@_user_1 继续' });
  input.message.mentions = [{ key: '@_user_1', id: { open_id: 'ou_other' } }];
  await handleHumanMessage(input);
  expect(state.prepare).not.toHaveBeenCalled();
  expect(input.handlers.handleThreadReply).not.toHaveBeenCalled();
});

it('引用气泡与未绑定话题仍要求直接 @', async () => {
  for (const bound of [false, true]) {
    const input = context();
    if (bound) delete input.message.thread_id;
    else input.handlers.isSessionOwner = () => false;
    await handleHumanMessage(input);
    expect(state.prepare).not.toHaveBeenCalled();
    expect(input.handlers.handleThreadReply).not.toHaveBeenCalled();
  }
});
