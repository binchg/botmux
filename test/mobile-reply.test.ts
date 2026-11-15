import { expect, it } from 'vitest';
import { splitMobileReply, MOBILE_REPLY_MAX_CHARS } from '../src/services/mobile-reply.js';

it('preserves short updates and splits large Chinese paragraphs without losing text or emoji', () => {
  expect(splitMobileReply('一条完整进展。')).toEqual(['一条完整进展。']);
  const text = ('完整段落😀。'.repeat(120) + '\n\n').repeat(12);
  const parts = splitMobileReply(text);
  expect(parts.length).toBeGreaterThan(1);
  expect(parts.join('')).toBe(text);
  expect(parts.every(p => p.length <= MOBILE_REPLY_MAX_CHARS)).toBe(true);
  expect(parts.every(p => !/^[\uDC00-\uDFFF]|[\uD800-\uDBFF]$/.test(p))).toBe(true);
});

it('reopens long fenced code blocks on each mobile card', () => {
  const text = '```ts\n' + 'const x = "长代码";\n'.repeat(600) + '```';
  const parts = splitMobileReply(text);
  expect(parts.length).toBeGreaterThan(1);
  expect(parts.every(p => p.startsWith('```ts\n') && p.endsWith('```') && p.length <= MOBILE_REPLY_MAX_CHARS)).toBe(true);
  expect(parts.map((p, i) => p.replace(/^```ts\n/, '').replace(i === parts.length - 1 ? /```$/ : /\n```$/, '')).join('')).toBe(text.slice(6, -3));
});
