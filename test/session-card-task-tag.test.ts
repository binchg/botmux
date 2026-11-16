/** 任务方向来自首轮主题，并通过磁盘冻结，追问与目录变化不得重命名。 */
import { afterEach, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { inferSessionTaskTag, stableSessionTaskTag } from '../src/services/session-card-task-tag.js';
const dirs: string[] = [];
afterEach(() => dirs.splice(0).forEach(dir => rmSync(dir, { recursive: true, force: true })));

it('提炼业务方向，专门的 adkmp、kmp-cli 不被通用平台词覆盖', () => {
  expect(inferSessionTaskTag('更新 botmux、TraeX 适配')).toBe('botmux');
  expect(inferSessionTaskTag('鸿蒙 adKmpBrick 升级')).toBe('adkmp');
  expect(inferSessionTaskTag('修复 kmp-cli 的 Android 构建')).toBe('kmp-cli');
  expect(inferSessionTaskTag('鸿蒙编译失败')).toBe('鸿蒙');
  expect(inferSessionTaskTag('继续', '/workspace/4/xs_fm_android feature_ad_kmp')).toBe('adkmp');
  expect(inferSessionTaskTag('帮我看看', '/workspace/xs_fm_ai_coding')).toBe('AICoding');
});

it('同一会话跨重读与目录变化保持原标签，不保存提示正文', () => {
  const dir = mkdtempSync(join(tmpdir(), 'task-tags-')); dirs.push(dir);
  expect(stableSessionTaskTag(dir, 'session-one', '更新 botmux private-original-body')).toBe('botmux');
  expect(stableSessionTaskTag(dir, 'session-one', '现在看看鸿蒙', '/repo/xs_fm_harmony')).toBe('botmux');
  expect(stableSessionTaskTag(dir, 'session-two', '鸿蒙编译')).toBe('鸿蒙');
  const files = readdirSync(join(dir, 'session-card-task-tags')).filter(n => n.endsWith('.json'));
  expect(files).toHaveLength(2);
  expect(files.map(n => readFileSync(join(dir, 'session-card-task-tags', n), 'utf8')).join('')).not.toContain('private-original-body');
});
