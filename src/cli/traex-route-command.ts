import { fetchTraexCatalog, isTraexCatalogCandidate, rankTraexCandidates } from '../services/traex-model-catalog.js';
import { readTraexAdaptivePolicy } from '../services/traex-adaptive-model.js';

/** 无会话依赖的只读快照；候选不代表已获服务端准入。 */
export async function runTraexRouteCommand(args: string[]): Promise<number> {
  if (args.some(x => !['--json'].includes(x))) throw new Error('Usage: botmux model route [--json]');
  const policy = readTraexAdaptivePolicy(process.env, true);
  const catalog = await fetchTraexCatalog();
  const rankedCandidates = rankTraexCandidates(catalog, policy?.models ?? []);
  const rankByModel = new Map(rankedCandidates.map((candidate, index) => [candidate.model.model, { rank: index + 1, score: candidate.score }]));
  const ranked = (policy?.models ?? []).map(model => {
    const metadata = catalog.find(m => m.model === model);
    return { model, loadPercent: metadata?.loadPercent ?? null, queueSize: metadata?.queueSize ?? null,
      quota: metadata?.quota ?? { state: 'unknown' }, providerPriority: metadata?.providerPriority ?? null,
      eligible: !!metadata && isTraexCatalogCandidate(metadata), available: !!metadata, ...(rankByModel.get(model) ?? {}) };
  });
  console.log(JSON.stringify({ ok: true, executor: 'traex', enabled: !!policy, checkedAt: new Date().toISOString(),
    effort: 'xhigh', strategy: 'quota_then_actual_queue_then_capability_and_load',
    quotaResetHour: policy?.quotaResetHour ?? 6, selected: rankedCandidates[0]?.model.model ?? null,
    exhausted: 'wait_refresh', queueAdmissionVerified: false, models: ranked }, null, 2));
  return 0;
}
