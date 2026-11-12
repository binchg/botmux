import { normalizeModelAlias, parseSessionModelIntent } from './session-model-intent.js';
import { validateModelSelection, type AvailableSessionModel } from './session-model-selection.js';
import { readSessionModel, readSessionModelRuntime, writeSessionModel, type ModelSelection } from './session-model-store.js';

/** 在普通消息入队前完成选模，保持连续输入顺序，避免业务请求先用旧模型执行。 */
export interface ModelInputOptions {
  dataDir: string;
  sessionId: string;
  defaults: () => ModelSelection;
  models: (executor: 'codex-app' | 'traex') => Promise<AvailableSessionModel[]>;
  deliver: (content: string, changed: boolean) => void;
  notice: (content: string, failed?: boolean) => void;
}

/** 本会话自然语言模型指令入口；无匹配消息保持原样透传。 */
export class SessionModelInput {
  private chain: Promise<void> = Promise.resolve();
  private generation = 0;
  constructor(private readonly options: ModelInputOptions) {}

  /** 取消使尚在能力探测中的指令失效，不在取消后重新发起任务。 */
  cancel(): void { this.generation++; }

  /** 串行解析，消息处理失败只影响该条，不丢弃后续正常消息。 */
  receive(content: string): void {
    const generation = this.generation;
    this.chain = this.chain.then(async () => {
      if (generation !== this.generation) return;
      const intent = parseSessionModelIntent(content);
      if (!intent) { this.options.deliver(content, false); return; }
      const { dataDir, sessionId } = this.options;
      const before = readSessionModel(dataDir, sessionId);
      const previous = before ?? readSessionModelRuntime(dataDir, sessionId)?.selection ?? this.options.defaults();
      const executor = previous.executor ?? this.options.defaults().executor ?? 'codex-app';
      const models = await this.options.models(executor);
      if (generation !== this.generation) return;
      if (readSessionModel(dataDir, sessionId)?.revision !== before?.revision) throw new Error('配置已并发更新，请重新发送本条指令。');
      const wanted = intent.model ? normalizeModelAlias(intent.model) : normalizeModelAlias(previous.model);
      const selected = models.find(model => [model.configName, model.model, model.id].some(name => name
        && normalizeModelAlias(name) === normalizeModelAlias(wanted)));
      if (!selected) throw new Error(`当前执行器不支持模型 ${intent.model ?? previous.model}`);
      const effort = intent.effort ?? (selected.supportedReasoningEfforts.some(level => level.reasoningEffort === previous.effort)
        ? previous.effort : selected.defaultReasoningEffort);
      const selection = validateModelSelection({ ...intent, model: selected.configName ?? selected.model,
        routingMode: intent.routingMode ?? previous.routingMode ?? (executor === 'traex' ? 'adaptive' : 'fixed'), executor, effort }, models, previous);
      const request = writeSessionModel(dataDir, sessionId, selection);
      const runtime = readSessionModelRuntime(dataDir, sessionId);
      const changed = runtime?.revision !== request.revision;
      this.options.notice(`已接收本会话设置：${selection.model} · ${selection.effort} · ${selection.serviceTier === 'priority' ? 'fast' : '标准速度（非 fast）'}；自动应用并接续，无需再次发送“继续”。`);
      this.options.deliver(content, changed);
    }).catch(error => { if (generation === this.generation) this.options.notice(`模型设置未应用：${error.message}`, true); });
  }
}
