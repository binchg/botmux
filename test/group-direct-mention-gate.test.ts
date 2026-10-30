/** 严格门禁必须早于所有自动开工、命令和已有会话续聊路径。 */
import { beforeEach, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ strict: true, prepare: vi.fn() }));
vi.mock('../src/services/group-direct-mention-policy.js', () => ({
  requiresDirectGroupMention: () => mocks.strict,
  allowsOwnerTopicWithoutMention: () => false,
}));
vi.mock('../src/im/lark/event-human-routing.js', () => ({ prepareHumanRouting: mocks.prepare }));
vi.mock('../src/bot-registry.js', () => ({ getBot: () => ({ botOpenId: 'ou_bot' }) }));
vi.mock('../src/utils/logger.js', () => ({ logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
import { handleHumanMessage } from '../src/im/lark/event-human-message.js';
import type { IncomingMessageContext } from '../src/im/lark/event-message-context.js';

/** 仅隔离后续路由，入口与正文提及检查都执行真实实现。 */
function context(chatType: 'group' | 'p2p', message: Record<string, unknown>): IncomingMessageContext {
  const data = {
    message: { chat_type: chatType, chat_id: 'chat', message_id: 'message', ...message },
    sender: { sender_type: 'user', sender_id: { open_id: 'owner' } },
  };
  return {
    data, message: data.message, sender: data.sender, larkAppId: 'app', chatId: 'chat',
    chatType, messageId: 'message', handlers: {
      handleCardAction: vi.fn(), handleNewTopic: vi.fn(), handleThreadReply: vi.fn(),
      isSessionOwner: () => false,
    },
  };
}

beforeEach(() => {
  mocks.strict = true;
  mocks.prepare.mockReset().mockResolvedValue(undefined);
});

it.each([
  { message_type: 'share_chat', content: '{"chat_id":"oc_shared"}' },
  { message_type: 'merge_forward', content: '{"text":"@_user_1"}', mentions: [{ key: '@_user_1', id: { open_id: 'ou_bot' } }] },
  { message_type: 'text', content: '{"text":"继续"}' },
  { message_type: 'text', content: '{"text":"继续"}', root_id: 'root', thread_id: 'thread' },
  { message_type: 'text', content: '{"text":"/t 开始新任务"}' },
])('未直接 @ 的群消息在自动路由前被拦截 %#', async message => {
  const input = context('group', message);
  await handleHumanMessage(input);
  expect(mocks.prepare).not.toHaveBeenCalled();
  expect(input.handlers.handleNewTopic).not.toHaveBeenCalled();
  expect(input.handlers.handleThreadReply).not.toHaveBeenCalled();
});

it('直接 @ 后交给原权限与会话路由', async () => {
  const input = context('group', {
    message_type: 'text', content: '{"text":"@_user_1 请处理"}',
    mentions: [{ key: '@_user_1', id: { open_id: 'ou_bot' } }],
  });
  await handleHumanMessage(input);
  expect(mocks.prepare).toHaveBeenCalledWith(input);
});

it('私聊无需 @', async () => {
  const input = context('p2p', { message_type: 'text', content: '{"text":"继续"}' });
  await handleHumanMessage(input);
  expect(mocks.prepare).toHaveBeenCalledWith(input);
});

it('已有独立话题内无需 @，但只有引用气泡的群消息仍需 @', async () => {
  const input = context('group', { message_type: 'text', content: '{"text":"继续"}', root_id: 'root', thread_id: 'thread' });
  input.handlers.isSessionOwner = () => true;
  await handleHumanMessage(input);
  expect(mocks.prepare).toHaveBeenCalledWith(input);
  mocks.prepare.mockClear();
  delete input.message.thread_id;
  await handleHumanMessage(input);
  expect(mocks.prepare).not.toHaveBeenCalled();
});

it('共享话题别名仅在本群仍绑定本机器人时免 @', async () => {
  const input = context('group', { message_type: 'text', content: '{"text":"继续"}', root_id: 'root', thread_id: 'thread' });
  input.handlers.isSessionOwner = anchor => anchor === 'chat';
  input.handlers.resolveReplyThreadAlias = () => ({ chatId: 'chat', sessionId: 'session' });
  await handleHumanMessage(input);
  expect(mocks.prepare).toHaveBeenCalledWith(input);
  mocks.prepare.mockClear();
  input.handlers.resolveReplyThreadAlias = () => ({ chatId: 'other-chat', sessionId: 'session' });
  await handleHumanMessage(input);
  expect(mocks.prepare).not.toHaveBeenCalled();
});

it('未开启严格门禁的机器人沿用原路由', async () => {
  mocks.strict = false;
  const input = context('group', { message_type: 'share_chat', content: '{"chat_id":"oc_shared"}' });
  await handleHumanMessage(input);
  expect(mocks.prepare).toHaveBeenCalledWith(input);
});
