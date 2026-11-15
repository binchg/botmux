/** Present natural-language pseudocode as indented steps without changing its meaning. */
export function renderHistoryLogic(source: string, language: string, escape: (text: string) => string): string | undefined {
  if (!['text', 'plaintext', ''].includes(language.toLowerCase()) || source.length > 12000) return;
  const lines = source.trimEnd().split(/\r?\n/);
  if (lines.length > 160 || lines.filter(line => /^\s*(?:如果|否则|入口[：:])/.test(line)).length < 2) return;
  // Actual code and diagrams retain their literal fence rendering.
  if (lines.some(line => /^\s*(?:[{}]|(?:const|let|var|def|function|class|import)\s)/.test(line))) return;
  const expanded = lines.map(line => line.replace(/\t/g, '    '));
  const indents = expanded.filter(line => line.trim()).map(line => /^ */.exec(line)![0].length);
  const base = Math.min(...indents), step = Math.min(...indents.filter(size => size > base).map(size => size - base));
  const rows = expanded.map(line => {
    if (!line.trim()) return '<div class="logic-space" aria-hidden="true"></div>';
    const depth = Number.isFinite(step) ? Math.min(6, Math.round((/^ */.exec(line)![0].length - base) / step)) : 0;
    const branch = /^\s*(?:如果|否则|入口[：:])/.test(line);
    return `<div class="logic-step${branch ? ' logic-branch' : ''}" style="--depth:${depth}" role="listitem">${escape(line.trim())}</div>`;
  }).join('');
  return `<div class="logic-block"><div class="code-head">处理流程</div><div class="logic-steps" role="list">${rows}</div></div>`;
}
