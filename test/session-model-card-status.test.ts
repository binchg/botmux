/** 验证实际模型补齐、三十秒节流、仅负载变化不刷新及机器人隔离。 */
import { afterEach, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sessionModelCardStatus, sessionModelCardNeedsRefresh } from '../src/services/session-model-card-status.js';
import { sessionModelStatus, writeSessionModelRuntime } from '../src/services/session-model-store.js';
import { sessionModelCardElements } from '../src/im/lark/session-model-card.js';
import { config } from '../src/config.js';

vi.mock('../src/services/session-store.js', () => ({ getSession: () => ({ larkAppId: 'selected', workingDir: '/workspace' }) }));
const dirs: string[] = [], original = config.session.dataDir;
afterEach(() => { config.session.dataDir = original; dirs.splice(0).forEach(d => rmSync(d, { recursive: true, force: true })); });
const setup = () => {
  const d = mkdtempSync(join(tmpdir(), 'model-card-status-')); dirs.push(d);
  writeFileSync(join(d, 'session-card-customization.json'), JSON.stringify({ bots: { selected: { modelInCard: true } } }));
  config.session.dataDir = d; return d;
};
const runtime = (dir: string, model = 'gpt-6.1-sol', load = 109) => writeSessionModelRuntime(dir, {
  sessionId: 's', pid: process.pid, phase: 'running', selection: { executor: 'traex', model, effort: 'xhigh' },
  routing: { executor: 'traex', effort: 'xhigh', loadPercent: load },
});

it('首卡不等待回执，稍后补齐到文件夹行；同卡负载波动不触发刷新', () => {
  const d = setup();
  sessionModelCardStatus(d, 's', sessionModelStatus(d, 's'), 'card', 0);
  runtime(d);
  expect(sessionModelCardNeedsRefresh(d, 's', 'card', 10_000)).toBe(false);
  expect(sessionModelCardStatus(d, 's', sessionModelStatus(d, 's'), 'card', 10_000)).toBe('待回执');
  expect(sessionModelCardNeedsRefresh(d, 's', 'card', 15_000)).toBe(true);
  expect(sessionModelCardStatus(d, 's', sessionModelStatus(d, 's'), 'card', 15_000)).toContain('负载 109%');
  runtime(d, 'gpt-6.1-sol', 111);
  expect(sessionModelCardNeedsRefresh(d, 's', 'card', 90_000)).toBe(false);
  expect(sessionModelCardStatus(d, 's', sessionModelStatus(d, 's'), 'card', 90_000)).toContain('负载 109%');
  expect(JSON.stringify(sessionModelCardElements('s', 'codex-app', 'zh', 'new-card'))).toContain('TraeX · GPT-6.1-Sol · xhigh · 负载 111%');
});

it('模型切换至少间隔三十秒，未定制的机器人不触发刷新', () => {
  const d = setup(); runtime(d);
  sessionModelCardStatus(d, 's', sessionModelStatus(d, 's'), 'card', 0);
  runtime(d, 'gpt-6-astra');
  expect(sessionModelCardNeedsRefresh(d, 's', 'card', 29_999)).toBe(false);
  expect(sessionModelCardNeedsRefresh(d, 's', 'card', 30_000)).toBe(true);
  expect(sessionModelCardStatus(d, 's', sessionModelStatus(d, 's'), 'card', 30_000)).toContain('GPT-6-Astra');
  writeFileSync(join(d, 'session-card-customization.json'), '{"bots":{}}');
  expect(sessionModelCardNeedsRefresh(d, 's', 'card', 90_000)).toBe(false);
});
