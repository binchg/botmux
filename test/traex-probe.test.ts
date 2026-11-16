/** 回归现场：目录中所有 GPT 超载时仍应探测，不能零请求等待到超时。 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { TraexAdaptiveRouter } from '../src/services/traex-adaptive-model.js';
import { TraexAdmission } from '../src/services/traex-admission.js';
import { rankTraexCandidates, type TraexCatalogModel } from '../src/services/traex-model-catalog.js';

const roots: string[] = [];
afterEach(() => roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true })));
/** 使用脱敏后的线上负载快照，保留排序所需事实。 */
function snapshot(): TraexCatalogModel[] {
  return [['astra', 371], ['sol', 125], ['old-sol', 117], ['terra', 151], ['luna', 132]]
    .map(([model, loadPercent]) => ({ model: String(model), displayName: String(model), loadPercent: Number(loadPercent),
      efforts: ['xhigh'], quota: { state: 'unknown' } }));
}
it('全部超载时按成本有限探测，真实排队后不再尝试本轮模型', async () => {
  const root = mkdtempSync(join(tmpdir(), 'traex-probe-')); roots.push(root);
  const models = snapshot(), policy = models.map(m => m.model);
  const router = new TraexAdaptiveRouter({ models: policy, cooldownMs: 120000 }, join(root, 'health.json'));
  const admission = new TraexAdmission(router, async () => models);
  const signal = new AbortController().signal, attempted = new Set<string>();
  const first = await admission.select(attempted, signal, () => {});
  expect(first).toBe('old-sol');
  attempted.add(first); await router.queued(first);
  const second = await admission.select(attempted, signal, () => {});
  expect(second).toBe('sol');
  attempted.add(second); await router.queued(second);
  const third = await admission.select(attempted, signal, () => {});
  expect(third).toBe('luna');
  attempted.add(third);
  await expect(admission.select(attempted, signal, () => {})).rejects.toMatchObject({ reason: 'attempt_limit' });
});
it('空闲候选始终先于超载或未知负载；不探测明确耗尽或不支持的型号', () => {
  const models = snapshot();
  models.push({ ...models[0], model: 'idle', loadPercent: 99 }, { ...models[0], model: 'unknown', loadPercent: undefined },
    { ...models[0], model: 'exhausted', loadPercent: 1, quota: { state: 'exhausted' } },
    { ...models[0], model: 'wrong-effort', efforts: ['high'] });
  const ranked = rankTraexCandidates(models, models.map(m => m.model), 'xhigh', true);
  expect(ranked[0]).toMatchObject({ model: { model: 'idle' }, probe: false });
  expect(ranked.some(r => r.model.model === 'unknown' && r.probe)).toBe(true);
  expect(ranked.some(r => ['exhausted', 'wrong-effort'].includes(r.model.model))).toBe(false);
});
