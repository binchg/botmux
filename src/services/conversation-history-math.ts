import type MarkdownIt from 'markdown-it';
import katex from 'katex';

/** Native MathML keeps formulas selectable without remote fonts or scripts. */
export function historyMath(md: MarkdownIt): void {
  md.inline.ruler.before('escape', 'history_math', (state, silent) => {
    const rest = state.src.slice(state.pos);
    const open = ['$$', '\\[', '\\(', '$'].find(value => rest.startsWith(value));
    if (!open || (open === '$' && /\s/.test(rest[1] ?? ' '))) return false;
    const close = open === '\\[' ? '\\]' : open === '\\(' ? '\\)' : open;
    const end = state.src.indexOf(close, state.pos + open.length);
    if (end < 0 || (open === '$' && /\s/.test(state.src[end - 1]))) return false;
    if (!silent) {
      const token = state.push('history_math', '', 0);
      token.content = state.src.slice(state.pos + open.length, end);
      token.meta = { display: open === '$$' || open === '\\[' };
    }
    state.pos = end + close.length;
    return true;
  });
  md.renderer.rules.history_math = (tokens, index) => {
    const token = tokens[index];
    try { return katex.renderToString(token.content, { output: 'mathml', displayMode: token.meta?.display,
      throwOnError: true, trust: false, strict: 'ignore', maxExpand: 1000, maxSize: 20 }); }
    catch { return md.utils.escapeHtml(token.content); }
  };
}
