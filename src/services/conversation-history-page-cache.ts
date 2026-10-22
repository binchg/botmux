/** 以授权内容和来源指纹复用渲染结果；预加载与浏览共享一个有界后台队列。 */
import { createHash } from 'node:crypto';
import { historySources, readHistoryBundle } from './conversation-history-reader.js';
import { renderConversationHistory } from './conversation-history-page.js';
import type { ConversationHistory } from './conversation-history-store.js';

interface PageState {
  page?: ReturnType<typeof renderConversationHistory>;
  error?: boolean;
  pending: boolean;
}
const pages = new Map<string, PageState>();
let queue = Promise.resolve();

/** 调用方先校验有效期和访问保护；命中时仍逐次重验来源文件及关联关系。 */
export function cachedHistoryPage(history: ConversationHistory, dataDir: string): PageState {
  const snapshot = historySources(history, dataDir);
  const key = createHash('sha256').update(dataDir).update(JSON.stringify(history))
    .update(JSON.stringify(snapshot)).digest('hex');
  const old = pages.get(key);
  if (old) return old;
  if ([...pages.values()].filter(item => item.pending).length >= 8) return { pending: false, error: true };
  const state: PageState = { pending: true };
  pages.set(key, state);
  queue = queue.then(async () => {
    // 先让首屏响应发出，读取和 Markdown 渲染不占据首屏的请求链路。
    await new Promise<void>(resolve => setImmediate(resolve));
    try {
      const bundle = await readHistoryBundle(history, dataDir, snapshot);
      state.page = renderConversationHistory(history, bundle.messages, bundle);
    } catch { state.error = true; }
    finally { state.pending = false; }
    let bytes = [...pages.values()].reduce((sum, item) => sum + Buffer.byteLength(item.page?.html ?? ''), 0);
    for (const [entryKey, entry] of pages) {
      if (pages.size <= 8 && bytes <= 32 * 1024 * 1024) break;
      if (entry.pending) continue;
      bytes -= Buffer.byteLength(entry.page?.html ?? ''); pages.delete(entryKey);
    }
    // 短暂文件错误允许后续访问重试；不把失败永久缓存。
    if (state.error) pages.delete(key);
  });
  return state;
}
