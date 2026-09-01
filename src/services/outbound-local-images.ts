import { realpathSync, statSync } from 'node:fs';
import { extname, isAbsolute, relative, sep } from 'node:path';

const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp']);
const DEFAULT_MAX_IMAGE_BYTES = 10 * 1024 * 1024;

export interface PrepareOutboundLocalImagesOptions {
  roots: string[];
  maxBytes?: number;
}

export interface PreparedOutboundLocalImages {
  content: string;
  paths: string[];
  skipped: Array<{ reason: string }>;
}

export interface ResolveOutboundLocalImagesOptions extends PrepareOutboundLocalImagesOptions {
  upload: (path: string) => Promise<string>;
}

export interface ResolvedOutboundLocalImages {
  content: string;
  imageKeys: string[];
  discovered: number;
  skipped: Array<{ reason: string }>;
}

const LOCAL_IMAGE_TOKEN = /!\[([^\]]*)\]\(\s*(?:<([^>]+)>|([^\s)]+))\s*\)/g;
const PREPARED_IMAGE_TOKEN = /!\[([^\]]*)\]\(botmux-local-image:(\d+)\)/g;

function insideRoot(path: string, root: string): boolean {
  const rel = relative(root, path);
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

function safeRealpath(path: string): string | null {
  try { return realpathSync(path); } catch { return null; }
}

function resolvedRoots(roots: string[]): string[] {
  return roots
    .map(root => safeRealpath(root))
    .filter((root): root is string => !!root);
}

function replacementForFailure(reason: string): string {
  const labels: Record<string, string> = {
    outside_allowed_roots: '本地图片不在当前会话允许目录',
    missing: '本地图片不存在',
    not_file: '本地图片不是普通文件',
    unsupported_type: '本地图片格式不支持',
    too_large: '本地图片超过 10MB',
    upload_failed: '本地图片上传失败',
  };
  return `*（图片未发送：${labels[reason] ?? '本地图片不可用'}）*`;
}

/**
 * Replace local Markdown image paths with private prepared placeholders. Only
 * real image files below an explicitly allowed root are accepted; rejected
 * paths are not echoed back into the outbound card.
 */
export function prepareOutboundLocalImages(
  input: string,
  opts: PrepareOutboundLocalImagesOptions,
): PreparedOutboundLocalImages {
  if (!input) return { content: input, paths: [], skipped: [] };
  const roots = resolvedRoots(opts.roots);
  const maxBytes = opts.maxBytes ?? DEFAULT_MAX_IMAGE_BYTES;
  const paths: string[] = [];
  const indexByPath = new Map<string, number>();
  const skipped: Array<{ reason: string }> = [];
  let fenceChar = '';
  let fenceLen = 0;

  const lines = input.split('\n').map(line => {
    const fence = line.match(/^ {0,3}(`{3,}|~{3,})(.*)$/);
    if (fence) {
      const run = fence[1];
      const ch = run[0];
      if (!fenceChar) {
        fenceChar = ch;
        fenceLen = run.length;
      } else if (ch === fenceChar && run.length >= fenceLen && fence[2].trim() === '') {
        fenceChar = '';
        fenceLen = 0;
      }
      return line;
    }
    if (fenceChar || /^ {4}/.test(line)) return line;

    return line.replace(LOCAL_IMAGE_TOKEN, (full, alt: string, anglePath: string, plainPath: string) => {
      const rawPath = anglePath || plainPath || '';
      if (!rawPath.startsWith('/')) return full;
      const realPath = safeRealpath(rawPath);
      if (!realPath) {
        skipped.push({ reason: 'missing' });
        return replacementForFailure('missing');
      }
      if (!roots.some(root => insideRoot(realPath, root))) {
        skipped.push({ reason: 'outside_allowed_roots' });
        return replacementForFailure('outside_allowed_roots');
      }
      let stat;
      try { stat = statSync(realPath); } catch {
        skipped.push({ reason: 'missing' });
        return replacementForFailure('missing');
      }
      if (!stat.isFile()) {
        skipped.push({ reason: 'not_file' });
        return replacementForFailure('not_file');
      }
      if (!IMAGE_EXTENSIONS.has(extname(realPath).toLowerCase())) {
        skipped.push({ reason: 'unsupported_type' });
        return replacementForFailure('unsupported_type');
      }
      if (stat.size > maxBytes) {
        skipped.push({ reason: 'too_large' });
        return replacementForFailure('too_large');
      }
      let index = indexByPath.get(realPath);
      if (index === undefined) {
        index = paths.length;
        paths.push(realPath);
        indexByPath.set(realPath, index);
      }
      return `![${alt}](botmux-local-image:${index})`;
    });
  });

  return { content: lines.join('\n'), paths, skipped };
}

/**
 * Validate local Markdown images, upload each file independently, then resolve
 * successful uploads to the shared `img:N` card placeholders. A failed upload
 * only replaces that image with a visible fallback; it never suppresses the
 * surrounding progress/final text.
 */
export async function resolveOutboundLocalImages(
  input: string,
  opts: ResolveOutboundLocalImagesOptions,
): Promise<ResolvedOutboundLocalImages> {
  const prepared = prepareOutboundLocalImages(input, opts);
  if (prepared.paths.length === 0) {
    return {
      content: prepared.content,
      imageKeys: [],
      discovered: 0,
      skipped: prepared.skipped,
    };
  }

  const results = await Promise.allSettled(prepared.paths.map(path => opts.upload(path)));
  const imageKeys: string[] = [];
  const resolvedIndexes = new Map<number, number>();
  const uploadFailures = new Set<number>();
  for (let index = 0; index < results.length; index++) {
    const result = results[index];
    if (result.status === 'fulfilled' && result.value) {
      resolvedIndexes.set(index, imageKeys.length);
      imageKeys.push(result.value);
    } else {
      uploadFailures.add(index);
    }
  }

  const content = prepared.content.replace(PREPARED_IMAGE_TOKEN, (_full, alt: string, indexText: string) => {
    const preparedIndex = Number(indexText);
    const resolvedIndex = resolvedIndexes.get(preparedIndex);
    if (resolvedIndex !== undefined) return `![${alt}](img:${resolvedIndex})`;
    return replacementForFailure('upload_failed');
  });

  return {
    content,
    imageKeys,
    discovered: prepared.paths.length,
    skipped: [
      ...prepared.skipped,
      ...Array.from(uploadFailures, () => ({ reason: 'upload_failed' })),
    ],
  };
}
