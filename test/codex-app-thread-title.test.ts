/** Codex App 本地标题摘要与每日序号的回归测试。 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  allocateCodexAppThreadTitle,
  formatCodexAppThreadTitle,
  summarizeCodexAppThreadTitle,
} from '../src/services/codex-app-thread-title.js';

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function makeDataDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'botmux-codex-title-'));
  tempDirs.push(dir);
  return dir;
}

describe('Codex App 本地会话标题', () => {
  it('从首条用户消息提取短句并去掉提及与包装标签', () => {
    expect(summarizeCodexAppThreadTitle(
      '<sender type="user">陈金彬</sender><user_message>@雪球 修改 botmux 会话标题，目前默认不方便</user_message>',
    )).toBe('修改 botmux 会话标题');
  });

  it('按月日和两位序号组合标题', () => {
    expect(formatCodexAppThreadTitle('修改 botmux', 1, new Date(2026, 7, 3, 9)))
      .toBe('080301 修改 botmux');
  });

  it('同一天递增序号，跨天从 01 重新开始', () => {
    const dataDir = makeDataDir();
    expect(allocateCodexAppThreadTitle('修改 botmux', dataDir, new Date(2026, 7, 3, 9)))
      .toBe('080301 修改 botmux');
    expect(allocateCodexAppThreadTitle('修复 Hook', dataDir, new Date(2026, 7, 3, 10)))
      .toBe('080302 修复 Hook');
    expect(allocateCodexAppThreadTitle('继续任务', dataDir, new Date(2026, 7, 4, 9)))
      .toBe('080401 继续任务');
  });
});
