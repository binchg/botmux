/** 出站内容脱敏：只删除个人资料和凭据，不修改传给后台任务的原始输入。 */
const email = /[\p{L}\p{N}._%+\-]+@[\p{L}\p{N}.\-]+(?:\.[\p{L}]{2,})?/gu;
const mobile = /(?<!\d)(?:\+?86[ -]?)?1[3-9]\d[ -]?\d{4}[ -]?\d{4}(?!\d)/g;
const identity = /(?<!\d)\d{6}(?:19|20)\d{2}(?:0[1-9]|1[0-2])(?:0[1-9]|[12]\d|3[01])\d{3}[\dXx](?!\d)/g;
const secretField = /^(?:email|e_mail|phone|mobile|id_card|idcard|identity_number|password|secret|access_token|refresh_token)$/i;

/** 百分号编码只用于识别链接中的资料；解码不会改变正常链接。 */
function decoded(value: string): string {
  try { return decodeURIComponent(value); } catch { return value; }
}

/** 标记式替换不会保留仍可识别的邮箱域名或完整号码。 */
function redactValues(text: string): string {
  return text.replace(email, '［邮箱已隐藏］').replace(mobile, '［手机号已隐藏］')
    .replace(identity, '［证件号已隐藏］')
    .replace(/((?:身份证|证件|护照)(?:号|号码|尾号)?\s*[:：]?\s*)\d[\dXx -]{2,}/g, '$1［已隐藏］')
    .replace(/\b\d[\dXx -]{2,}\s*((?:身份证|证件|护照)(?:号|号码|尾号)?)/g, '［已隐藏］ $1')
    .replace(/((?:password|access_token|refresh_token|api[_-]?key|密码|密钥|令牌)\s*[:=：]\s*)[^\s,，;；]+/gi, '$1［凭据已隐藏］')
    .replace(/((?:姓名|取货人|收件人)\s*[:：]\s*)[^\s,，;；]+/g, '$1［姓名已隐藏］')
    .replace(/姓\s*[:：]?\s*[^\s,，;；]{1,8}\s+名\s*[:：]?\s*[^\s,，;；]{1,12}/g, '［姓名已隐藏］');
}

/** 链接含个人资料时移除整个链接，不输出仍可还原资料的编码或链接目标。 */
export function sensitiveUrl(url: string): boolean {
  const plain = decoded(decoded(url));
  return /^mailto:/i.test(plain) || redactValues(plain) !== plain
    || /[?&](?:email|phone|mobile|idcard|id_card|password|access_token|refresh_token)=/i.test(plain);
}

/** 保留安全的 BITS、源码等链接；敏感链接只留下已脱敏的可读标签。 */
export function redactOutboundText(text: string): string {
  const links = text.replace(/\[([^\]]*)\]\(([^)]+)\)/g, (all, label: string, url: string) =>
    sensitiveUrl(url) ? redactValues(label) || '［个人资料链接已隐藏］' : all);
  return redactValues(links.replace(/(?:https?:\/\/|mailto:)[^\s<>"'）)]+/gi,
    (url) => sensitiveUrl(url) ? '［个人资料链接已隐藏］' : url));
}

/** 解析消息 JSON 时保持失败可诊断，不把非法输入伪装成成功内容。 */
export function objectBody(value: unknown): Record<string, any> | undefined {
  try {
    const result = typeof value === 'string' ? JSON.parse(value) : value;
    return result && typeof result === 'object' && !Array.isArray(result) ? result : undefined;
  } catch { return undefined; }
}

/** 递归处理可见文案和个人资料字段；敏感按钮整体移除，避免生成无效或误导链接。 */
function redactNode(value: any, key = ''): any {
  if (typeof value === 'string') {
    if (secretField.test(key)) return '［个人资料已隐藏］';
    if (['url', 'href'].includes(key) && sensitiveUrl(value)) return undefined;
    return redactOutboundText(value);
  }
  if (Array.isArray(value)) return value.map(item => redactNode(item)).filter(item => item !== undefined);
  if (!value || typeof value !== 'object') return value;
  if (value.tag === 'button' && (sensitiveUrl(value.url ?? '')
    || Object.values(value.multi_url ?? {}).some(url => typeof url === 'string' && sensitiveUrl(url)))) return undefined;
  const result: Record<string, any> = {};
  for (const [field, item] of Object.entries(value)) {
    const safe = field === 'multi_url' && item && typeof item === 'object'
      ? Object.fromEntries(Object.entries(item).filter(([, url]) => typeof url !== 'string' || !sensitiveUrl(url)))
      : redactNode(item, field);
    if (safe !== undefined) result[field] = safe;
  }
  if (result.tag === 'action' && result.actions?.length === 0) return undefined;
  return result;
}

/** JSON 结构保持可解析；没有资料被替换时保留原始字节。 */
export function redactOutboundContent(content: string): string {
  const parsed = objectBody(content);
  if (!parsed) return content;
  const safe = redactNode(parsed);
  return JSON.stringify(parsed) === JSON.stringify(safe) ? content : JSON.stringify(safe);
}

/** 从卡片提取纯文本用于格式降级，排除按钮载荷、图片键和实现字段。 */
export function cardPlainText(content: string): string {
  const output: string[] = [];
  const visit = (node: any): void => {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) { node.forEach(visit); return; }
    if (['plain_text', 'lark_md', 'markdown'].includes(node.tag) && typeof node.content === 'string') output.push(node.content);
    for (const [key, value] of Object.entries(node)) if (!['value', 'actions', 'multi_url'].includes(key)) visit(value);
  };
  visit(objectBody(content));
  return redactOutboundText(output.join('\n').slice(0, 20000)) || '回复已生成，详细卡片暂时无法显示。';
}
