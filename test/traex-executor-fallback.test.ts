import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { TraexAdmissionStopped } from '../src/services/traex-admission.js';
import { runWithTraexFallback, type TraexFallbackOptions } from '../src/services/traex-executor-fallback.js';
import { readSessionModel, writeSessionModel } from '../src/services/session-model-store.js';

/** 验证准入失败才接续一次，以及用户选择和取消优先于自动切换。 */
const roots: string[] = [];
afterEach(() => roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true })));
function options(): TraexFallbackOptions {
  const root = mkdtempSync(join(tmpdir(), 'traex-fallback-')); roots.push(root);
  return { dataDir: root, sessionId: 'session', cwd: root, codexBin: 'unused', executor: () => 'traex',
    signal: new AbortController().signal, notice: vi.fn(),
    run: vi.fn().mockRejectedValueOnce(new TraexAdmissionStopped('exhausted')).mockResolvedValue(undefined),
    env: { TRAEX_ADAPTIVE_FALLBACK_EXECUTOR: 'codex-app', TRAEX_ADAPTIVE_FALLBACK_MODEL: 'target' },
    models: vi.fn(async () => [{ model: 'target', defaultReasoningEffort: 'low',
      supportedReasoningEfforts: [{ reasoningEffort: 'xhigh' }] }]) };
}

it('默认关闭；未授权切换时保留原错误和配置', async () => {
  const o = options(); o.env = {};
  await expect(runWithTraexFallback(o)).rejects.toBeInstanceOf(TraexAdmissionStopped);
  expect(o.models).not.toHaveBeenCalled(); expect(o.run).toHaveBeenCalledTimes(1);
  expect(readSessionModel(o.dataDir, o.sessionId)).toBeUndefined();
});

it('已启用时校验模型后只接续一次，并持久保存目标选择', async () => {
  const o = options();
  await runWithTraexFallback(o);
  expect(o.run).toHaveBeenCalledTimes(2); expect(o.notice).toHaveBeenCalledTimes(1);
  expect(readSessionModel(o.dataDir, o.sessionId)).toMatchObject({ executor: 'codex-app', model: 'target', effort: 'xhigh', serviceTier: 'default' });
});

it.each([new Error('hook failed'), new DOMException('cancelled', 'AbortError')])('普通失败和取消不触发接续', async error => {
  const o = options(); o.run = vi.fn().mockRejectedValue(error);
  await expect(runWithTraexFallback(o)).rejects.toBe(error);
  expect(o.models).not.toHaveBeenCalled(); expect(o.run).toHaveBeenCalledTimes(1);
});

it('目标失败直接结束，不重试或切回 TraeX', async () => {
  const o = options(); o.run = vi.fn().mockRejectedValue(new TraexAdmissionStopped('exhausted'));
  await expect(runWithTraexFallback(o)).rejects.toBeInstanceOf(TraexAdmissionStopped);
  expect(o.run).toHaveBeenCalledTimes(2); expect(o.models).toHaveBeenCalledTimes(1);
});

it.each(['cancel', 'selection'])('目录探测期间的 %s 使接续失效', async kind => {
  const o = options(), controller = new AbortController(); o.signal = controller.signal;
  const originalModels = o.models!;
  o.models = async args => {
    if (kind === 'cancel') controller.abort();
    else writeSessionModel(o.dataDir, o.sessionId, { executor: 'traex', model: 'chosen', effort: 'high' });
    return originalModels(args);
  };
  await expect(runWithTraexFallback(o)).rejects.toThrow();
  expect(o.run).toHaveBeenCalledTimes(1); expect(o.notice).not.toHaveBeenCalled();
  expect(readSessionModel(o.dataDir, o.sessionId)?.executor).not.toBe('codex-app');
});

it('不支持的模型不能写入期望配置', async () => {
  const o = options(); o.env!.TRAEX_ADAPTIVE_FALLBACK_MODEL = 'missing';
  await expect(runWithTraexFallback(o)).rejects.toThrow('unsupported_model');
  expect(o.run).toHaveBeenCalledTimes(1);
  expect(readSessionModel(o.dataDir, o.sessionId)).toBeUndefined();
});
