import type MarkdownIt from 'markdown-it';
import type { HistoryMessage } from './conversation-history-store.js';

interface ImageEnv { images: Map<number, string>; used: Set<number> }

/** Only the server's opaque, conversation-scoped image URLs can become image tags. */
export function historyImageMarkdown(md: MarkdownIt): void {
  const original = md.renderer.rules.text;
  md.renderer.rules.text = (tokens, index, options, env: ImageEnv, renderer) => {
    const value = tokens[index].content;
    if (!env?.images?.size) return original ? original(tokens, index, options, env, renderer) : md.utils.escapeHtml(value);
    let output = '', start = 0;
    for (const match of value.matchAll(/\[图片\s*(\d+)\]/g)) {
      output += md.utils.escapeHtml(value.slice(start, match.index));
      const number = Number(match[1]);
      output += env.images.get(number) ?? md.utils.escapeHtml(match[0]);
      if (env.images.has(number)) env.used.add(number);
      start = match.index! + match[0].length;
    }
    return output + md.utils.escapeHtml(value.slice(start));
  };
}

export function renderHistoryMessageMarkdown(md: MarkdownIt, token: string, message: HistoryMessage): string {
  const env: ImageEnv = { images: new Map(), used: new Set() };
  if (/^[A-Za-z0-9_-]{43}$/.test(token)) for (const image of message.images ?? []) {
    if (!/^[a-f0-9]{32}$/.test(image.id) || !Number.isSafeInteger(image.index) || image.index < 1) continue;
    const url = `/conversation/${token}/images/${image.id}`;
    env.images.set(image.index, `<a class="history-image" href="${url}" target="_blank" rel="noopener noreferrer"><img src="${url}" alt="图片 ${image.index}" loading="lazy" decoding="async"><span>图片 ${image.index} · 点击查看原图</span></a>`);
  }
  const body = md.render(message.content, env);
  return body + [...env.images].filter(([index]) => !env.used.has(index)).map(([, html]) => html).join('');
}
