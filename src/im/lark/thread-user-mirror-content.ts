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
  for (const post of posts as Array<{ content: unknown[][] }>) {
    post.content.unshift([{ tag: 'text', text: prefix }]);
  }
  return { msg_type: 'post', content: JSON.stringify(body) };
}
