import { config } from '../config.js';
import type { Args, TurnOutcome } from './app-runner-types.js';
import { writeLine } from './app-runner-protocol.js';
import { beginSessionModelReplyEpoch } from './session-model-reply-budget.js';
import { CODEX_APP_RATE_LIMIT_MAX_CONTINUES, codexAppAutoContinueDelayMs, codexAppAutoContinuePrompt } from './codex-app-auto-continue.js';

/** 一个用户请求的有限续跑；已尝试模型集合跨所有续轮保留。 */
export interface RunContext {
  args: Args;
  emitMarker: (kind: string, payload: unknown) => void;
  runSingleTurn: (content: string, autoContinue: boolean, attempted: Set<string>, forcedModel?: string) => Promise<TurnOutcome>;
}

export async function runTurn(content: string, context: RunContext): Promise<void> {
  const { args, emitMarker, runSingleTurn } = context;
  beginSessionModelReplyEpoch(config.session.dataDir, args.sessionId);
  let nextContent = content;
  let autoContinueCount = 0;
  const attempted = new Set<string>();
  let forcedModel: string | undefined;

  while (true) {
    const outcome = await runSingleTurn(nextContent, autoContinueCount > 0 || !!forcedModel, attempted, forcedModel);
    if (outcome.adaptiveNextModel) {
      forcedModel = outcome.adaptiveNextModel;
      nextContent = '上一轮因服务端排队或额度准入限制已中断，模型已自动重选。请沿当前线程继续完成用户最新请求；保留所有追问、已完成操作和工具结果，不要重放已完成的操作。';
      continue;
    }
    if (!outcome.rateLimitError) return;

    if (autoContinueCount >= CODEX_APP_RATE_LIMIT_MAX_CONTINUES) {
      const message = args.locale === 'zh'
        ? `Codex App 429 自动继续已达上限（${CODEX_APP_RATE_LIMIT_MAX_CONTINUES} 次）：${outcome.rateLimitError}`
        : `Codex App 429 auto-continue reached its limit (${CODEX_APP_RATE_LIMIT_MAX_CONTINUES} attempts): ${outcome.rateLimitError}`;
      writeLine(`[codex-app] ${message}`);
      const completedAtMs = Date.now();
      emitMarker('final', {
        turnId: outcome.turnId ?? `codex-app-rate-limit-${completedAtMs}`,
        content: message,
        startedAtMs: outcome.startedAtMs,
        completedAtMs,
      });
      return;
    }

    autoContinueCount += 1;
    const delayMs = codexAppAutoContinueDelayMs(autoContinueCount);
    const delaySeconds = Math.ceil(delayMs / 1_000);
    const notice = args.locale === 'zh'
      ? `上游返回 429，${delaySeconds} 秒后自动继续（${autoContinueCount}/${CODEX_APP_RATE_LIMIT_MAX_CONTINUES}）。`
      : `Upstream returned 429; auto-continuing in ${delaySeconds}s (${autoContinueCount}/${CODEX_APP_RATE_LIMIT_MAX_CONTINUES}).`;
    writeLine(`[codex-app] ${notice}`);
    emitMarker('progress', {
      content: notice,
      turnId: outcome.turnId,
      startedAtMs: outcome.startedAtMs,
      updatedAtMs: Date.now(),
    });
    await new Promise(resolve => setTimeout(resolve, delayMs));
    nextContent = codexAppAutoContinuePrompt(args.locale);
  }
}
