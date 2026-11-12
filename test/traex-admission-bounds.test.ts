/** 验证实际排队后的降级不会因目录刷新或冷却到期无限循环。 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TraexAdmission } from '../src/services/traex-admission.js';
import { parseTraexQueueEvidence, TraexAdaptiveRouter } from '../src/services/traex-adaptive-model.js';
import type { TraexCatalogModel } from '../src/services/traex-model-catalog.js';

const roots: string[] = [];
/** 每项测试隔离共享冷却状态。 */
function router(models = ['top', 'low']): TraexAdaptiveRouter {
  const root = mkdtempSync(join(tmpdir(), 'traex-bounds-'));
  roots.push(root);
  return new TraexAdaptiveRouter({ models, cooldownMs: 1000 }, join(root, 'health.json'));
}
/** 构造只含准入元数据的模型目录项。 */
function model(name: string, loadPercent = 30): TraexCatalogModel {
  return { model: name, displayName: name, loadPercent, efforts: ['xhigh'], quota: { state: 'unknown' } };
}
afterEach(() => { roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true })); });

describe('TraeX 自动降级边界', () => {
  it('仅真实排队的明确标记说明额度低优先级，不把缺失信息当成额度耗尽', () => {
    const row = { id: 1, ts: 1, feedback_log_body: 'request_wait_in_queue {"position":774,"model_quota_low_priority":true}' };
    expect(parseTraexQueueEvidence(row)).toMatchObject({ position: 774, quotaLowPriority: true });
    expect(parseTraexQueueEvidence({ ...row, feedback_log_body: row.feedback_log_body.replace('true', 'false') })?.quotaLowPriority).toBeUndefined();
    expect(parseTraexQueueEvidence({ ...row, feedback_log_body: 'model_quota_low_priority:true' })).toBeUndefined();
  });
  it('刷新和共享冷却到期都不重新尝试本请求已排队的模型', async () => {
    const routing = router();
    await routing.queued('top', 1);
    const attempted = new Set(['top']);
    let refreshes = 0;
    const choose = vi.spyOn(routing, 'choose');
    choose.mockReturnValueOnce(undefined);
    const admission = new TraexAdmission(routing, async () => { refreshes++; return [model('top'), model('low')]; }, 5);
    expect(await admission.select(attempted, new AbortController().signal, () => {})).toBe('low');
    expect([...attempted]).toEqual(['top']);
    expect(refreshes).toBe(2);
  });

  it('可准入候选均已排队时，不为空闲未知或超载高档型号额外等待两分钟', async () => {
    const missing = { ...model('unknown'), loadPercent: undefined };
    const fetch = vi.fn(async () => [model('busy', 119), missing, model('top'), model('low')]);
    const notice = vi.fn();
    await expect(new TraexAdmission(router(['busy', 'unknown', 'top', 'low']), fetch)
      .select(new Set(['top', 'low']), new AbortController().signal, notice)).rejects.toMatchObject({ reason: 'exhausted' });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(notice).not.toHaveBeenCalled();
  });

  it('目录候选都已尝试时立即结束，不再等待冷却后重新发请求', async () => {
    const fetch = vi.fn(async () => [model('top'), model('low')]);
    const notice = vi.fn();
    await expect(new TraexAdmission(router(), fetch, 5).select(new Set(['top', 'low']), new AbortController().signal, notice))
      .rejects.toMatchObject({ reason: 'exhausted' });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(notice).not.toHaveBeenCalled();
  });

  it('即使还有第四个可用模型，也遵守三个模型的尝试上限', async () => {
    const fetch = vi.fn(async () => ['one', 'two', 'three', 'four'].map(name => model(name)));
    await expect(new TraexAdmission(router(['one', 'two', 'three', 'four']), fetch)
      .select(new Set(['one', 'two', 'three']), new AbortController().signal, () => {}))
      .rejects.toMatchObject({ reason: 'attempt_limit' });
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each(['busy', 'catalog-error'])('%s 只提示一次，并在等待截止时间结束', async mode => {
    const fetch = vi.fn(async () => {
      if (mode === 'catalog-error') throw new Error('offline');
      return [model('top', 100), model('low', 100)];
    });
    const notice = vi.fn();
    const attempted = new Set<string>();
    await expect(new TraexAdmission(router(), fetch, 5, 50)
      .select(attempted, new AbortController().signal, notice)).rejects.toMatchObject({ reason: 'wait_timeout' });
    expect(notice).toHaveBeenCalledTimes(1);
    expect(attempted.size).toBe(0);
  });
});
