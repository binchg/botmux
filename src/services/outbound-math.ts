/** Local KaTeX layout for formula-bearing blocks; ordinary prose stays native. */
import MarkdownIt from 'markdown-it';
import katex from 'katex';
import { createRequire } from 'node:module';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { chromium } from 'playwright';

const require = createRequire(import.meta.url);
const parser = new MarkdownIt({ html: false, breaks: true });
const escaped = (s: string, i: number) => {
  let n = 0;
  while (i > 0 && s[--i] === '\\') n++;
  return n % 2 === 1;
};

// Before CommonMark escape handling, so \(...\) survives intact. Code spans
// and fences are consumed by their own parser rules and never interpreted.
parser.inline.ruler.before('escape', 'math', (state, silent) => {
  const start = state.pos;
  const src = state.src;
  const open = src.startsWith('\\(', start) ? '\\(' : src.startsWith('\\[', start) ? '\\[' : src.startsWith('$$', start) ? '$$' : src[start] === '$' ? '$' : '';
  if (!open || escaped(src, start)) return false;
  const close = open === '\\(' ? '\\)' : open === '\\[' ? '\\]' : open;
  const from = start + open.length;
  if (open === '$' && /\s/.test(src[from] ?? ' ')) return false;
  let end = src.indexOf(close, from);
  while (end >= 0 && escaped(src, end)) end = src.indexOf(close, end + close.length);
  if (end < 0 || end === from) return false;
  if (open === '$' && (/\s/.test(src[end - 1]) || /\d/.test(src[end + 1] ?? '') || src.slice(from, end).includes('\n'))) return false;
  const tex = src.slice(from, end);
  // Currency pairs like "$20 and $30" are not equations.
  if (open === '$' && /^\d[\d.,]*(?:\s+[A-Za-z]+)*$/.test(tex)) return false;
  if (!silent) {
    const token = state.push('math', '', 0);
    token.content = tex;
    token.markup = open;
  }
  state.pos = end + close.length;
  return true;
});
parser.renderer.rules.math = (tokens, idx) => katex.renderToString(tokens[idx].content, {
  displayMode: ['$$', '\\['].includes(tokens[idx].markup),
  throwOnError: true, trust: false, maxExpand: 1000, maxSize: 20,
});

export interface MathBlock { start: number; end: number; source: string; html: string }
/** Top-level source ranges preserve lists/tables around inline formulae. */
export function mathBlocks(input: string): MathBlock[] {
  const tokens = parser.parse(input, {});
  const lines = input.split('\n');
  const blocks: MathBlock[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (token.level !== 0 || !token.map || token.nesting === -1 || ['fence', 'code_block'].includes(token.type)) continue;
    let j = i + 1;
    if (token.nesting === 1) while (j < tokens.length && !(tokens[j].level === 0 && tokens[j].nesting === -1)) j++;
    const inner = tokens.slice(i, j + 1);
    if (!inner.some(t => t.children?.some(c => c.type === 'math'))) continue;
    const [start, end] = token.map;
    const source = lines.slice(start, end).join('\n');
    // Bad/unsupported TeX leaves the entire original block readable.
    try { blocks.push({ start, end, source, html: parser.render(source) }); } catch { /* keep source */ }
    i = j;
  }
  return blocks;
}

export async function renderMathBlockImages(input: string, upload: (path: string) => Promise<string>): Promise<string> {
  if (!/\$|\\[([]/.test(input)) return input;
  const blocks = mathBlocks(input);
  if (!blocks.length) return input;
  const dir = mkdtempSync(join(tmpdir(), 'botmux-math-'));
  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
  try {
    browser = await chromium.launch({ headless: true, timeout: 15000,
      ...(process.env.BOTMUX_CHROMIUM_PATH ? { executablePath: process.env.BOTMUX_CHROMIUM_PATH } : {}) });
    const page = await browser.newPage({ viewport: { width: 600, height: 600 }, deviceScaleFactor: 2 });
    // No external URLs from model output are fetched; font assets are embedded.
    await page.route('**/*', route => route.abort());
    const root = dirname(require.resolve('katex/package.json'));
    const css = readFileSync(join(root, 'dist/katex.min.css'), 'utf8').replace(/url\(([^)]+)\)/g, (_m, name: string) => {
      const path = name.replace(/['"]/g, '');
      return `url(data:font/woff2;base64,${readFileSync(join(root, 'dist', path)).toString('base64')})`;
    });
    const lines = input.split('\n');
    // Reverse replacement keeps line positions stable. Uploads stay bot-scoped.
    for (const block of [...blocks].reverse()) {
      try {
        await page.setContent(`<meta charset="utf-8"><style>${css}
body{margin:0;background:white;color:#202124;font:22px/1.65 sans-serif}article{padding:14px 20px;width:560px;box-sizing:border-box;overflow-wrap:anywhere}p{margin:0 0 10px}.katex-display{overflow:visible}table{border-collapse:collapse}td,th{border:1px solid #ddd;padding:8px}pre,code{font-family:monospace}a{color:#2767bd}</style><article>${block.html}</article>`, { timeout: 10000 });
        await page.evaluate(() => document.fonts.ready);
        const article = page.locator('article');
        const size = await article.boundingBox();
        if (!size || size.height > 8000) continue;
        // Include wide equations rather than silently clipping them.
        const width = await article.evaluate(el => el.scrollWidth);
        if (width > 2000) continue;
        if (width > 560) await article.evaluate((el, w) => { (el as HTMLElement).style.width = `${w}px`; }, width);
        const file = join(dir, `${block.start}.png`);
        await article.screenshot({ path: file, timeout: 10000 });
        const key = await upload(file);
        if (!/^img_v\d+_[A-Za-z0-9_-]+$/.test(key)) continue;
        lines.splice(block.start, block.end - block.start, `\n![公式排版](${key})\n`);
      } catch { /* Rendering or upload failure must not drop the answer. */ }
    }
    return lines.join('\n');
  } catch { return input; }
  finally { await browser?.close().catch(() => {}); rmSync(dir, { recursive: true, force: true }); }
}
