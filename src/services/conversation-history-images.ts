/** Images come from downloaded incoming metadata, never from paths in message text. */
import { createHash } from 'node:crypto';
import { constants, realpathSync, statSync } from 'node:fs';
import { open } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { historyLineage } from './conversation-history-lineage.js';
import { readCachedHistoryTranscript } from './conversation-history-transcript-cache.js';
import { visibleHistoryText, type ConversationHistory, type HistoryImage, type HistoryMessage } from './conversation-history-store.js';

const MESSAGE = /^om_[A-Za-z0-9]+$/;
const NAME = /^[^/\\\x00]{1,255}$/;
const MAX_IMAGE = 20 * 1024 * 1024;
const imageId = (token: string, messageId: string, name: string) => createHash('sha256')
  .update(JSON.stringify([token, messageId, name])).digest('hex').slice(0, 32);

/** Queue signatures participate in the page cache, including backfilled attachments. */
export function historyImageSources(history: ConversationHistory, dataDir: string) {
  const roots = history.nativeSource ? [history.nativeSource.rootMessageId]
    : historyLineage(history, dataDir).flatMap(item => [item.rootMessageId, ...Object.keys(item.replyThreadAliases ?? {})]);
  return [...new Set(roots)].filter(root => root && MESSAGE.test(root)).map(root => {
    const path = join(dataDir, 'queues', `${root}.jsonl`);
    try {
      const stat = statSync(path);
      return { root, path, signature: `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}` };
    } catch { return { root, path, signature: 'missing' }; }
  });
}

/** Normalized queue text and download metadata are both persisted before model input. */
async function imageMessages(history: ConversationHistory, dataDir: string,
  sources = historyImageSources(history, dataDir)): Promise<HistoryMessage[]> {
  const result: HistoryMessage[] = [];
  for (const source of sources) {
    if (source.signature === 'missing') continue;
    const messages = await readCachedHistoryTranscript(source.path, `history-images:${source.root}`, (value: any) => {
      if (!MESSAGE.test(value?.messageId) || (value.rootId !== source.root && value.messageId !== source.root)
        || value.senderType !== 'user' || typeof value.content !== 'string' || !Array.isArray(value.attachments)) return;
      const at = Number(value.createTime), content = visibleHistoryText(value.content, 'user');
      if (!Number.isFinite(at) || !content) return;
      let index = 0;
      const images: HistoryImage[] = [];
      for (const attachment of value.attachments) {
        if (attachment?.type !== 'image') continue;
        index++;
        const name = attachment.name;
        if (typeof name !== 'string' || !NAME.test(name) || name === '.' || name === '..'
          || typeof attachment.path !== 'string' || basename(attachment.path) !== name) continue;
        // An arbitrary path in a forged text envelope cannot grant file access.
        try {
          const expected = join(realpathSync(join(dataDir, 'attachments')), value.messageId, name);
          if (realpathSync(attachment.path) !== expected) continue;
        } catch { continue; }
        images.push({ id: '', messageId: value.messageId, name, index });
      }
      return images.length ? { id: value.messageId, kind: 'user', at, content, images } : undefined;
    });
    result.push(...messages.map(item => ({ ...item, images: item.images!.map(image => ({ ...image,
      id: imageId(history.token, image.messageId, image.name) })) })));
  }
  return [...new Map(result.map(item => [item.id, item])).values()].sort((a, b) => a.at - b.at);
}

/** Match occurrences once, using exact public text and nearby receive time. */
export async function attachHistoryImages(history: ConversationHistory, dataDir: string, messages: HistoryMessage[],
  sources = historyImageSources(history, dataDir)): Promise<HistoryMessage[]> {
  const candidates = await imageMessages(history, dataDir, sources);
  const used = new Set<string>();
  return messages.map(message => {
    const { images: _untrusted, ...plain } = message;
    if (message.kind !== 'user') return plain;
    const match = candidates.filter(item => !used.has(item.id) && item.content === message.content
      && Math.abs(item.at - message.at) <= 120_000)
      .sort((a, b) => Math.abs(a.at - message.at) - Math.abs(b.at - message.at))[0];
    if (!match) return plain;
    used.add(match.id);
    return { ...plain, images: match.images };
  });
}

/** Resolve a per-link opaque ID within that topic only; reject non-raster and symlinks. */
export async function readHistoryImage(history: ConversationHistory, dataDir: string, id: string) {
  if (!/^[a-f0-9]{32}$/.test(id)) return;
  const image = (await imageMessages(history, dataDir)).flatMap(item => item.images ?? []).find(item => item.id === id);
  if (!image) return;
  let file;
  try {
    const root = realpathSync(join(dataDir, 'attachments'));
    const path = join(root, image.messageId, image.name);
    if (realpathSync(path) !== path) return;
    file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const stat = await file.stat();
    if (!stat.isFile() || stat.size < 12 || stat.size > MAX_IMAGE) return;
    const body = Buffer.alloc(stat.size);
    let offset = 0;
    while (offset < body.length) {
      const { bytesRead } = await file.read(body, offset, body.length - offset, offset);
      if (!bytesRead) return;
      offset += bytesRead;
    }
    const type = body[0] === 0xff && body[1] === 0xd8 && body[2] === 0xff ? 'image/jpeg'
      : body.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) ? 'image/png'
      : /^GIF8[79]a$/.test(body.subarray(0, 6).toString()) ? 'image/gif'
      : body.subarray(0, 4).toString() === 'RIFF' && body.subarray(8, 12).toString() === 'WEBP' ? 'image/webp' : undefined;
    if (type) return { body, type };
  } catch { return; }
  finally { await file?.close(); }
}
