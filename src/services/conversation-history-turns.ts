/** 以真实用户追问分段，默认仅露出本段最后一条进度，完整正文可展开。 */
import type { HistoryMessage } from './conversation-history-store.js';

export function renderHistoryTurns(
  messages: HistoryMessage[],
  render: (message: HistoryMessage) => string,
  escape: (text: string) => string,
): string {
  const output: string[] = [];
  let pending: HistoryMessage[] = [];
  const flush = () => {
    const progress = pending.filter(message => message.kind === 'assistant_progress');
    const last = progress.at(-1);
    for (const message of pending) {
      if (message.kind !== 'assistant_progress') output.push(render(message));
      else if (message === last) {
        output.push(`<details class="history-progress"><summary><span class="progress-label">阶段回复 · ${progress.length} 条 · 展开查看全部</span><span class="progress-preview">${escape(last.content)}</span></summary><div class="progress-expanded">${progress.map(render).join('\n')}</div></details>`);
      }
    }
    pending = [];
  };
  for (const message of messages) {
    if (message.kind === 'user') { flush(); output.push(render(message)); }
    else pending.push(message);
  }
  flush();
  return output.join('\n');
}
