/** 验证空统计延迟补齐、TraeX 来源选择与一分钟节流，禁止永久缓存占位符。 */
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sessionCardStatistics, sessionCardStatisticsNeedsRefresh } from '../src/services/session-card-statistics.js';
import { sessionModelStatus, writeSessionModelRuntime } from '../src/services/session-model-store.js';
import * as resolver from '../src/services/transcript-resolver.js';
import * as statistics from '../src/services/codex-session-statistics.js';
vi.mock('../src/services/session-store.js', () => ({ getSession: () => ({ larkAppId: 'selected', workingDir: '/workspace', createdAt: '2026-11-16T00:00:00Z' }) }));
beforeEach(() => vi.stubEnv('BOTMUX_BOT_INDEX', '2'));
afterEach(() => vi.unstubAllEnvs());
const dirs: string[] = [];
beforeEach(() => { vi.spyOn(resolver, 'resolveSessionTranscriptPath').mockReturnValue(null); });
afterEach(() => { vi.restoreAllMocks(); dirs.splice(0).forEach(d => rmSync(d, { recursive: true, force: true })); });
const setup = () => {
  const dir = mkdtempSync(join(tmpdir(), 'card-statistics-')); dirs.push(dir);
  writeFileSync(join(dir, 'session-card-customization.json'), '{"bots":{"selected":{"modelInCard":true}}}');
  writeSessionModelRuntime(dir, { sessionId: 's', pid: process.pid, phase: 'completed', threadId: 'native-traex',
    selection: { executor: 'traex', model: 'gpt-6.1-sol', effort: 'xhigh' } });
  return dir;
};
const sample = { runningMs: 90000, tools: 95, turns: 5, inputTokens: 8000000, outputTokens: 10000, cachedTokens: 7200000, incomplete: false };

it('首次无日志不阻塞卡片；十五秒后显示真实运行、消耗、缓存率和工具数', () => {
  const dir = setup(), state = sessionModelStatus(dir, 's');
  expect(sessionCardStatistics(dir, 's', state, 'zh', 'card', 0).join(' ')).toContain('运行—');
  vi.mocked(resolver.resolveSessionTranscriptPath).mockReturnValue({ path: '/native-rollout', kind: 'traex' });
  vi.spyOn(statistics, 'readCodexSessionStatistics').mockReturnValue(sample);
  expect(sessionCardStatisticsNeedsRefresh(dir, 's', 'zh', 'card', 14999)).toBe(false);
  expect(sessionCardStatisticsNeedsRefresh(dir, 's', 'zh', 'card', 15000)).toBe(true);
  const lines = sessionCardStatistics(dir, 's', state, 'zh', 'card', 15000).join(' ');
  expect(lines).toContain('运行1分');
  expect(lines).toContain('— 0.08亿 90.0% 95次');
  expect(resolver.resolveSessionTranscriptPath).toHaveBeenCalledWith(expect.objectContaining({ cliId: 'traex', cliSessionId: 'native-traex', fresh: true }));
});

it('真实统计最多每分钟更新，无新测量时不因创建时长变化而补卡', () => {
  const dir = setup(), state = sessionModelStatus(dir, 's');
  vi.mocked(resolver.resolveSessionTranscriptPath).mockReturnValue({ path: '/native-rollout', kind: 'traex' });
  const read = vi.spyOn(statistics, 'readCodexSessionStatistics').mockReturnValue(sample);
  sessionCardStatistics(dir, 's', state, 'zh', 'card', 0);
  expect(sessionCardStatisticsNeedsRefresh(dir, 's', 'zh', 'card', 60000)).toBe(false);
  read.mockReturnValue({ ...sample, contextTokens: 189_900, contextWindowTokens: 760_000 });
  expect(sessionCardStatisticsNeedsRefresh(dir, 's', 'zh', 'card', 119999)).toBe(false);
  expect(sessionCardStatisticsNeedsRefresh(dir, 's', 'zh', 'card', 120000)).toBe(true);
  expect(sessionCardStatistics(dir, 's', state, 'zh', 'card', 120000)[1]).toBe('189.9K/25% 0.08亿 90.0% 95次');
});
