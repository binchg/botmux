import MarkdownIt from 'markdown-it';
import type Token from 'markdown-it/lib/token.mjs';

const md = new MarkdownIt({ html: false, linkify: false, breaks: false });

/** 飞书每张卡片最多支持 5 个原生表格组件。 */
export const MAX_NATIVE_TABLES = 5;

/** Build a Feishu native `table` element from a `table_open … table_close` token slice. */
function buildTableFromTokens(tokens: Token[]) {
  const headerCells: string[] = [];
  const bodyRows: string[][] = [];
  let inHead = false;
  let inBody = false;
  let currentRow: string[] | null = null;
  let inCell = false;

  for (const t of tokens) {
    switch (t.type) {
      case 'thead_open': inHead = true; break;
      case 'thead_close': inHead = false; break;
      case 'tbody_open': inBody = true; break;
      case 'tbody_close': inBody = false; break;
      case 'tr_open': currentRow = []; break;
      case 'tr_close':
        if (inBody && currentRow) bodyRows.push(currentRow);
        currentRow = null;
        break;
      case 'th_open':
      case 'td_open': inCell = true; break;
      case 'th_close':
      case 'td_close': inCell = false; break;
      case 'inline':
        if (inCell) {
          if (inHead) headerCells.push(t.content);
          else if (currentRow) currentRow.push(t.content);
        }
        break;
    }
  }

  if (headerCells.length === 0) return null;

  const columns = headerCells.map((h, i) => ({
    name: `c${i}`,
    display_name: h || ' ',
    data_type: 'lark_md',
    width: 'auto',
  }));
  const rows = bodyRows.map(r => {
    const o: Record<string, string> = {};
    for (let i = 0; i < headerCells.length; i++) o[`c${i}`] = r[i] ?? '';
    return o;
  });
  return {
    tag: 'table',
    page_size: Math.min(10, Math.max(1, rows.length || 1)),
    row_height: 'low',
    header_style: {
      text_align: 'left',
      text_size: 'normal',
      background_style: 'grey',
      text_color: 'default',
      bold: true,
      lines: 1,
    },
    columns,
    rows,
  };
}

function sliceLines(lines: string[], map: [number, number]): string {
  return lines.slice(map[0], map[1]).join('\n');
}

/** Find index of the matching close token at the same nesting depth. */
function findMatchingClose(tokens: Token[], openIdx: number): number {
  const open = tokens[openIdx];
  const close = open.type.replace(/_open$/, '_close');
  let depth = 1;
  for (let j = openIdx + 1; j < tokens.length; j++) {
    if (tokens[j].type === open.type) depth++;
    else if (tokens[j].type === close) {
      depth--;
      if (depth === 0) return j;
    }
  }
  return tokens.length - 1;
}

/**
 * Defensive unescape: when a line consists solely of 3+ backslash-escaped
 * backticks (with optional ≤3-space indent and an info string with no
 * backticks), strip the backslashes so markdown-it sees a real fence.
 *
 * This shields against a common LLM/shell bug: writing `botmux send "$(cat
 * <<'EOF' \`\`\` ... \`\`\` EOF)"` puts literal `\\\`` into the markdown
 * because the model over-escapes inside a single-quoted heredoc. markdown-it
 * then treats each `\\\`` as a CommonMark backslash-escape (literal backtick),
 * so no fence opens and the code block renders as flat text in the card.
 *
 * The regex is intentionally tight — only whole lines that are pure escaped
 * fences are touched. Inline `\\\`` and code-block bodies that mention
 * `\\\`\\\`\\\`` (e.g. a markdown tutorial) are unaffected.
 */
export function unescapeFenceLines(input: string): string {
  return input.replace(/^[ ]{0,3}(?:\\`){3,}[^\n`]*$/gm, m => m.replace(/\\`/g, '`'));
}

/** 保留超出组件额度的表头、单元格顺序和 Markdown 内容。 */
function tableRowsAsMarkdown(table: NonNullable<ReturnType<typeof buildTableFromTokens>>): string {
  if (table.rows.length === 0) {
    return table.columns.map(column => column.display_name.trim()).join(' · ');
  }
  return table.rows.map(row => {
    const cells = table.columns.map(({ name, display_name }) =>
      [display_name.trim(), row[name] || '—'].filter(Boolean).join(' '));
    return '- ' + cells.join(' · ');
  }).join('\n');
}

export function buildMarkdownElements(input: string, tableBudget: { remaining: number }): any[] {
  if (!input) return [];
  input = unescapeFenceLines(input);
  const tokens = md.parse(input, {});
  const lines = input.split('\n');
  const elements: any[] = [];
  const buf: string[] = [];

  const flushBuf = () => {
    const text = buf.join('\n\n').replace(/\n{3,}/g, '\n\n').trim();
    if (text) elements.push({ tag: 'markdown', content: text });
    buf.length = 0;
  };

  let i = 0;
  while (i < tokens.length) {
    const t = tokens[i];

    if (t.level !== 0) { i++; continue; }

    if (t.type === 'table_open') {
      flushBuf();
      const j = findMatchingClose(tokens, i);
      const tableEl = buildTableFromTokens(tokens.slice(i, j + 1));
      if (tableEl && tableBudget.remaining > 0) {
        elements.push(tableEl);
        tableBudget.remaining--;
      } else if (tableEl) {
        buf.push(tableRowsAsMarkdown(tableEl));
      } else if (t.map) {
        buf.push(sliceLines(lines, t.map as [number, number]));
      }
      i = j + 1;
      continue;
    }

    if (t.type === 'heading_open') {
      const inline = tokens[i + 1];
      const text = (inline?.content ?? '').trim();
      if (text) buf.push(`${'#'.repeat(Number(t.tag.slice(1)))} ${text}`);
      i += 3; // heading_open, inline, heading_close
      continue;
    }

    if (t.type === 'fence' || t.type === 'code_block') {
      const fence = t.markup || '```';
      const info = (t.info || '').trim();
      const content = t.content.replace(/\n+$/, '');
      buf.push(`${fence}${info}\n${content}\n${fence}`);
      i++;
      continue;
    }

    if (t.type === 'hr') {
      buf.push('---');
      i++;
      continue;
    }

    if (t.type === 'html_block') {
      if (t.map) buf.push(sliceLines(lines, t.map as [number, number]));
      i++;
      continue;
    }

    // Generic open token (paragraph_open, bullet_list_open, ordered_list_open,
    // blockquote_open, …): slice source by the open-token's line map and skip
    // to the matching close.
    if (t.type.endsWith('_open') && t.map) {
      buf.push(sliceLines(lines, t.map as [number, number]));
      i = findMatchingClose(tokens, i) + 1;
      continue;
    }

    i++;
  }

  flushBuf();
  return elements;
}
