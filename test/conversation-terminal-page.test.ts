import { expect, it } from 'vitest';
import { nativeTerminalText, renderNativeTerminalPage } from '../src/services/conversation-terminal-page.js';

it('shows a distinct, live read-only console with escaped native output', () => {
  const messages = [
    { id: 'u', kind: 'user' as const, content: '继续', at: Date.now() },
    { id: 'a', kind: 'assistant_final' as const, content: '<script>结果</script>', at: Date.now() },
  ];
  const text = nativeTerminalText(messages);
  expect(text).toContain('$ 用户');
  expect(text).toContain('> Codex');
  const page = renderNativeTerminalPage(messages);
  expect(page.html).toContain('Codex Web 终端');
  expect(page.html).toContain('只读 · 自动更新');
  expect(page.html).not.toContain('<script>结果</script>');
  expect(page.html).toContain('&lt;script&gt;结果&lt;/script&gt;');
});
