import { beforeEach, afterEach, describe, expect, it } from 'vitest';

/** 复用真实事件入口的隔离夹具，避免复制整份 Lark SDK mock。 */
export function registerOwnerContinuationCases(f: {
  appId: string; ownerId: string; botId: string;
  setup: (options: any) => void;
  getBot: () => any;
  owner: any; chatMode: any; chatInfo: any;
  handlers: () => any;
  start: (handlers: any) => void;
  reset: () => void;
  event: (options: any) => any;
  emit: (data: any) => Promise<void>;
  flush: () => Promise<void>;
}) {
  describe('普通群话题外默认单会话', () => {
    let handlers: any;
    let seq = 0;
    beforeEach(() => {
      f.reset();
      handlers = f.handlers();
      f.setup({ allowedUsers: [f.ownerId, 'ou_other'] });
      // 真正验证未配置时的新默认值，不依赖显式 true。
      delete f.getBot().config.regularGroupOwnerContinuation;
      f.owner.mockReturnValue(f.ownerId);
      f.chatMode.mockResolvedValue('group');
      f.chatInfo.mockResolvedValue({ userCount: 3, botCount: 2 });
      f.start(handlers);
    });
    afterEach(() => {
      f.owner.mockReturnValue(undefined);
      f.chatInfo.mockResolvedValue({ userCount: 1, botCount: 1 });
    });

    async function send(text: string, options: any = {}, mentioned = false) {
      const data = f.event({
        senderOpenId: f.ownerId, chatId: 'owner-chat', messageId: `owner-msg-${++seq}`,
        content: JSON.stringify({ text }),
        mentions: mentioned ? [{ key: '@_bot', name: 'BotA', id: { open_id: f.botId } }] : [],
        ...options,
      });
      await f.emit(data);
      await f.flush();
      return data;
    }

    it.each(['chat', 'shared', 'new-topic', 'chat-topic'])('主人免 @，%s 配置的话题外仍复用群锚点', async mode => {
      f.getBot().config.regularGroupReplyMode = mode;
      handlers.isSessionOwner.mockReturnValue(true);
      await send('追加测试和修复');
      expect(handlers.handleNewTopic).not.toHaveBeenCalled();
      expect(handlers.handleThreadReply).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
        scope: 'chat', anchor: 'owner-chat', replyRootId: undefined,
      }));
    });
    it('主人首次免 @ 只创建群会话', async () => {
      await send('开始任务');
      expect(handlers.handleNewTopic).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ scope: 'chat', anchor: 'owner-chat' }));
    });
    it.each(['never', 'ambient', 'always', 'topic'])('其他已授权成员在 %s 模式仍必须 @', async mode => {
      f.getBot().config.regularGroupMentionMode = mode;
      handlers.isSessionOwner.mockReturnValue(true);
      await send('普通聊天', { senderOpenId: 'ou_other' });
      expect(handlers.handleThreadReply).not.toHaveBeenCalled();
      expect(handlers.handleNewTopic).not.toHaveBeenCalled();
      await send('@_bot 追加要求', { senderOpenId: 'ou_other' }, true);
      expect(handlers.handleThreadReply).toHaveBeenCalledTimes(1);
    });
    it('免 @ 主人身份不能绕过原权限检查', async () => {
      f.getBot().resolvedAllowedUsers = [];
      await send('无权限的请求');
      expect(handlers.handleThreadReply).not.toHaveBeenCalled();
      expect(handlers.handleNewTopic).not.toHaveBeenCalled();
    });
    it('root_id 引用气泡不新开会话', async () => {
      await send('继续', { rootId: 'old-quote', threadId: null });
      expect(handlers.handleNewTopic).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ scope: 'chat', anchor: 'owner-chat' }));
    });
    it.each(['新开一个会话，排查另一个问题', '/t 独立任务'])('主人明确要求才分出新会话：%s', async text => {
      handlers.isSessionOwner.mockImplementation((anchor: string) => anchor === 'owner-chat');
      const event = await send(text);
      expect(handlers.handleNewTopic).toHaveBeenCalledWith(event, expect.objectContaining({ scope: 'thread', anchor: event.message.message_id }));
      expect(handlers.handleThreadReply).not.toHaveBeenCalled();
    });
    it('其他成员即使 @ 也不能在话题外另开会话', async () => {
      await send('@_bot /t 独立任务', { senderOpenId: 'ou_other' }, true);
      expect(handlers.handleNewTopic).not.toHaveBeenCalled();
      expect(handlers.handleThreadReply).not.toHaveBeenCalled();
    });
    it('普通群已有话题内的免 @ 续话保持原样', async () => {
      f.getBot().config.regularGroupMentionMode = 'topic';
      handlers.isSessionOwner.mockImplementation((anchor: string) => anchor === 'topic-root');
      await send('继续话题', { senderOpenId: 'ou_other', rootId: 'topic-root' });
      expect(handlers.handleThreadReply).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ scope: 'thread', anchor: 'topic-root' }));
    });
    it('话题群仍按每个话题独立建会话', async () => {
      f.chatMode.mockResolvedValue('topic');
      const event = await send('@_bot 新任务', {}, true);
      expect(handlers.handleNewTopic).toHaveBeenCalledWith(event, expect.objectContaining({ scope: 'thread', anchor: event.message.message_id }));
    });
  });
}
