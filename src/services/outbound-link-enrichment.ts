/**
 * Last-mile enrichment for assistant Markdown before it is rendered into a
 * Lark card. Keep this pure and conservative: only explicit BITS references
 * are linkified, while existing links, URLs and code stay byte-for-byte intact.
 * The complete reference is the link label so Feishu shows meaningful blue
 * text such as `BITS 8386078`, rather than a lone linked number.
 */

export const BITS_MR_DETAIL_BASE_URL = 'https://bits.bytedance.net/bytebus/devops/code/detail';

const BITS_REFERENCE_RE = /\bBITS\b[ \t]*(?:(?:MR|合并请求)[ \t]*)?(?:(?:已创建并已回读|已创建并回读|创建并回读|已创建|已回读|回读)[ \t]*)?(?:(?:URL|链接)[ \t]*)?[：:#-]?[ \t]*(?<id>[1-9]\d{5,9})(?!\d)/giu;

type Range = { start: number; end: number };

function closingDelimiter(input: string, start: number, open: string, close: string): number {
  let depth = 0;
  for (let i = start; i < input.length; i++) {
    if (input[i] === '\\') {
      i++;
      continue;
    }
    if (input[i] === open) depth++;
    else if (input[i] === close) {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/** Locate Markdown constructs whose contents must never be rewritten. */
function protectedRanges(line: string): Range[] {
  const ranges: Range[] = [];
  let i = 0;
  while (i < line.length) {
    if (line[i] === '`') {
      let runLength = 1;
      while (line[i + runLength] === '`') runLength++;
      const marker = '`'.repeat(runLength);
      const close = line.indexOf(marker, i + runLength);
      if (close >= 0) {
        ranges.push({ start: i, end: close + runLength });
        i = close + runLength;
        continue;
      }
    }

    const linkStart = line[i] === '[' ? i : (line[i] === '!' && line[i + 1] === '[' ? i + 1 : -1);
    if (linkStart >= 0) {
      const labelClose = closingDelimiter(line, linkStart, '[', ']');
      if (labelClose >= 0) {
        const targetOpen = labelClose + 1;
        const referenceOpen = line[targetOpen];
        if (referenceOpen === '(' || referenceOpen === '[') {
          const targetClose = closingDelimiter(
            line,
            targetOpen,
            referenceOpen,
            referenceOpen === '(' ? ')' : ']',
          );
          if (targetClose >= 0) {
            const start = linkStart > 0 && line[linkStart - 1] === '!' ? linkStart - 1 : linkStart;
            ranges.push({ start, end: targetClose + 1 });
            i = targetClose + 1;
            continue;
          }
        }
      }
    }

    if (line.startsWith('https://', i) || line.startsWith('http://', i)) {
      let end = i;
      while (end < line.length && !/[\s<>]/u.test(line[end])) end++;
      ranges.push({ start: i, end });
      i = end;
      continue;
    }

    i++;
  }
  return ranges;
}

function linkifyLine(line: string): string {
  const protectedSpans = protectedRanges(line);
  let cursor = 0;
  let output = '';
  for (const match of line.matchAll(BITS_REFERENCE_RE)) {
    const id = match.groups?.id;
    if (!id || match.index == null) continue;
    const referenceStart = match.index;
    const referenceEnd = referenceStart + match[0].length;
    if (protectedSpans.some(span => referenceStart < span.end && referenceEnd > span.start)) continue;

    output += line.slice(cursor, referenceStart);
    output += `[${match[0]}](${BITS_MR_DETAIL_BASE_URL}/${id})`;
    cursor = referenceEnd;
  }
  return cursor === 0 ? line : output + line.slice(cursor);
}

/**
 * Turn explicit plain-text BITS MR references into clickable Markdown links.
 *
 * Example:
 * `BITS 已创建并回读：8377427` becomes
 * `[BITS 已创建并回读：8377427](https://bits.bytedance.net/...)`.
 */
export function enrichOutboundMarkdownLinks(input: string): string {
  if (!input || !/\bBITS\b/iu.test(input)) return input;

  let fence: { char: '`' | '~'; length: number } | undefined;
  return input.split('\n').map((line) => {
    const marker = line.match(/^[ ]{0,3}(`{3,}|~{3,})/u)?.[1];
    if (marker) {
      const char = marker[0] as '`' | '~';
      if (!fence) fence = { char, length: marker.length };
      else if (char === fence.char && marker.length >= fence.length
        && line.slice(line.indexOf(marker) + marker.length).trim() === '') fence = undefined;
      return line;
    }
    if (fence || /^(?: {4}|\t)/u.test(line)) return line;
    return linkifyLine(line);
  }).join('\n');
}
