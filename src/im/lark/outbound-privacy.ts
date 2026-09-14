/** 飞书回复策略：出站脱敏、有限降级和独立补发，不修改后台任务输入或状态。 */
import { defaultHttpInstance } from '@larksuiteoapi/node-sdk';
import { logger } from '../../utils/logger.js';
import { isMessageWrite, type LarkReplyOutbox, type OutboundRequest } from '../../services/lark-reply-outbox.js';
import { cardPlainText, objectBody, redactOutboundContent } from './outbound-redaction.js';

const installed = new WeakSet<object>();
const fallbackFlag = '__botmuxPrivacyNotice';
const notice = '本条回复被飞书内容审核拦截，原回复未送达。已省略无法安全展示的内容；回复发送失败不会取消后台任务。';

/** 自动标题不得包含邮箱、手机或证件信息，包括被截断的邮箱。 */
export function privateCardTitle(title: string): string {
  const plain = title.replace(/\\/g, '');
  return /@|mailto:|(?<!\d)(?:\+?86[ -]?)?1[3-9]\d{9}(?!\d)|(?:身份证|证件|护照).{0,8}\d/i.test(plain)
    ? '任务进度（个人资料已隐藏）' : title;
}

/** 标题隐藏资料，正文递归脱敏；没有替换时保持原始消息字节。 */
export function privateCardContent(content: string): string {
  const card = objectBody(content);
  if (!card) return content;
  let changed = false;
  for (const header of [card.header, ...Object.values(card.i18n_header ?? {})]) {
    for (const field of ['title', 'subtitle']) {
      const text = header?.[field];
      if (typeof text?.content !== 'string') continue;
      const safe = privateCardTitle(text.content);
      if (safe !== text.content) { text.content = safe; changed = true; }
    }
  }
  return redactOutboundContent(changed ? JSON.stringify(card) : content);
}

/** 只处理文字和卡片消息；图片上传和其它写接口保持原状。 */
function replyBody(request: OutboundRequest): Record<string, any> | undefined {
  if (!isMessageWrite(request)) return undefined;
  const body = objectBody(request.data);
  return body && typeof body.content === 'string'
    && (body.msg_type === undefined || ['text', 'interactive', 'post'].includes(body.msg_type)) ? body : undefined;
}

/** POST 可降为纯文本；PATCH/PUT 必须保留卡片类型和目标消息。 */
function fallbackBody(request: OutboundRequest, body: Record<string, any>, text: string): Record<string, any> {
  if (request.method?.toUpperCase() === 'POST') {
    return { ...body, msg_type: 'text', content: JSON.stringify({ text }) };
  }
  return { ...body, content: JSON.stringify({
    config: { wide_screen_mode: true },
    header: { title: { tag: 'plain_text', content: '回复未送达' }, template: 'orange' },
    elements: [{ tag: 'div', text: { tag: 'plain_text', content: text } }],
  }) };
}

/** 启动时安装一次；失败会抛给发送方并保存，不伪造成功回执或取消业务任务。 */
export function installLarkOutboundPrivacy(http: typeof defaultHttpInstance = defaultHttpInstance,
  outbox?: LarkReplyOutbox): void {
  if (installed.has(http)) return;
  installed.add(http);
  logger.info(`Lark outbound privacy guard installed (body redaction, text fallback, durable outbox=${!!outbox})`);

  /** 统一 HTTP 200 业务失败和 HTTP 400；真实成功才能清理补发记录。 */
  function checkReply(this: OutboundRequest, data: any, _headers: unknown, status?: number): any {
    if (data?.code !== undefined && data.code !== 0) {
      throw Object.assign(new Error(`Lark reply rejected code=${data.code}`), { config: this, response: { status, data } });
    }
    if (replyBody(this)) {
      try { outbox?.accepted(this, data); } catch { logger.error('Reply receipt cleanup failed; inspect outbox storage'); }
    }
    return data;
  }

  http.interceptors.request.use((request) => {
    const body = replyBody(request);
    if (!body) return request;
    request.timeout = Math.min(request.timeout || 10000, 10000);
    const transforms = request.transformResponse;
    const chain = Array.isArray(transforms) ? transforms : transforms ? [transforms] : [];
    if (!chain.includes(checkReply)) request.transformResponse = [...chain, checkReply];
    request.data = { ...body, content: privateCardContent(body.content) };
    outbox?.prepare(request);
    return request;
  });
  http.interceptors.response.use(undefined, async (error: any) => {
    const request: OutboundRequest | undefined = error?.config;
    const body = request && replyBody(request);
    if (!request || !body) throw error;
    const code = error?.response?.data?.code;
    const audit = code === 230028;
    const cardError = [230001, 230099].includes(code) && /card|schema|element/i.test(error?.response?.data?.msg ?? '');
    let fallbackText: string | undefined;
    let stage: string | undefined;
    if (audit && request[fallbackFlag] !== 'notice') {
      stage = 'notice';
      fallbackText = notice;
    } else if (cardError && !request[fallbackFlag] && body.msg_type === 'interactive') {
      stage = 'plain';
      fallbackText = cardPlainText(body.content);
    }
    if (fallbackText) {
      logger.warn(`Lark reply fallback stage=${stage} code=${code}; background task unchanged`);
      const headers = { ...request.headers };
      // 新正文必须重算长度，避免旧 Content-Length 导致挂起。
      delete headers['Content-Length'];
      delete headers['content-length'];
      const fallback = { ...request, headers, data: fallbackBody(request, body, fallbackText), [fallbackFlag]: stage };
      return http.request(fallback);
    }
    if (!request.__botmuxOutboxReplay) {
      try { if (outbox) { outbox.failed(request, error); error.__botmuxQueued = true; } }
      catch { logger.error('Reply could not be persisted; outbound storage requires attention'); }
    }
    throw error;
  });
}
