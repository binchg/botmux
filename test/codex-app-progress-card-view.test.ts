import { describe, expect, it } from 'vitest';
import { CodexAppProgressCardView } from '../src/services/codex-app-progress-card-view.js';

describe('Codex App progress card view', () => {
  it('keeps assistant progress when a later heartbeat arrives', () => {
    const view = new CodexAppProgressCardView();
    view.update('assistant', '正在核对 D worktree 的来源分支。');
    view.update('assistant', '已确认 fetch、merge、push 的执行边界。');

    const rendered = view.update(
      'heartbeat',
      '正在执行：运行 Codex Hook｜进展：已确认 fetch、merge、push 的执行边界｜本轮约 3 分钟。',
    );

    expect(rendered).toContain('正在核对 D worktree 的来源分支。');
    expect(rendered).toContain('已确认 fetch、merge、push 的执行边界。');
    expect(rendered).toContain('正在执行：运行 Codex Hook｜本轮约 3 分钟。');
    expect(rendered).not.toContain('｜进展：已确认 fetch');
  });

  it('keeps only the newest bounded assistant history and deduplicates repeats', () => {
    const view = new CodexAppProgressCardView({ maxAssistantEntries: 2 });
    view.update('assistant', 'first');
    view.update('assistant', 'second');
    view.update('assistant', 'second');
    const rendered = view.update('assistant', 'third');

    expect(rendered).not.toContain('- first');
    expect(rendered.match(/- second/g)).toHaveLength(1);
    expect(rendered).toContain('- third');
  });

  it('clears progress at a real Lark user-turn boundary', () => {
    const view = new CodexAppProgressCardView();
    view.update('assistant', 'old turn');
    view.reset();

    expect(view.update('heartbeat', '正在执行：分析问题｜本轮约 1 秒。')).not.toContain('old turn');
  });
});
