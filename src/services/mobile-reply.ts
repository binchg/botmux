/** Bound mobile card rendering cost. Short public updates remain intact. */
export const MOBILE_REPLY_MAX_CHARS = 3000;

export function splitMobileReply(text: string): string[] {
  if (text.length <= MOBILE_REPLY_MAX_CHARS) return [text];
  const parts: string[] = [];
  let rest = text;
  let fence: { marker: string; opening: string } | undefined;
  while (rest.length) {
    const prefix = fence ? `${fence.opening}\n` : '';
    // Reserve room for a closing code fence, including unusually long markers.
    const budget = MOBILE_REPLY_MAX_CHARS - prefix.length - 34;
    let cut = Math.min(rest.length, budget);
    if (cut < rest.length) {
      const paragraph = rest.lastIndexOf('\n\n', cut - 1);
      const line = rest.lastIndexOf('\n', cut - 1);
      if (paragraph >= budget / 2) cut = paragraph + 2;
      else if (line >= budget / 2) cut = line + 1;
      // Never cut a UTF-16 surrogate pair in half.
      if (/[\uD800-\uDBFF]/.test(rest[cut - 1])) cut--;
    }
    const body = rest.slice(0, cut);
    for (const line of body.split('\n')) {
      const match = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
      if (!match || match[1].length > 32 || line.length > 100) continue;
      if (!fence) fence = { marker: match[1], opening: line };
      else if (match[1][0] === fence.marker[0] && match[1].length >= fence.marker.length && !match[2].trim()) fence = undefined;
    }
    rest = rest.slice(cut);
    const suffix = fence ? `\n${fence.marker}` : '';
    parts.push(prefix + body + suffix);
  }
  return parts;
}
