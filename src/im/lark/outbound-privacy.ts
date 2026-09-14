/** 飞书出站隐私处理：自动标题不复述个人资料，审核拒绝后只发送固定说明。 */
import { defaultHttpInstance } from '@larksuiteoapi/node-sdk';
import { logger } from '../../utils/logger.js';

type Request = {
  url?: string;
  method?: string;
  data?: any;
  [key: string]: any;
};

const installed = new WeakSet<object>();
const fallbackFlag = '__botmuxPrivacyNotice';
const auditCode = 230028;
const notice = '本条回复被飞书内容审核拦截，原回复未送达。请继续查询任务状态；本提示不包含原文或个人资料。';

/** 只解析普通 JSON 对象；附件、二进制及其它请求保持原状。 */
function objectBody(value: unknown): Record<string, any> | undefined {
  try {
    const result = typeof value === 'string' ? JSON.parse(value) : value;
    return result && typeof result === 'object' && !Array.isArray(result) ? result : undefined;
  } catch {
    return undefined;
  }
}

/** 标题是自动摘要，不应包含邮箱、手机号码或证件资料，包括被截断的邮箱。 */
export function privateCardTitle(title: string): string {
  const plain = title.replace(/\\/g, '');
  return /@|mailto:|(?<!\d)(?:\+?86[ -]?)?1[3-9]\d{9}(?!\d)|(?:身份证|证件|护照).{0,8}\d/i.test(plain)
    ? '任务进度（个人资料已隐藏）'
    : title;
}

/** 只改卡片标题与副标题；正文、按钮、二维码及原始用户输入不变。 */
export function privateCardContent(content: string): string {
  const card = objectBody(content);
  if (!card) return content;
  let changed = false;
  const headers = [card.header, ...Object.values(card.i18n_header ?? {})];
  for (const header of headers) {
    for (const field of ['title', 'subtitle']) {
      const text = header?.[field];
      if (typeof text?.content !== 'string') continue;
      const safe = privateCardTitle(text.content);
      if (safe !== text.content) {
        text.content = safe;
        changed = true;
      }
    }
  }
  return changed ? JSON.stringify(card) : content;
}

/** 限定到飞书消息写接口，不影响读取、鉴权、上传或其它平台请求。 */
function messageWrite(request: Request): boolean {
  const method = request.method?.toUpperCase();
  return (method === 'POST' || method === 'PATCH' || method === 'PUT')
    && /\/im\/v1\/messages(?:\/[^/?]+(?:\/reply)?)?(?:\?|$)/.test(request.url ?? '');
}

/** 保留路由、线程与幂等键；失败说明沿用卡片类型，兼容消息 PATCH。 */
function noticeBody(body: Record<string, any>): Record<string, any> {
  const content = body.msg_type === 'text'
    ? JSON.stringify({ text: notice })
    : JSON.stringify({
      config: { wide_screen_mode: true },
      header: { title: { tag: 'plain_text', content: '回复未送达' }, template: 'orange' },
      elements: [{ tag: 'div', text: { tag: 'plain_text', content: notice } }],
    });
  return { ...body, content };
}

/** 统一 HTTP 200 中的业务拒绝与 HTTP 400，避免成功状态码掩盖审核失败。 */
function rejectAuditBody(this: Request, data: any, _headers: unknown, status?: number): any {
  if (data?.code === auditCode) {
    throw Object.assign(new Error('Lark outbound audit rejected (code=230028)'), {
      config: this, response: { status, data },
    });
  }
  return data;
}

/** 在 daemon 启动时安装一次；审核拒绝最多补发一次固定说明，绝不重发敏感原文。 */
export function installLarkOutboundPrivacy(http: typeof defaultHttpInstance = defaultHttpInstance): void {
  if (installed.has(http)) return;
  installed.add(http);
  logger.info('Lark outbound privacy guard installed (private titles, bounded audit notice)');
  http.interceptors.request.use((request) => {
    if (!messageWrite(request)) return request;
    const transforms = request.transformResponse;
    const chain = Array.isArray(transforms) ? transforms : transforms ? [transforms] : [];
    if (!chain.includes(rejectAuditBody)) request.transformResponse = [...chain, rejectAuditBody];
    const body = objectBody(request.data);
    if (!body || typeof body.content !== 'string') return request;
    if (body.msg_type !== undefined && body.msg_type !== 'interactive') return request;
    const content = privateCardContent(body.content);
    if (content !== body.content) request.data = { ...body, content };
    return request;
  });
  http.interceptors.response.use(undefined, async (error: any) => {
    const request: Request | undefined = error?.config;
    const code = error?.response?.data?.code;
    if (code !== auditCode || !request || !messageWrite(request) || request[fallbackFlag]) throw error;
    const body = objectBody(request.data);
    if (!body || typeof body.content !== 'string'
      || (body.msg_type !== undefined && !['text', 'interactive'].includes(body.msg_type))) throw error;
    logger.warn('Lark outbound audit rejected code=230028; original reply withheld, sending privacy notice once');
    const headers = { ...request.headers };
    // 新正文长度由传输层重算，避免复用旧 Content-Length 导致请求挂起。
    delete headers['Content-Length'];
    delete headers['content-length'];
    const fallback = { ...request, headers, data: noticeBody(body), [fallbackFlag]: true };
    return http.request(fallback);
  });
}
