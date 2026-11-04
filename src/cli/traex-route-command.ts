import { fetchTraexCatalog, eligibleTraexModels } from '../services/traex-model-catalog.js';
import { readTraexAdaptivePolicy } from '../services/traex-adaptive-model.js';

/** 无会话依赖的只读快照；候选不代表已获服务端准入。 */
export async function runTraexRouteCommand(args: string[]): Promise<number> {
  if (args.some(x => !['--json'].includes(x))) throw new Error('Usage: botmux model route [--json]');
  const policy = readTraexAdaptivePolicy(process.env, true);
  const catalog = await fetchTraexCatalog();
  const eligible = eligibleTraexModels(catalog);
  const ranked = (policy?.models ?? []).map(model => {
    const metadata = catalog.find(m => m.model === model);
    return { model, loadPercent: metadata?.loadPercent ?? null, queueSize: metadata?.queueSize ?? null,
      eligible: eligible.includes(model), available: !!metadata };
  });
  console.log(JSON.stringify({ ok: true, executor: 'traex', enabled: !!policy, checkedAt: new Date().toISOString(),
    effort: 'xhigh', loadThresholdExclusive: 100, selected: ranked.find(m => m.eligible)?.model ?? null,
    exhausted: 'wait_refresh', queueAdmissionVerified: false, models: ranked }, null, 2));
  return 0;
}
