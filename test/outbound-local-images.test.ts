import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { prepareOutboundLocalImages, resolveOutboundLocalImages } from '../src/services/outbound-local-images.js';

describe('prepareOutboundLocalImages', () => {
  let root: string;

  beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'botmux-outbound-images-')); });
  afterEach(() => { rmSync(root, { recursive: true, force: true }); });

  it('replaces an allowed local image with an upload placeholder', () => {
    const image = join(root, 'qr.png');
    writeFileSync(image, 'png');
    const result = prepareOutboundLocalImages(`扫码：\n\n![二维码](${image})`, { roots: [root] });
    expect(result.content).toContain('![二维码](botmux-local-image:0)');
    expect(result.paths).toEqual([image]);
    expect(result.skipped).toEqual([]);
  });

  it('supports angle-wrapped paths with spaces and deduplicates uploads', () => {
    const dir = join(root, 'with space');
    mkdirSync(dir);
    const image = join(dir, 'qr code.png');
    writeFileSync(image, 'png');
    const result = prepareOutboundLocalImages(`![](<${image}>)\n![](<${image}>)`, { roots: [root] });
    expect(result.content).toBe('![](botmux-local-image:0)\n![](botmux-local-image:0)');
    expect(result.paths).toEqual([image]);
  });

  it('rejects files outside allowed roots without leaking the path', () => {
    const outside = join(tmpdir(), `botmux-secret-${Date.now()}.png`);
    writeFileSync(outside, 'png');
    try {
      const result = prepareOutboundLocalImages(`![](${outside})`, { roots: [root] });
      expect(result.paths).toEqual([]);
      expect(result.skipped).toEqual([{ reason: 'outside_allowed_roots' }]);
      expect(result.content).toContain('不在当前会话允许目录');
      expect(result.content).not.toContain(outside);
    } finally {
      rmSync(outside, { force: true });
    }
  });

  it('does not interpret image-looking text inside code fences', () => {
    const image = join(root, 'qr.png');
    writeFileSync(image, 'png');
    const input = `\`\`\`md\n![](${image})\n\`\`\``;
    const result = prepareOutboundLocalImages(input, { roots: [root] });
    expect(result.content).toBe(input);
    expect(result.paths).toEqual([]);
  });

  it('leaves remote images unchanged', () => {
    const input = '![](https://example.com/a.png)';
    const result = prepareOutboundLocalImages(input, { roots: [root] });
    expect(result.content).toBe(input);
    expect(result.paths).toEqual([]);
  });

  it('uploads valid images and resolves card placeholders', async () => {
    const image = join(root, 'qr.png');
    writeFileSync(image, 'png');
    const result = await resolveOutboundLocalImages(`![二维码](${image})`, {
      roots: [root],
      upload: async path => path === image ? 'img_v3_qr' : '',
    });
    expect(result.content).toBe('![二维码](img:0)');
    expect(result.imageKeys).toEqual(['img_v3_qr']);
    expect(result.discovered).toBe(1);
    expect(result.skipped).toEqual([]);
  });

  it('degrades only the failed image while preserving text and successful images', async () => {
    const first = join(root, 'first.png');
    const second = join(root, 'second.png');
    writeFileSync(first, 'png');
    writeFileSync(second, 'png');
    const result = await resolveOutboundLocalImages(`开头。\n![](${first})\n中间。\n![](${second})\n结尾。`, {
      roots: [root],
      upload: async path => {
        if (path === first) throw new Error('network down');
        return 'img_v3_second';
      },
    });
    expect(result.content).toContain('开头。');
    expect(result.content).toContain('本地图片上传失败');
    expect(result.content).toContain('![](img:0)');
    expect(result.content).toContain('结尾。');
    expect(result.imageKeys).toEqual(['img_v3_second']);
    expect(result.skipped).toEqual([{ reason: 'upload_failed' }]);
  });
});
