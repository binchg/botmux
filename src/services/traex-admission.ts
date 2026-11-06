import { setTimeout as delay } from 'node:timers/promises';
import { fetchTraexCatalog, rankTraexCandidates, type TraexCatalogModel } from './traex-model-catalog.js';
import { TraexAdaptiveRouter } from './traex-adaptive-model.js';

/** 每轮重新刷新；全部繁忙时在本地等待，取消后不再发出模型请求。 */
export class TraexAdmission {
  catalog: TraexCatalogModel[] = [];
  constructor(readonly router: TraexAdaptiveRouter, private readonly fetchCatalog = fetchTraexCatalog,
    private readonly refreshMs = 15000) {}

  async refresh(): Promise<void> { this.catalog = await this.fetchCatalog(); }

  choose(attempted = new Set<string>(), effort = 'xhigh'): string | undefined {
    return this.router.choose(rankTraexCandidates(this.catalog, this.router.policy.models, effort).map(candidate => candidate.model.model), attempted);
  }

  async select(attempted: Set<string>, signal: AbortSignal, notice: (message: string) => void,
    effort = 'xhigh'): Promise<string> {
    let waiting = false;
    while (true) {
      signal.throwIfAborted();
      let reason = 'TraeX 暂无可准入候选，暂停请求并自动刷新；会综合额度、实际排队、能力和负载。可随时取消。';
      try {
        await this.refresh();
        signal.throwIfAborted();
        const model = this.choose(attempted, effort);
        if (model) return model;
      } catch {
        signal.throwIfAborted();
        reason = 'TraeX 模型目录暂不可用，暂停请求并自动刷新；可随时取消。';
      }
      if (!waiting) notice(reason);
      waiting = true;
      await delay(this.refreshMs, undefined, { signal });
      // 已排队模型仍受共享冷却约束；新目录允许恢复后的高档模型重新候选。
      attempted.clear();
    }
  }
}
