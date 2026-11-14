/** Copyable mathematical text for card clients without a TeX renderer. */
import MarkdownIt from 'markdown-it';
import katex from 'katex';

const parser = new MarkdownIt({ html: false });
interface MathNode { tag: string; variant?: string; children: Array<MathNode | string> }
const decode = (s: string) => s.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos|nbsp);/gi, (_m, e: string) => {
  if (e.startsWith('#')) return String.fromCodePoint(parseInt(e.slice(e[1] === 'x' ? 2 : 1), e[1] === 'x' ? 16 : 10));
  return ({ amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' } as Record<string, string>)[e] ?? _m;
});

// Unicode has an incomplete alphabet: convert a whole script or retain explicit
// grouping. Never mix baseline and raised characters within the same index.
const subscript = new Map([..."0123456789+-=()aehijklmnoprstuvxβγρφχ"].map((c, i) => [c, [..."₀₁₂₃₄₅₆₇₈₉₊₋₌₍₎ₐₑₕᵢⱼₖₗₘₙₒₚᵣₛₜᵤᵥₓᵦᵧᵨᵩᵪ"][i]]));
const superscript = new Map([..."0123456789+-=()abcdefghijklmnoprstuvwxyz"].map((c, i) => [c, [..."⁰¹²³⁴⁵⁶⁷⁸⁹⁺⁻⁼⁽⁾ᵃᵇᶜᵈᵉᶠᵍʰⁱʲᵏˡᵐⁿᵒᵖʳˢᵗᵘᵛʷˣʸᶻ"][i]]));
function script(text: string, upper = false): string {
  text = text.trim();
  const alphabet = upper ? superscript : subscript;
  if (text && [...text].every(c => alphabet.has(c))) return [...text].map(c => alphabet.get(c)).join('');
  return `${upper ? '^' : '_'}${[...text].length === 1 ? text : `(${text})`}`;
}
function brace(node: MathNode | string | undefined): boolean {
  return !!node && typeof node !== 'string' && ['munder', 'mover'].includes(node.tag)
    && /[⏟⏞⎵⎴]/.test(plainMath(node.children[1] ?? ''));
}

function plainMath(node: MathNode | string): string {
  if (typeof node === 'string') return decode(node);
  if (node.tag === 'annotation') return '';
  const parts = node.children.map(plainMath);
  const base = (parts[0] ?? '').trim();
  const first = node.children[0];
  const scriptBase = typeof first !== 'string' && first &&
    (first.tag === 'mfrac' || (first.tag === 'mrow' && first.children.length > 1)) ? `(${base})` : base;
  if (node.variant && !['normal', 'italic'].includes(node.variant)) {
    if (node.variant !== 'bold' || !/^[A-Za-z0-9]+$/.test(parts.join(''))) throw new Error('Keep styled TeX source');
    return [...parts.join('')].map(c => String.fromCodePoint(c.charCodeAt(0) + (/[A-Z]/.test(c) ? 0x1d400 - 65 : /[a-z]/.test(c) ? 0x1d41a - 97 : 0x1d7ce - 48))).join('');
  }
  switch (node.tag) {
    case 'mfrac': return `(${base})/(${parts[1] ?? ''})`;
    case 'msqrt': return `√(${parts.join('')})`;
    case 'mroot': return `root(${parts[1]}, ${base})`;
    case 'munder': case 'mover': {
      if (brace(first)) return `${base}（${(parts[1] ?? '').trim()}）`;
      const mark = (parts[1] ?? '').trim();
      if (/[⏟⏞⎵⎴]/.test(mark)) return `[${base}]`;
      if (node.tag === 'munder') return `${scriptBase}${script(parts[1] ?? '')}`;
      const accent: Record<string, string> = { '^': '\u0302', 'ˉ': '\u0304', '¯': '\u0304', '⃗': '\u20d7', '~': '\u0303', '˜': '\u0303', '˙': '\u0307', '¨': '\u0308' };
      if ([...base].length === 1 && accent[mark]) return base + accent[mark];
      throw new Error('Keep complex accent TeX source');
    }
    case 'msub': return `${scriptBase}${script(parts[1] ?? '')}`;
    case 'msup': return `${scriptBase}${script(parts[1] ?? '', true)}`;
    case 'msubsup': case 'munderover': return `${scriptBase}${script(parts[1] ?? '')}${script(parts[2] ?? '', true)}`;
    case 'mtable': return `[${parts.join('; ')}]`;
    case 'mtr': return parts.join(', ');
    case 'mspace': return ' ';
    case 'mo': return ` ${parts.join('')} `;
    default: return parts.map((part, i) => {
      const previous = node.children[i - 1], current = node.children[i];
      // TeX's unbraced words/indices arrive as consecutive identifier nodes.
      const identifiers = previous && typeof previous !== 'string' && typeof current !== 'string' && previous.tag === 'mi' && current.tag === 'mi';
      return (i && !identifiers ? ' ' : '') + part;
    }).join('');
  }
}

/** KaTeX supplies symbol/structure semantics; no browser, files, or images. */
export function mathToText(tex: string): string {
  const xml = katex.renderToString(tex, { output: 'mathml', throwOnError: true, trust: false, strict: 'ignore', maxExpand: 1000, maxSize: 20 });
  const root: MathNode = { tag: 'root', children: [] };
  const stack = [root];
  for (const token of xml.match(/<[^>]*>|[^<]+/g) ?? []) {
    if (token.startsWith('</')) { stack.pop(); continue; }
    if (token.startsWith('<')) {
      const tag = token.match(/^<([\w-]+)/)?.[1];
      if (!tag) continue;
      if (/accentunder="true"/.test(token) || ['menclose', 'mphantom', 'mpadded', 'maction'].includes(tag)) throw new Error('Keep complex TeX source');
      const node: MathNode = { tag, variant: token.match(/mathvariant="([^"]+)"/)?.[1], children: [] };
      stack[stack.length - 1].children.push(node);
      if (!token.endsWith('/>')) stack.push(node);
    } else stack[stack.length - 1].children.push(token);
  }
  return plainMath(root).replace(/[\u2061\u2062\u200b]/g, ' ').replace(/\s+/g, ' ').trim();
}

function code(text: string): string {
  const longest = Math.max(0, ...(text.match(/`+/g) ?? []).map(s => s.length));
  const fence = '`'.repeat(longest + 1);
  return `${fence} ${text} ${fence}`;
}

/** Preserve Markdown source byte-for-byte outside formula spans. */
export function formatMathForLark(input: string): string {
  if (!/\$|\\[([]/.test(input)) return input;
  const lines = input.split('\n');
  const offsets = [0];
  for (const line of lines) offsets.push(offsets[offsets.length - 1] + line.length + 1);
  const protectedRanges = parser.parse(input, {}).filter(t => ['fence', 'code_block', 'html_block'].includes(t.type) && t.map)
    .map(t => [offsets[t.map![0]], offsets[t.map![1]]] as const);
  let result = '', from = 0, i = 0;
  const escaped = (at: number) => { let n = 0; while (at > 0 && input[--at] === '\\') n++; return n % 2 === 1; };
  while (i < input.length) {
    const range = protectedRanges.find(([start, end]) => i >= start && i < end);
    if (range) { i = range[1]; continue; }
    // Link destinations and explicit URLs are data, even when they contain $.
    if (/^https?:\/\//.test(input.slice(i))) {
      const tail = input.slice(i).search(/[\s<>]/);
      i = tail < 0 ? input.length : i + tail;
      continue;
    }
    if (input.startsWith('](', i)) {
      let depth = 1, end = i + 2;
      while (end < input.length && depth) {
        if (!escaped(end)) {
          if (input[end] === '(') depth++;
          else if (input[end] === ')') depth--;
        }
        end++;
      }
      if (!depth) { i = end; continue; }
    }
    if (input[i] === '`' && !escaped(i)) {
      const run = input.slice(i).match(/^`+/)![0];
      let end = input.indexOf(run, i + run.length);
      while (end >= 0 && (input[end - 1] === '`' || input[end + run.length] === '`')) end = input.indexOf(run, end + run.length);
      i = end < 0 ? i + run.length : end + run.length;
      continue;
    }
    const open = input.startsWith('\\(', i) ? '\\(' : input.startsWith('\\[', i) ? '\\[' : input.startsWith('$$', i) ? '$$' : input[i] === '$' ? '$' : '';
    if (!open || escaped(i)) { i++; continue; }
    const close = open === '\\(' ? '\\)' : open === '\\[' ? '\\]' : open;
    const start = i + open.length;
    let end = input.indexOf(close, start);
    while (end >= 0 && escaped(end)) end = input.indexOf(close, end + close.length);
    if (end < 0 || end === start || protectedRanges.some(([a, b]) => a < end + close.length && b > i)) { i += open.length; continue; }
    const tex = input.slice(start, end);
    if (open === '$' && (/^\s|\s$|\n/.test(tex) || /\d/.test(input[end + 1] ?? '') || /^\d[\d.,]*(?:\s+[A-Za-z]+)*$/.test(tex))) { i += open.length; continue; }
    let text: string;
    try { text = mathToText(tex); } catch { text = tex.trim(); }
    if (!text) { i = end + close.length; continue; }
    const lineEnd = input.indexOf('\n', end + close.length);
    const standalone = ['$$', '\\['].includes(open) && !input.slice(input.lastIndexOf('\n', i - 1) + 1, i).trim()
      && !input.slice(end + close.length, lineEnd < 0 ? input.length : lineEnd).trim();
    const fence = '`'.repeat(Math.max(3, ...(text.match(/`+/g) ?? []).map(s => s.length + 1)));
    const replacement = standalone ? `${fence}text\n${text}\n${fence}` : code(text);
    result += input.slice(from, i) + replacement;
    from = end + close.length;
    i = from;
  }
  return result + input.slice(from);
}
