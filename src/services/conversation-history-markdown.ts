import type MarkdownIt from 'markdown-it';
import { historyMath } from './conversation-history-math.js';

/** Local-only Markdown widgets, preserving code literally and escaping all tokens. */
export function historyMarkdown(md: MarkdownIt): void {
  historyMath(md);
  md.renderer.rules.fence = (tokens, index) => {
    const token = tokens[index], language = token.info.trim().split(/\s/)[0] || 'text';
    const escape = md.utils.escapeHtml;
    let code = escape(token.content);
    if (language.toLowerCase() === 'json') {
      const pattern = /"(?:\\.|[^"\\])*"|\b(?:true|false|null|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)\b/g;
      let start = 0; code = '';
      for (const match of token.content.matchAll(pattern)) {
        const end = match.index! + match[0].length;
        const kind = match[0][0] === '"' ? /^\s*:/.test(token.content.slice(end)) ? 'key' : 'string' : 'number';
        code += escape(token.content.slice(start, match.index)) + `<span class="code-${kind}">${escape(match[0])}</span>`;
        start = end;
      }
      code += escape(token.content.slice(start));
    }
    return `<div class="code-block"><div class="code-head"><span>${escape(language)}</span><button type="button" data-copy-code aria-label="复制代码">复制代码</button></div><pre><code>${code}</code></pre></div>`;
  };
  md.core.ruler.after('inline', 'history_tasks', state => {
    let inList = 0;
    for (const token of state.tokens) {
      if (token.type === 'list_item_open') inList++;
      if (token.type === 'list_item_close') inList--;
      if (!inList || token.type !== 'inline') continue;
      const first = token.children?.[0];
      const match = first?.type === 'text' && /^\[([ xX])\]\s/.exec(first.content);
      if (!match || !first || !token.children) continue;
      first.content = first.content.slice(match[0].length);
      const checkbox = new state.Token('html_inline', '', 0);
      checkbox.content = `<input class="task-checkbox" type="checkbox" disabled${match[1] !== ' ' ? ' checked' : ''} aria-label="${match[1] !== ' ' ? '已完成' : '未完成'}">`;
      token.children.unshift(checkbox);
    }
  });
}
