/** 为用户追加的群副本注明真实发送者，保留原文与富文本中的附件节点。 */
import type { MirrorSource } from './thread-user-mirror.js';

/** 仅转换能完整保留内容的消息；其它类型交给带原发送者的合并转发。 */
export function attributedMirrorContent(source: MirrorSource, senderName: string):
  { msg_type: 'text' | 'post'; content: string } | undefined {
  const name = senderName.replace(/[\r\n\x00-\x1f]/g, ' ').trim().slice(0, 120);
  if (!name) throw new Error('用户消息缺少发送者标识');
  const prefix = `${name}追加：`;
  const body = JSON.parse(source.body?.content ?? source.content ?? '{}');
  if (source.msg_type === 'text') {
    if (typeof body.text !== 'string') throw new Error('用户文本消息缺少正文');
    let text = body.text;
    // 原生消息回读的占位符转换为可读姓名，不再次通知被提及者。
    for (const mention of source.mentions ?? []) {
      if (mention.key && mention.name) text = text.split(mention.key).join(`@${mention.name}`);
    }
    return { msg_type: 'text', content: JSON.stringify({ ...body, text: `${prefix}\n${text}` }) };
  }
  if (source.msg_type === 'image' && body.image_key) {
    return { msg_type: 'post', content: JSON.stringify({ zh_cn: { title: '', content: [
      [{ tag: 'text', text: prefix }], [{ tag: 'img', image_key: body.image_key }],
    ] } }) };
  }
  if (source.msg_type !== 'post') return undefined;
  const posts = Array.isArray(body.content) ? [body] : Object.values(body);
  if (!posts.length || posts.some((post: any) => !Array.isArray(post?.content))) {
    throw new Error('用户富文本消息结构不完整');
  }
  // 音视频和文件资源保留原生转发，不能把用户资源键作为机器人资源重发。
  if (posts.some((post: any) => post.content.flat().some((node: any) => node.file_key))) return undefined;
  for (const post of posts as Array<{ content: unknown[][]; content_v2?: unknown }>) {
    post.content.unshift([{ tag: 'text', text: prefix }]);
    // content_v2 是平台回读副本；发送时只提供已处理的正文，避免夹带旧图片键。
    delete post.content_v2;
  }
  // 回读是无语言包装的正文，发送协议必须恢复 zh_cn，不能直接复用回读外形。
  return { msg_type: 'post', content: JSON.stringify(Array.isArray(body.content) ? { zh_cn: body } : body) };
}

/** 用户上传的图片键不能直接发送；同一原图只重新上传一次，任何失败都在发消息前终止。 */
export async function prepareAttributedMirrorContent(
  source: MirrorSource, senderName: string, reupload: (imageKey: string) => Promise<string>,
): Promise<ReturnType<typeof attributedMirrorContent>> {
  const result = attributedMirrorContent(source, senderName);
  if (!result || result.msg_type !== 'post') return result;
  const body = JSON.parse(result.content);
  const uploaded = new Map<string, string>();
  for (const post of Object.values(body) as Array<{ content: Array<Array<Record<string, any>>> }>) {
    for (const row of post.content) for (const node of row) {
      if (node.tag !== 'img' || !node.image_key) continue;
      const original = node.image_key as string;
      let key = uploaded.get(original);
      if (!key) {
        key = await reupload(original);
        if (!key) throw new Error('用户追加图片上传未返回图片键');
        uploaded.set(original, key);
      }
      node.image_key = key;
    }
  }
  return { ...result, content: JSON.stringify(body) };
}
