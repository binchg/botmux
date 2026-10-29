import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import * as groupSettings from '../src/services/regular-group-settings.js';

// 事件入口的共享夹具不读取真实运行策略；新门禁用例显式开启。
const directMention = vi.hoisted(() => ({ enabled: false }));
vi.mock('../src/services/group-direct-mention-policy.js', () => ({
  requiresDirectGroupMention: () => directMention.enabled,
}));
beforeEach(() => { directMention.enabled = false; });

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
    let overrides: ReturnType<typeof vi.spyOn>;
    beforeEach(() => {
      overrides = vi.spyOn(groupSettings, 'regularGroupOverrides').mockReturnValue({});
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
      overrides.mockRestore();
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
      data.message.message_type = 'text';
      await f.emit(data);
      await f.flush();
      return data;
    }

    it.each(['group', 'topic'])('严格门禁拦截 %s 的群顶层但允许已有话题续聊', async mode => {
      directMention.enabled = true;
      f.chatMode.mockResolvedValue(mode);
      f.chatInfo.mockResolvedValue({ userCount: 1, botCount: 1 });
      f.getBot().config.regularGroupMentionMode = 'ambient';
      f.getBot().config.autoStartOnNewTopic = true;
      await send('新任务');
      handlers.isSessionOwner.mockReturnValue(true);
      await send('继续', { rootId: 'existing-root', threadId: 'thread' });
      expect(handlers.handleNewTopic).not.toHaveBeenCalled();
      expect(handlers.handleThreadReply).toHaveBeenCalledTimes(1);
    });
    it('共享会话话题在 always 模式也能免 @，群顶层仍不能免 @', async () => {
      directMention.enabled = true;
      f.getBot().config.regularGroupMentionMode = 'always';
      f.getBot().config.regularGroupReplyMode = 'shared';
      handlers.isSessionOwner.mockImplementation((anchor: string) => anchor === 'owner-chat');
      handlers.resolveReplyThreadAlias.mockReturnValue({ chatId: 'owner-chat', sessionId: 'session' });
      await send('继续', { rootId: 'shared-root', threadId: 'thread' });
      expect(handlers.handleThreadReply).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
        scope: 'chat', anchor: 'owner-chat', replyRootId: 'shared-root',
      }));
      await send('群外聊天');
      expect(handlers.handleThreadReply).toHaveBeenCalledTimes(1);
    });
    it.each(['share_chat', 'merge_forward'])('严格门禁忽略带提及元数据的 %s', async type => {
      directMention.enabled = true;
      const data = f.event({
        senderOpenId: f.ownerId, chatId: 'owner-chat', messageId: 'forward-' + type,
        content: '{"chat_id":"oc_shared","text":"@_bot"}',
        mentions: [{ key: '@_bot', name: 'BotA', id: { open_id: f.botId } }],
      });
      data.message.message_type = type;
      await f.emit(data);
      await f.flush();
      expect(handlers.handleNewTopic).not.toHaveBeenCalled();
      expect(handlers.handleThreadReply).not.toHaveBeenCalled();
    });
    it('严格门禁允许主人直接 @ 创建与续聊，但不放宽其他人的权限', async () => {
      directMention.enabled = true;
      await send('@_bot 开始', {}, true);
      expect(handlers.handleNewTopic).toHaveBeenCalledTimes(1);
      handlers.isSessionOwner.mockReturnValue(true);
      await send('@_bot 继续', {}, true);
      expect(handlers.handleThreadReply).toHaveBeenCalledTimes(1);
      await send('@_bot 越权', { senderOpenId: 'ou_denied' }, true);
      expect(handlers.handleNewTopic).toHaveBeenCalledTimes(1);
      expect(handlers.handleThreadReply).toHaveBeenCalledTimes(1);
    });

    it('关闭本群复用后群外消息新开，其他群不受影响', async () => {
      overrides.mockImplementation((_app: string, chat: string) => chat === 'owner-chat' ? { reuse: false } : {});
      handlers.isSessionOwner.mockImplementation((anchor: string) => anchor === 'owner-chat' || anchor === 'other-chat');
      const event = await send('独立任务');
      expect(handlers.handleNewTopic).toHaveBeenCalledWith(event, expect.objectContaining({ scope: 'thread', anchor: event.message.message_id }));
      await send('继续原任务', { chatId: 'other-chat' });
      expect(handlers.handleThreadReply).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ scope: 'chat', anchor: 'other-chat' }));
    });
    it('关闭复用不放宽其他成员的免 @ 权限，也不改变已有话题的会话', async () => {
      overrides.mockReturnValue({ reuse: false });
      f.getBot().config.regularGroupMentionMode = 'never';
      await send('群里普通聊天', { senderOpenId: 'ou_other' });
      expect(handlers.handleNewTopic).not.toHaveBeenCalled();
      expect(handlers.handleThreadReply).not.toHaveBeenCalled();
      handlers.isSessionOwner.mockImplementation((anchor: string) => anchor === 'existing-root');
      await send('@_bot 继续已有话题', { rootId: 'existing-root', threadId: 'thread' }, true);
      expect(handlers.handleThreadReply).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ scope: 'thread', anchor: 'existing-root' }));
      expect(handlers.handleNewTopic).not.toHaveBeenCalled();
    });
    it('开启本群复用覆盖旧的新话题策略，显式新开仍保留', async () => {
      overrides.mockReturnValue({ reuse: true });
      f.getBot().config.regularGroupOwnerContinuation = false;
      f.getBot().config.regularGroupReplyMode = 'new-topic';
      handlers.isSessionOwner.mockImplementation((anchor: string) => anchor === 'owner-chat');
      await send('继续任务');
      expect(handlers.handleThreadReply).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ scope: 'chat', anchor: 'owner-chat' }));
      const event = await send('/t 独立任务');
      expect(handlers.handleNewTopic).toHaveBeenCalledWith(event, expect.objectContaining({ scope: 'thread', anchor: event.message.message_id }));
    });
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
