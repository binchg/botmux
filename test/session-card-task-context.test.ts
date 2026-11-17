/** 验证卡片标题稳定、精简占用信息、重试幂等和设备释放后的低频刷新。 */
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const f = vi.hoisted(() => ({ session: {} as any, binding: {} as any }));
vi.mock('../src/services/session-store.js', () => ({ getSession: () => f.session }));
vi.mock('../src/services/session-card-bindings.js', async importOriginal => ({
  ...await importOriginal<typeof import('../src/services/session-card-bindings.js')>(), readSessionCardBindings: () => f.binding,
}));
import { customizeSessionCard } from '../src/services/session-card-customization.js';
import { sessionCardTaskTag, sessionCardTaskLocation, sessionCardTaskContextNeedsRefresh } from '../src/services/session-card-task-context.js';
import { sessionModelStatus } from '../src/services/session-model-store.js';
const dirs: string[] = [];
beforeEach(() => {
  f.session = { sessionId: 's', larkAppId: 'selected', title: '拉取最新 botmux 代码', workingDir: '/workspace/xs_fm_ai_coding' };
  f.binding = { worktrees: ['WT5'], devices: ['mac1'], project: '/workspace/5/xs_fm_android' };
});
afterEach(() => dirs.splice(0).forEach(dir => rmSync(dir, { recursive: true, force: true })));
const setup = () => { const dir = mkdtempSync(join(tmpdir(), 'task-card-')); dirs.push(dir);
  writeFileSync(join(dir, 'session-card-customization.json'), '{"bots":{"selected":{"taskContext":true}}}'); return dir; };

it('追问换成鸿蒙仍保留 #botmux，标题短且重试不会丢失运行状态', () => {
  const dir = setup();
  const card = JSON.stringify({ header: { title: { tag: 'plain_text', content: 'Codex App · 最新长追问 — 工作中' } },
    elements: [{ tag: 'div', text: { content: '📁 WT5 · mac1 · 模型' } },
      { tag: 'action', actions: [{ tag: 'button', value: { session_id: 's', action: 'close' } },
        { tag: 'button', multi_url: { url: 'https://terminal/s/s' } }, { tag: 'button', multi_url: { url: 'https://history/h/token' } }] }] });
  const prefs = { compactButtons: true, taskContext: true };
  const first = customizeSessionCard(card, prefs, dir);
  expect(JSON.parse(first).header.title.content).toBe('#botmux · 工作中');
  f.session.title = '现在处理鸿蒙';
  expect(sessionCardTaskTag(dir, 's')).toBe('botmux');
  expect(customizeSessionCard(first, prefs, dir)).toBe(first);
});

it('占用变化至少间隔三十秒，设备释放后移除短号，任务标签不变', () => {
  const dir = setup(), state = sessionModelStatus(dir, 's');
  expect(sessionCardTaskLocation(dir, 's', state, 'card', 0)).toBe('WT5 · mac1');
  f.binding = { worktrees: ['WT6'], devices: [], project: '/workspace/6/xs_fm_harmony' };
  expect(sessionCardTaskContextNeedsRefresh(dir, 's', 'card', 29999)).toBe(false);
  expect(sessionCardTaskLocation(dir, 's', state, 'card', 29999)).toBe('WT5 · mac1');
  expect(sessionCardTaskContextNeedsRefresh(dir, 's', 'card', 30000)).toBe(true);
  expect(sessionCardTaskLocation(dir, 's', state, 'card', 30000)).toBe('WT6');
  expect(sessionCardTaskTag(dir, 's')).toBe('botmux');
  expect(sessionCardTaskContextNeedsRefresh(dir, 's', 'card', 60000)).toBe(false);
});

it('无占用时只显示工程简称，不编造 worktree 或设备；非目标机器人沿用原卡', () => {
  const dir = setup(); f.binding = { worktrees: [], devices: [], project: '/workspace/xs_fm_ai_coding' };
  expect(sessionCardTaskLocation(dir, 's', sessionModelStatus(dir, 's'))).toBe('AICoding');
  f.session.larkAppId = 'other';
  expect(sessionCardTaskLocation(dir, 's', sessionModelStatus(dir, 's'))).toBeUndefined();
});
