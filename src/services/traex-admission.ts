import { setTimeout as delay } from 'node:timers/promises';
import { fetchTraexCatalog, rankTraexCandidates, type TraexCatalogModel } from './traex-model-catalog.js';
import { TraexAdaptiveRouter } from './traex-adaptive-model.js';

/** 达到准入边界时结束当前自动重试，交由用户决定下一次请求。 */
export class TraexAdmissionStopped extends Error {
  constructor(readonly reason: 'exhausted' | 'attempt_limit' | 'wait_timeout') {
    const detail = reason === 'exhausted' ? '本轮候选均已尝试，仍未获准入'
      : reason === 'attempt_limit' ? '本轮已达到模型尝试次数上限' : '等待空闲模型已超时';
    super(`TraeX ${detail}，已停止自动重试。会话历史保留，请稍后继续或选择其它执行器。`);
    this.name = 'TraexAdmissionStopped';
  }
}

/** 每个请求最多尝试三个不同模型；每次准入等待最多两分钟，取消立即结束等待。 */
export class TraexAdmission {
  catalog: TraexCatalogModel[] = [];
  constructor(readonly router: TraexAdaptiveRouter, private readonly fetchCatalog = fetchTraexCatalog,
    private readonly refreshMs = 15000, private readonly maxWaitMs = 120000,
    private readonly maxAttempts = 3) {}

  async refresh(): Promise<void> { this.catalog = await this.fetchCatalog(); }

  choose(attempted = new Set<string>(), effort = 'xhigh'): string | undefined {
    return this.router.choose(rankTraexCandidates(this.catalog, this.router.policy.models, effort).map(candidate => candidate.model.model), attempted);
  }

  async select(attempted: Set<string>, signal: AbortSignal, notice: (message: string) => void,
    effort = 'xhigh'): Promise<string> {
    let waiting = false;
    const deadline = Date.now() + this.maxWaitMs;
    while (true) {
      signal.throwIfAborted();
      if (attempted.size >= this.maxAttempts) throw new TraexAdmissionStopped('attempt_limit');
      let reason = 'TraeX 暂无可准入候选，暂停请求并限时刷新，超时后停止自动重试。可随时取消。';
      try {
        await this.refresh();
        signal.throwIfAborted();
        if (Date.now() >= deadline) throw new TraexAdmissionStopped('wait_timeout');
        const model = this.choose(attempted, effort);
        if (model) return model;
        const candidates = this.catalog.filter(model => this.router.policy.models.includes(model.model)
          && model.efforts.includes(effort));
        if (candidates.length && candidates.every(model => attempted.has(model.model))) {
          throw new TraexAdmissionStopped('exhausted');
        }
      } catch (error) {
        signal.throwIfAborted();
        if (error instanceof TraexAdmissionStopped) throw error;
        reason = 'TraeX 模型目录暂不可用，暂停请求并限时刷新，超时后停止自动重试。可随时取消。';
      }
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw new TraexAdmissionStopped('wait_timeout');
      if (!waiting) notice(reason);
      waiting = true;
      await delay(Math.min(this.refreshMs, remaining), undefined, { signal });
      // attempted 属于整个用户请求；刷新和共享冷却到期都不能重置它。
    }
  }
}
