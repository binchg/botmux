/** 验证主人话题免 @ 同时通过入口与权限门禁，且普通群不会误启动任务。 */
import { beforeEach, expect, it, vi } from 'vitest';
import type { IncomingMessageContext } from '../src/im/lark/event-message-context.js';

const state = vi.hoisted(() => ({
  enabled: true, allowed: true, scope: 'thread', prepare: vi.fn(), chatMode: vi.fn(),
}));
vi.mock('../src/services/group-direct-mention-policy.js', () => ({
  requiresDirectGroupMention: () => true,
  allowsOwnerTopicWithoutMention: (app: string, chat: string) => state.enabled && app === 'app' && chat === 'chat',
}));
vi.mock('../src/services/chat-reply-mode-store.js', () => ({ resolveGroupMentionMode: () => 'always' }));
vi.mock('../src/im/lark/event-human-routing.js', () => ({ prepareHumanRouting: state.prepare }));
vi.mock('../src/im/lark/event-summary-command.js', () => ({ resolveSummaryCommandMatch: async () => null }));
vi.mock('../src/im/lark/event-group-stats.js', () => ({ getGroupStats: async () => ({ userCount: 3, botCount: 2 }) }));
vi.mock('../src/im/lark/client.js', () => ({ getChatMode: state.chatMode, getChatModeStrict: state.chatMode }));
vi.mock('../src/im/lark/event-access.js', () => ({
  checkGroupMessageAccess: async () => state.allowed ? 'allowed' : 'not_allowed',
  maybeSendGrantRequestCard: vi.fn(),
}));
vi.mock('../src/im/lark/thread-user-mirror-runtime.js', () => ({ maybeMirrorThreadUserMessage: vi.fn() }));
vi.mock('../src/bot-registry.js', () => ({
  getBot: () => ({ botOpenId: 'ou_bot', resolvedAllowedUsers: ['owner', 'co-owner'], config: {} }),
}));
vi.mock('../src/utils/logger.js', () => ({ logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

import { handleHumanMessage } from '../src/im/lark/event-human-message.js';

/** 默认模拟尚未绑定任何会话的新话题，确保不会借用旧话题续聊例外。 */
function context(senderId = 'owner'): IncomingMessageContext {
  const message = {
    message_type: 'text', content: JSON.stringify({ text: '开始任务' }),
    message_id: 'message', chat_id: 'chat', chat_type: 'group',
  };
  const sender = { sender_type: 'user', sender_id: { open_id: senderId } };
  return {
    data: { message, sender }, message, sender, larkAppId: 'app', chatId: 'chat', chatType: 'group', messageId: 'message',
    handlers: { handleCardAction: vi.fn(), handleNewTopic: vi.fn(), handleThreadReply: vi.fn(), isSessionOwner: () => false },
  };
}

beforeEach(() => {
  state.enabled = true;
  state.allowed = true;
  state.scope = 'thread';
  state.chatMode.mockReset().mockResolvedValue('topic');
  state.prepare.mockReset().mockImplementation(async () => ({
    senderOpenId: 'owner', isAllowed: state.allowed,
    routing: { scope: state.scope, anchor: 'message' }, routingSource: 'topic',
    explicitlyMentionedThisBot: false, autoTopicSeedScope: 'thread', autoTopicSeedAnchor: 'message',
    ownerContinuation: false, continuationOwner: false, forceTopicApplied: false, ownsSession: false,
  }));
});

it.each(['owner', 'co-owner'])('指定话题群主人 %s 不用 @ 即可启动新任务', async owner => {
  const input = context(owner);
  await handleHumanMessage(input);
  expect(state.chatMode).toHaveBeenCalledWith('app', 'chat');
  expect(input.handlers.handleNewTopic).toHaveBeenCalledWith(input.data, expect.objectContaining({ scope: 'thread' }));
});

it('富文本新话题无需 @，带真实话题标识的未绑定消息也可启动', async () => {
  const input = context();
  Object.assign(input.message, { message_type: 'post', content: '{"content":[[{"tag":"text","text":"开始任务"}]]}', root_id: 'root', thread_id: 'thread' });
  await handleHumanMessage(input);
  expect(input.handlers.handleNewTopic).toHaveBeenCalledOnce();
});

it.each(['group', 'unknown', 'p2p'])('实际群类型为 %s 时主人免 @ 也不响应', async mode => {
  state.chatMode.mockResolvedValue(mode);
  const input = context();
  await handleHumanMessage(input);
  expect(state.prepare).not.toHaveBeenCalled();
  expect(input.handlers.handleNewTopic).not.toHaveBeenCalled();
});

it.each(['other-user', ''])('非主人或身份缺失时不能免 @ 启动：%s', async senderId => {
  await handleHumanMessage(context(senderId));
  expect(state.prepare).not.toHaveBeenCalled();
  expect(state.chatMode).not.toHaveBeenCalled();
});

it('未开启、其它群或其它机器人不获得例外', async () => {
  for (const variant of ['disabled', 'chat', 'app']) {
    const input = context();
    state.enabled = variant !== 'disabled';
    if (variant === 'chat') input.chatId = 'another-chat';
    if (variant === 'app') input.larkAppId = 'another-app';
    await handleHumanMessage(input);
    expect(input.handlers.handleNewTopic).not.toHaveBeenCalled();
  }
  expect(state.prepare).not.toHaveBeenCalled();
});

it.each(['share_chat', 'merge_forward', 'interactive'])('转发或卡片 %s 不能免 @ 启动', async type => {
  const input = context();
  input.message.message_type = type;
  await handleHumanMessage(input);
  expect(state.prepare).not.toHaveBeenCalled();
});

it('明确 @ 其他人或机器人时保持静默', async () => {
  const input = context();
  input.message.content = '{"text":"@_user_1 请处理"}';
  input.message.mentions = [{ key: '@_user_1', id: { open_id: 'ou_other' } }];
  await handleHumanMessage(input);
  expect(state.prepare).not.toHaveBeenCalled();
});

it('话题免 @ 仍须通过原权限检查', async () => {
  state.allowed = false;
  const input = context();
  await handleHumanMessage(input);
  expect(state.prepare).toHaveBeenCalledOnce();
  expect(input.handlers.handleNewTopic).not.toHaveBeenCalled();
});

it('入口后群转换导致路由变为群顶层时不响应', async () => {
  state.scope = 'chat';
  const input = context();
  await handleHumanMessage(input);
  expect(state.prepare).toHaveBeenCalledOnce();
  expect(input.handlers.handleNewTopic).not.toHaveBeenCalled();
});

it('普通群直接 @ 仍然响应，不依赖话题群查询', async () => {
  const input = context();
  state.scope = 'chat';
  input.message.content = '{"text":"@_user_1 请处理"}';
  input.message.mentions = [{ key: '@_user_1', id: { open_id: 'ou_bot' } }];
  await handleHumanMessage(input);
  expect(state.chatMode).not.toHaveBeenCalled();
  expect(input.handlers.handleNewTopic).toHaveBeenCalledOnce();
});
