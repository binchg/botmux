/** 平级交接验证停用、角色解绑、重启恢复和迟到回复，不访问真实飞书。 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { config } from '../src/config.js';
import * as sessions from '../src/services/session-store.js';
import { listSessionHandoffs, recordSessionHandoff } from '../src/services/session-handoff-store.js';
import { assertSessionReplyAllowed, SessionReplySuppressedError } from '../src/services/session-reply-policy.js';
import { handoffSession, registerSessionHandoffApi } from '../src/core/session-handoff-api.js';
import { startIpcServer, type IpcServerHandle } from '../src/core/dashboard-ipc-server.js';
import * as workers from '../src/core/worker-pool.js';
import { addAgentTeamWorker, createAgentTeam, getAgentTeam } from '../src/services/agent-team-store.js';
import { protectLarkClientDelivery } from '../src/services/lark-client-delivery.js';
import { LarkReplyOutbox } from '../src/services/lark-reply-outbox.js';
import { defaultHttpInstance } from '@larksuiteoapi/node-sdk';
import { installLarkOutboundPrivacy } from '../src/im/lark/outbound-privacy.js';

let folder: string;
let previousFolder: string;
let handle: IpcServerHandle | undefined;

beforeEach(() => {
  previousFolder = config.session.dataDir;
  folder = mkdtempSync(join(tmpdir(), 'botmux-peer-handoff-'));
  config.session.dataDir = folder;
  sessions.init('cli_peer');
  workers.setActiveSessionsRegistry(new Map());
});
afterEach(async () => {
  await handle?.close();
  handle = undefined;
  workers.setActiveSessionsRegistry(new Map());
  sessions.init();
  config.session.dataDir = previousFolder;
  rmSync(folder, { recursive: true, force: true });
  vi.restoreAllMocks();
});

/** 两个同 owner 的独立话题；可选旧 Team 仅用于兼容迁移断言。 */
function pair() {
  const source = sessions.createSession('chat', 'root_old', '交出会话');
  const target = sessions.createSession('chat', 'root_new', '接手会话');
  for (const session of [source, target]) {
    session.larkAppId = 'cli_peer'; session.ownerOpenId = 'owner';
    sessions.updateSession(session);
  }
  return { source, target };
}

/** 关闭旧 runner 的最小替身，保留真实持久会话和 HTTP 路由。 */
function closeSpy() {
  return vi.spyOn(workers, 'closeSession').mockImplementation(async id => {
    sessions.closeSession(id);
    return { ok: true, alreadyClosed: false };
  });
}

describe('平级交接生命周期', () => {
  it('无 Team 的普通会话也能交接；只关闭交出方，重复请求幂等', async () => {
    const { source, target } = pair();
    const close = closeSpy();
    const result = await handoffSession(source.sessionId, target.sessionId, 'cli_peer');
    expect(result.relationship).toBe('peer');
    expect(result.sourceReplyEnabled).toBe(false);
    expect(close).toHaveBeenCalledWith(source.sessionId);
    expect(close).not.toHaveBeenCalledWith(target.sessionId);
    expect(sessions.getSession(source.sessionId)?.status).toBe('closed');
    expect(sessions.getSession(target.sessionId)?.status).toBe('active');
    await handoffSession(source.sessionId, target.sessionId, 'cli_peer');
    expect(listSessionHandoffs()).toHaveLength(1);
  });

  it('旧 Team 只停编排，接手会话脱离角色而不中断 runner，审计仍在', async () => {
    const { source, target } = pair();
    const team = createAgentTeam(folder, {
      name: '兼容迁移', objective: '测试', larkAppId: 'cli_peer', chatId: 'chat', leaderSessionId: source.sessionId,
    });
    addAgentTeamWorker(folder, team.teamId, { workerId: 'peer', title: '接手', assignment: '测试', dependsOn: [],
      sessionId: target.sessionId, rootMessageId: target.rootMessageId });
    target.agentTeam = { teamId: team.teamId, role: 'worker', workerId: 'peer', leaderSessionId: source.sessionId };
    sessions.updateSession(target);
    const send = vi.fn();
    const liveTarget = { session: target, worker: { send, killed: false } };
    vi.spyOn(workers, 'findActiveBySessionId').mockReturnValue(liveTarget as any);
    closeSpy();
    await handoffSession(source.sessionId, target.sessionId, 'cli_peer');
    expect(liveTarget.session.agentTeam).toBeUndefined();
    expect(send).not.toHaveBeenCalled();
    expect(liveTarget.worker.killed).toBe(false);
    expect(getAgentTeam(folder, team.teamId)?.status).toBe('closed');
    expect(getAgentTeam(folder, team.teamId)?.workers).toHaveLength(1);
  });

  it('交出方还有其它活跃任务时拒绝，避免交接遗失编排', async () => {
    const { source, target } = pair();
    const team = createAgentTeam(folder, {
      name: '其它任务', objective: '测试', larkAppId: 'cli_peer', chatId: 'chat', leaderSessionId: source.sessionId,
    });
    addAgentTeamWorker(folder, team.teamId, { workerId: 'unrelated', title: '其它任务', assignment: '测试', dependsOn: [] });
    await expect(handoffSession(source.sessionId, target.sessionId, 'cli_peer')).rejects.toThrow('handoff_has_other_live_dependents');
    expect(listSessionHandoffs()).toEqual([]);
    expect(getAgentTeam(folder, team.teamId)?.status).toBe('active');
  });

  it('目标冲突和循环交接不能覆盖既有停用关系', async () => {
    const { source, target } = pair(); closeSpy();
    await handoffSession(source.sessionId, target.sessionId, 'cli_peer');
    const other = sessions.createSession('chat', 'root_other', '其它会话');
    other.larkAppId = 'cli_peer'; other.ownerOpenId = 'owner'; sessions.updateSession(other);
    await expect(handoffSession(source.sessionId, other.sessionId, 'cli_peer')).rejects.toThrow('handoff_target_conflict');
    await expect(handoffSession(target.sessionId, source.sessionId, 'cli_peer')).rejects.toThrow('handoff_target_inactive');
    expect(listSessionHandoffs()).toHaveLength(1);
  });

  it.each(['owner', 'bot', 'self', 'inactive', 'same-root', 'chat'])('身份或目标不满足 %s 时不落账本', async kind => {
    const { source, target } = pair();
    if (kind === 'owner') target.ownerOpenId = 'another';
    if (kind === 'bot') target.larkAppId = 'another';
    if (kind === 'inactive') target.status = 'closed';
    if (kind === 'same-root') target.rootMessageId = source.rootMessageId;
    if (kind === 'chat') source.scope = 'chat';
    sessions.updateSession(source); sessions.updateSession(target);
    await expect(handoffSession(source.sessionId, kind === 'self' ? source.sessionId : target.sessionId, 'cli_peer')).rejects.toThrow();
    expect(listSessionHandoffs()).toEqual([]);
    expect(sessions.getSession(source.sessionId)?.status).toBe('active');
  });

  it('写账本后发生崩溃，重读旧 active 数据仍停用交出方并解绑接手角色', () => {
    const { source, target } = pair();
    target.agentTeam = { teamId: 'old', role: 'worker', leaderSessionId: source.sessionId };
    sessions.updateSession(target);
    recordSessionHandoff(source, target);
    sessions.init('cli_peer');
    expect(sessions.getSession(source.sessionId)?.status).toBe('closed');
    expect(sessions.getSession(target.sessionId)?.agentTeam).toBeUndefined();
    const file = join(folder, 'session-handoffs', readdirSync(join(folder, 'session-handoffs'))[0]);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(readFileSync(file, 'utf8')).not.toContain('assignment');
  });

  it('真实 IPC 路由返回平级交接结果', async () => {
    const { source, target } = pair();
    closeSpy(); registerSessionHandoffApi('cli_peer');
    handle = await startIpcServer({ port: 0, host: '127.0.0.1' });
    const result = await fetch(`http://127.0.0.1:${handle.port}/api/sessions/${source.sessionId}/handoff`, {
      method: 'POST', body: JSON.stringify({ targetSessionId: target.sessionId }),
    });
    expect(result.status).toBe(200);
    expect(await result.json()).toMatchObject({ ok: true, relationship: 'peer', sourceReplyEnabled: false });
  });
});

describe('旧话题出站门禁', () => {
  it('根回复、流卡、引用别名和人工处理卡都被抑制，新会话及其它 bot 可回复', () => {
    const { source, target } = pair();
    source.streamCardId = 'old_card'; source.progressCardId = 'old_progress';
    source.replyThreadAliases = { alias: { createdAt: 'now', lastUsedAt: 'now' } };
    recordSessionHandoff(source, target);
    for (const id of ['root_old', 'old_card', 'old_progress', 'alias']) {
      const request = { url: `/open-apis/im/v1/messages/${id}/reply` };
      expect(() => assertSessionReplyAllowed(request, 'cli_peer')).toThrow(SessionReplySuppressedError);
      expect(() => assertSessionReplyAllowed(request, 'cli_other')).not.toThrow();
    }
    expect(() => assertSessionReplyAllowed({ url: '/open-apis/im/v1/messages/root_new/reply' }, 'cli_peer')).not.toThrow();
  });

  it('SDK 发送前拒绝迟到回复，不调用飞书、不入失败队列、不伪造成功', async () => {
    const { source, target } = pair(); recordSessionHandoff(source, target);
    const original = vi.fn();
    const client = { im: { v1: { message: { reply: original } } } };
    const queue = { prepare: vi.fn(), failed: vi.fn(), accepted: vi.fn() };
    protectLarkClientDelivery(client, queue as any, 'cli_peer');
    await expect(client.im.v1.message.reply({ path: { message_id: 'root_old' },
      data: { msg_type: 'interactive', content: '{"text":"需要人工处理"}' } })).rejects.toThrow(SessionReplySuppressedError);
    expect(original).not.toHaveBeenCalled(); expect(queue.failed).not.toHaveBeenCalled();
  });

  it('旧 turn 终态到达已独立的接手话题时保留摘要，不暴露机器账本', async () => {
    const { source, target } = pair(); recordSessionHandoff(source, target);
    const original = vi.fn().mockResolvedValue({ code: 0, data: { message_id: 'real-receipt' } });
    const client = { im: { v1: { message: { reply: original } } } };
    const queue = { prepare: vi.fn(), failed: vi.fn(), accepted: vi.fn() };
    protectLarkClientDelivery(client, queue as any, 'cli_peer');
    const result = JSON.stringify({ attemptId: 'a', revisionId: 'r', status: 'blocked',
      summary: '接手方需要用户决定', evidenceRefs: [], metrics: {} });
    await client.im.v1.message.reply({ path: { message_id: 'root_new' },
      data: { msg_type: 'interactive', content: JSON.stringify({ body: { elements: [{ tag: 'markdown', content: result }] } }) } });
    const sent = original.mock.calls[0][0].data.content;
    expect(sent).toContain('接手方需要用户决定');
    expect(sent).not.toContain('attemptId');
    expect(queue.accepted).toHaveBeenCalled();
  });

  it('SDK 鉴权之后 HTTP 门禁再次核验，补发或降级不会穿过停用边界', async () => {
    const { source, target } = pair();
    const queue = { prepare: vi.fn(), failed: vi.fn(), accepted: vi.fn() };
    const adapter = vi.fn();
    const http = defaultHttpInstance.create();
    installLarkOutboundPrivacy(http, queue as any, request => assertSessionReplyAllowed(request, 'cli_peer'));
    recordSessionHandoff(source, target);
    await expect(http.request({ method: 'POST', url: '/open-apis/im/v1/messages/root_old/reply',
      data: { msg_type: 'text', content: '{"text":"旧通知"}' }, adapter })).rejects.toThrow(SessionReplySuppressedError);
    expect(adapter).not.toHaveBeenCalled();
    expect(queue.failed).not.toHaveBeenCalled();
  });

  it('已排队回复在交接后保留为 suppressed，重启也不再补发', async () => {
    const { source, target } = pair();
    const send = vi.fn(async request => {
      assertSessionReplyAllowed(request, 'cli_peer');
      return { code: 0, data: { message_id: 'receipt' } };
    });
    let now = 0;
    const path = join(folder, 'queue');
    const queue = new LarkReplyOutbox(path, send, () => now);
    const request = { method: 'POST', url: '/open-apis/im/v1/messages/root_old/reply',
      data: { msg_type: 'text', content: '{"text":"旧进度"}' } };
    queue.failed(request, { code: 'ECONNREFUSED' });
    recordSessionHandoff(source, target); now = 60000;
    await queue.drain();
    expect(queue.status()).toMatchObject({ pending: 0, suppressed: 1 });
    send.mockClear();
    const restored = new LarkReplyOutbox(path, send, () => now + 600000);
    await restored.drain();
    expect(send).not.toHaveBeenCalled();
    expect(restored.status().suppressed).toBe(1);
  });

  it('损坏账本拒绝继续发送，不把停用状态误判成允许', () => {
    const { source, target } = pair(); recordSessionHandoff(source, target);
    const path = join(folder, 'session-handoffs', readdirSync(join(folder, 'session-handoffs'))[0]);
    writeFileSync(path, '{');
    expect(() => assertSessionReplyAllowed({ url: '/open-apis/im/v1/messages/root_old/reply' }, 'cli_peer')).toThrow();
  });

  it('旧进程尝试重新写 active 或 resume，不会撤销交接停用事实', () => {
    const { source, target } = pair(); recordSessionHandoff(source, target);
    sessions.updateSession({ ...source, status: 'active' });
    expect(sessions.getSession(source.sessionId)?.status).toBe('closed');
    expect(sessions.findActiveSessionsByRoot('root_old')).toEqual([]);
  });
});
