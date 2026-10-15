/** 验证用户署名、原始图文附件和未知类型的无损回退边界。 */
import { describe, expect, it, vi } from 'vitest';
import { attributedMirrorContent, prepareAttributedMirrorContent } from '../src/im/lark/thread-user-mirror-content.js';

describe('用户追加消息的发送者标注', () => {
  it('文本注明姓名并保留正文换行，提及占位符显示真实姓名', () => {
    const result = attributedMirrorContent({ message_id: 'om_text', msg_type: 'text',
      body: { content: JSON.stringify({ text: '第一行\n@_user_1 继续' }) },
      mentions: [{ key: '@_user_1', name: '同事' }] }, '陈金彬');
    expect(JSON.parse(result!.content)).toEqual({ text: '陈金彬追加：\n第一行\n@同事 继续' });
  });

  it.each([true, false])('富文本保留标题、链接及图片，仅插入署名，语言包装=%s', wrapped => {
    const post = { title: '原标题', content: [[{ tag: 'a', text: '原链接', href: 'https://example.com' }],
      [{ tag: 'img', image_key: 'img_original' }]] };
    const readback = { ...post, content_v2: post.content };
    const body = JSON.stringify(wrapped ? { zh_cn: readback } : readback);
    const result = attributedMirrorContent({ message_id: 'om_post', msg_type: 'post', body: { content: body } }, '陈金彬');
    const parsed = JSON.parse(result!.content);
    const actual = parsed.zh_cn;
    expect(actual).toEqual({ ...post, content: [[{ tag: 'text', text: '陈金彬追加：' }], ...post.content] });
    expect(JSON.stringify(wrapped ? { zh_cn: readback } : readback)).toBe(body);
  });

  it('单张图片保留原图片键并加署名，文件交给原生带发送者的转发', () => {
    const result = attributedMirrorContent({ message_id: 'om_image', msg_type: 'image',
      body: { content: '{"image_key":"img_original"}' } }, '陈金彬');
    expect(JSON.parse(result!.content).zh_cn.content).toEqual([
      [{ tag: 'text', text: '陈金彬追加：' }], [{ tag: 'img', image_key: 'img_original' }],
    ]);
    expect(attributedMirrorContent({ message_id: 'om_file', msg_type: 'file' }, '陈金彬')).toBeUndefined();
  });

  it('缺少姓名或正文时拒绝伪造空消息', () => {
    expect(() => attributedMirrorContent({ message_id: 'om', msg_type: 'text' }, '')).toThrow();
    expect(() => attributedMirrorContent({ message_id: 'om', msg_type: 'text' }, '陈金彬')).toThrow();
  });

  it('用户图片先重新上传，同一原图重复引用只上传一次', async () => {
    const reupload = vi.fn().mockResolvedValue('img_bot_owned');
    const result = await prepareAttributedMirrorContent({ message_id: 'om', msg_type: 'post',
      body: { content: JSON.stringify({ title: '', content: [[{ tag: 'img', image_key: 'img_user' }],
        [{ tag: 'img', image_key: 'img_user' }]] }) } }, '陈金彬', reupload);
    expect(reupload).toHaveBeenCalledExactlyOnceWith('img_user');
    expect(result!.content).not.toContain('img_user');
    expect(result!.content.match(/img_bot_owned/g)).toHaveLength(2);
  });

  it('图片无法上传时拒绝发送，含文件资源的富文本保持原生转发', async () => {
    await expect(prepareAttributedMirrorContent({ message_id: 'om', msg_type: 'image',
      body: { content: '{"image_key":"img_user"}' } }, '陈金彬', async () => '')).rejects.toThrow();
    expect(attributedMirrorContent({ message_id: 'om', msg_type: 'post', body: { content:
      '{"content":[[{"tag":"media","file_key":"file_user"}]]}' } }, '陈金彬')).toBeUndefined();
  });
});
