/** 卡片场景限制、状态回显和回调权限回归；不连接真实飞书或修改用户配置。 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({
  session: { sessionId: 's', larkAppId: 'app', chatId: 'chat', chatType: 'group' },
  settings: { sync: false, reuse: true }, get: vi.fn(), mode: vi.fn(), allowed: vi.fn(), save: vi.fn(), snapshot: vi.fn(), saveSnapshot: vi.fn(),
}));
vi.mock('../src/services/session-store.js', () => ({ getSession: (id: string) => id === 's' ? mocks.session : undefined }));
vi.mock('../src/services/regular-group-settings.js', () => ({
  regularGroupSettings: () => ({ ...mocks.settings }), setRegularGroupSetting: mocks.save,
}));
vi.mock('../src/im/lark/client.js', () => ({ getMessageDetail: mocks.get, getChatModeStrict: mocks.mode }));
vi.mock('../src/im/lark/event-dispatcher.js', () => ({ canOperate: mocks.allowed }));
vi.mock('../src/services/regular-group-card-snapshots.js', () => ({ readGroupCardSnapshot: mocks.snapshot, saveGroupCardSnapshot: mocks.saveSnapshot }));
import { decorateGroupSettings, GROUP_SETTING_ACTION, withGroupSettings } from '../src/im/lark/regular-group-settings-card.js';
import { handleGroupSettingAction } from '../src/im/lark/regular-group-settings-action.js';
import type { Session } from '../src/types.js';

/** 同时保留正文及现有操作，模拟真实会话消息卡。 */
function original(version = 1): any {
  const elements = [{ tag: 'markdown', content: '正文 **不变**' },
    { tag: 'action', actions: [{ tag: 'button', text: { tag: 'plain_text', content: '原按钮' },
      value: { action: 'close', session_id: 's' } }] }];
  return version === 1 ? { config: { wide_screen_mode: true }, elements } : { schema: '2.0', body: { elements } };
}
function payload(thread = true): any { return { path: { message_id: 'message' }, data: { reply_in_thread: thread } }; }
function detail(card = withGroupSettings(original(), mocks.session as Session, mocks.settings), overrides = {}): any {
  return { items: [{ message_id: 'message', chat_id: 'chat', thread_id: 'thread', root_id: 'root',
    body: { content: JSON.stringify(card) }, ...overrides }] };
}
function action(field = 'sync', next = true): any {
  return { context: { open_message_id: 'message' }, operator: { open_id: 'owner' },
    action: { value: { action: GROUP_SETTING_ACTION, session_id: 's', field, next_value: next } } };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.settings = { sync: false, reuse: true };
  mocks.get.mockResolvedValue(detail());
  mocks.snapshot.mockReturnValue(withGroupSettings(original(), mocks.session as Session, mocks.settings));
  mocks.mode.mockResolvedValue('group');
  mocks.allowed.mockReturnValue(true);
  mocks.save.mockImplementation(async (_app, _chat, field, enabled) => { (mocks.settings as any)[field] = enabled; });
});

describe('仅普通群话题内添加开关', () => {
  it.each([1, 2])('卡片 v%s 保存正文及原操作，重复刷新只有两个开关', async version => {
    const source = original(version);
    const content = await decorateGroupSettings(JSON.stringify(source), 'app', 'reply', payload());
    const card = JSON.parse(content);
    const elements = version === 1 ? card.elements : card.body.elements;
    expect(elements.slice(0, 2)).toEqual(version === 1 ? source.elements : source.body.elements);
    expect(content).toContain('同步到群：关');
    expect(content).toContain('群聊复用：开');
    const updated = await decorateGroupSettings(content, 'app', 'patch', payload());
    expect(updated.match(/regular_group_setting/g)).toHaveLength(2);
  });
  it.each(['p2p', 'topic', 'unknown'])('%s 类型原样发送', async mode => {
    mocks.mode.mockResolvedValue(mode);
    const content = JSON.stringify(original());
    expect(await decorateGroupSettings(content, 'app', 'reply', payload())).toBe(content);
  });
  it('群外发送、引用回复、其它机器人、无会话通知不查平台也不改变', async () => {
    const content = JSON.stringify(original());
    expect(await decorateGroupSettings(content, 'app', 'create', payload())).toBe(content);
    expect(await decorateGroupSettings(content, 'app', 'reply', payload(false))).toBe(content);
    expect(await decorateGroupSettings(content, 'other', 'reply', payload())).toBe(content);
    expect(await decorateGroupSettings('{"elements":[]}', 'app', 'reply', payload())).toBe('{"elements":[]}');
    expect(mocks.get).not.toHaveBeenCalled();
  });
  it.each([{ chat_id: 'other' }, { sync_to_chat_info: { type: 1 } }, { thread_id: undefined, root_id: undefined }])(
    '刷新错误位置不追加按钮：%j', async overrides => {
      mocks.get.mockResolvedValue(detail(original(), overrides));
      const content = JSON.stringify(original());
      expect(await decorateGroupSettings(content, 'app', 'patch', payload())).toBe(content);
    });
  it('平台回读失败不阻断原消息发送', async () => {
    mocks.get.mockRejectedValue(new Error('unavailable'));
    const content = JSON.stringify(original());
    expect(await decorateGroupSettings(content, 'app', 'reply', payload())).toBe(content);
  });
});

describe('点击保存并刷新原卡', () => {
  it('成功回调同时返回最新两项状态并保留原卡内容', async () => {
    const result = await handleGroupSettingAction(action(), 'app');
    expect(mocks.save).toHaveBeenCalledWith('app', 'chat', 'sync', true);
    expect(result.toast.type).toBe('success');
    expect(result.card.data.elements.slice(0, 2)).toEqual(original().elements);
    expect(JSON.stringify(result.card)).toContain('同步到群：开');
    expect(JSON.stringify(result.card)).toContain('群聊复用：开');
  });
  it('旧卡重复点击设置明确值，不反转配置', async () => {
    await handleGroupSettingAction(action('reuse', false), 'app');
    const result = await handleGroupSettingAction(action('reuse', false), 'app');
    expect(mocks.settings.reuse).toBe(false);
    expect(JSON.stringify(result.card)).toContain('群聊复用：关');
  });
  it('非操作者拒绝写入', async () => {
    mocks.allowed.mockReturnValue(false);
    expect((await handleGroupSettingAction(action(), 'app')).toast.type).toBe('error');
    expect(mocks.save).not.toHaveBeenCalled();
  });
  it.each(['topic', 'p2p', 'unknown'])('%s 不能写配置', async mode => {
    mocks.mode.mockResolvedValue(mode);
    expect((await handleGroupSettingAction(action(), 'app')).toast.type).toBe('error');
    expect(mocks.save).not.toHaveBeenCalled();
  });
  it('伪造会话或旧卡缺少按钮时拒绝写入', async () => {
    const forged = action(); forged.action.value.session_id = 'other';
    await handleGroupSettingAction(forged, 'app');
    mocks.snapshot.mockReturnValue(original());
    await handleGroupSettingAction(action(), 'app');
    expect(mocks.save).not.toHaveBeenCalled();
  });
  it('持久化失败不回传已成功的卡片', async () => {
    mocks.save.mockRejectedValue(new Error('disk error'));
    const result = await handleGroupSettingAction(action(), 'app');
    expect(result.toast.type).toBe('error');
    expect(result.card).toBeUndefined();
  });
  it('飞书回读缺失 value 时仍保留其它按钮的原始回调参数', async () => {
    mocks.get.mockResolvedValue(detail({ elements: [{ tag: 'button', behaviors: [{ type: 'callback' }], custom_action_id: 'platform-id' }] }));
    const result = await handleGroupSettingAction(action(), 'app');
    expect(result.card.data.elements[1].actions[0].value).toEqual({ action: 'close', session_id: 's' });
    expect(mocks.saveSnapshot).toHaveBeenCalledWith('app', 'message', result.card.data);
  });
  it('缺少原始卡快照时不损坏已有按钮，也不写入配置', async () => {
    mocks.snapshot.mockReturnValue(undefined);
    expect((await handleGroupSettingAction(action(), 'app')).toast.type).toBe('error');
    expect(mocks.save).not.toHaveBeenCalled();
  });
});
