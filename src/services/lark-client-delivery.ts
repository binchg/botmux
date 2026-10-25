/** SDK 鉴权发生在 HTTP 发送前；在客户端入口补齐这类失败的脱敏与持久记录。 */
import { privateCardContent } from '../im/lark/outbound-privacy.js';
import type { LarkReplyOutbox, OutboundRequest } from './lark-reply-outbox.js';
import { assertSessionReplyAllowed, peerHandoffContent } from './session-reply-policy.js';
import { repairThreadReply } from '../im/lark/thread-sync.js';
import { decorateGroupSettings, GROUP_SETTING_ACTION } from '../im/lark/regular-group-settings-card.js';
import { saveGroupCardSnapshot } from './regular-group-card-snapshots.js';
import { logger } from '../utils/logger.js';

const protectedClients = new WeakSet<object>();

/** 包装所属机器人的消息方法，原 SDK 仍负责鉴权、路由和真实发送。 */
export function protectLarkClientDelivery(client: any, outbox: LarkReplyOutbox, larkAppId?: string): void {
  if (protectedClients.has(client)) return;
  protectedClients.add(client);
  const methods = client.im.v1.message;
  for (const [name, method] of Object.entries({ create: 'POST', reply: 'POST', patch: 'PATCH', update: 'PUT' })) {
    if (typeof methods[name] !== 'function') continue;
    const original = methods[name].bind(methods);
    methods[name] = async (payload: any, ...options: any[]) => {
      if (larkAppId) assertSessionReplyAllowed({ url: '/open-apis/im/v1/messages/'
        + encodeURIComponent(payload.path?.message_id ?? '') }, larkAppId);
      const body = payload?.data;
      if (typeof body?.content !== 'string'
        || (body.msg_type !== undefined && !['text', 'interactive', 'post'].includes(body.msg_type))) return original(payload, ...options);
      const suffix = name === 'create' ? '' : '/' + encodeURIComponent(payload.path?.message_id ?? '') + (name === 'reply' ? '/reply' : '');
      const request: OutboundRequest = { method, url: '/open-apis/im/v1/messages' + suffix,
        data: { ...body, content: privateCardContent(larkAppId
          ? peerHandoffContent(body.content, payload.path?.message_id, larkAppId) : body.content) }, params: payload.params };
      if (typeof methods.get === 'function') {
        await repairThreadReply(request, async id => {
          const result = await methods.get({ path: { message_id: id } });
          if (result.code !== 0) throw new Error('Thread reply target lookup failed');
          return result.data;
        });
        if (request.url !== '/open-apis/im/v1/messages' + suffix) {
          payload = { ...payload, path: { ...payload.path, message_id: request.url!.split('/').at(-2) } };
        }
      }
      if (larkAppId) assertSessionReplyAllowed(request, larkAppId);
      if (larkAppId) request.data.content = await decorateGroupSettings(request.data.content, larkAppId, name, payload);
      outbox.prepare(request);
      try {
        const result = await original({ ...payload, data: request.data }, ...options);
        const deliveredId = result.data?.message_id ?? payload.path?.message_id;
        if (result.code === 0 && larkAppId && deliveredId && request.data.content.includes(GROUP_SETTING_ACTION)) {
          try { saveGroupCardSnapshot(larkAppId, deliveredId, JSON.parse(request.data.content)); }
          catch { logger.warn('群设置卡快照保存失败，原消息已发送'); }
        }
        // 回执清理故障不能把已经送达的回复重新当成发送失败。
        try { outbox.accepted(request, result); } catch { /* HTTP 层已记录收据清理诊断。 */ }
        return result;
      } catch (error: any) {
        // HTTP 路径已保存降级后的版本时，不能用原卡片覆盖它。
        if (!error?.__botmuxQueued && !error?.__botmuxReplySuppressed) {
          try {
            const target = error?.config?.url ?? '';
            outbox.failed(request, { ...error, __botmuxNotSent: !target.includes('/im/v1/messages') });
          } catch { /* 持久存储故障不改变原始发送错误和任务状态。 */ }
        }
        throw error;
      }
    };
  }
}
