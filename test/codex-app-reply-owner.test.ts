import { describe, expect, it } from 'vitest';
import { codexAppReplyOwner } from '../src/services/codex-app-reply-owner.js';
import { resolveSessionReplyTarget, syncReplyTargetState } from '../src/core/reply-target.js';
import type { DaemonSession } from '../src/core/types.js';

describe('重启恢复后的回复归属', () => {
  it('模型继续旧 turn 时仍绑定已恢复的飞书用户轮次', () => {
    const ds = { scope: 'chat', chatId: 'oc_chat', session: {}, currentReplyTarget: {
      rootMessageId: 'om_topic', turnId: 'om_user', updatedAt: 'now',
    } } as DaemonSession;
    const owner = codexAppReplyOwner('om_user', '01a13d43-native-turn');
    expect(resolveSessionReplyTarget(ds, owner)).toEqual({ mode: 'thread', rootMessageId: 'om_topic' });
    expect(codexAppReplyOwner(undefined, 'native-local')).toBe('native-local');
  });
  it('磁盘刷新必须同时恢复历史轮次表，不能丢失旧话题', () => {
    const ds = { scope: 'chat', chatId: 'oc_chat', session: {} } as DaemonSession;
    syncReplyTargetState(ds, { replyTargetsByTurn: { old: 'om_old' }, currentReplyTarget: {
      rootMessageId: 'om_new', turnId: 'new', updatedAt: 'now',
    } } as DaemonSession['session']);
    expect(resolveSessionReplyTarget(ds, 'old')).toEqual({ mode: 'thread', rootMessageId: 'om_old' });
  });
});
