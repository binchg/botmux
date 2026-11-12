import { config } from '../config.js';
import type { AppServerClient } from './app-runner-client.js';
import type { ActiveTurn, JsonObject } from './app-runner-types.js';
import { writeLine } from './app-runner-protocol.js';
import { writeSessionModelRuntime } from './session-model-store.js';
import { normalizeCodexAppTimestampMs } from './codex-app-activity.js';
import { codexAppHookFailure } from './codex-app-hook-health.js';
import { isTraexDailyQuotaExhausted } from './traex-adaptive-model.js';
import { isCodexAppRetryLimit429 } from './codex-app-auto-continue.js';

/** 每次事件使用当下会话快照，过滤旧线程和已被追问取代的输出。 */
export interface NotificationContext {
  activeTurn: ActiveTurn | null;
  threadId?: string;
  activeExecutor: 'traex' | 'codex-app';
  client: AppServerClient;
  flushSteers: (turn: ActiveTurn) => void;
  emitMarker: (kind: string, payload: unknown) => void;
  emitCompletedAssistantMessage: (turn: ActiveTurn, itemId: string, content: string) => void;
}

export function handleAppServerRequest(msg: JsonObject, client: AppServerClient): boolean {
  const method = msg.method;
  if (method === 'item/commandExecution/requestApproval') {
    client.respond(msg.id, { decision: 'acceptForSession' });
    return true;
  }
  if (method === 'item/fileChange/requestApproval') {
    client.respond(msg.id, { decision: 'acceptForSession' });
    return true;
  }
  if (method === 'item/permissions/requestApproval') {
    client.respond(msg.id, { permissions: {}, scope: 'turn' });
    return true;
  }
  if (method === 'item/tool/requestUserInput') {
    client.respond(msg.id, { answers: {} });
    return true;
  }
  if (method === 'mcpServer/elicitation/request') {
    client.respond(msg.id, { action: 'cancel', content: null, _meta: null });
    return true;
  }
  if (method === 'item/tool/call') {
    client.respond(msg.id, { contentItems: [], success: false });
    return true;
  }
  if (method === 'execCommandApproval' || method === 'applyPatchApproval') {
    client.respond(msg.id, { decision: 'approved_for_session' });
    return true;
  }
  return false;
}

export function handleAppNotification(msg: JsonObject, context: NotificationContext): void {
  const { activeTurn, threadId, activeExecutor, client, flushSteers, emitMarker, emitCompletedAssistantMessage } = context;
  const params = msg.params ?? {};
  if (!activeTurn || params.threadId !== threadId) return;
  if (activeTurn.turnId && params.turnId && params.turnId !== activeTurn.turnId) return;

  if (msg.method === 'turn/started') {
    activeTurn.turnId = params.turn?.id ?? params.turnId ?? activeTurn.turnId;
    flushSteers(activeTurn);
    return;
  }

  if (msg.method.includes('/delta') || (['item/started', 'item/completed'].includes(msg.method) && params.item?.type !== 'userMessage')) {
    activeTurn.adaptiveActivityAt = Date.now();
    const runtime = activeTurn.modelRuntime;
    if (runtime?.selection?.executor === 'traex' && ['requested', 'queued'].includes(runtime.routing?.state ?? '')) {
      activeTurn.modelRuntime = { ...runtime, phase: 'running',
        routing: { ...runtime.routing!, state: undefined, position: undefined } };
      writeSessionModelRuntime(config.session.dataDir, activeTurn.modelRuntime);
    }
  }
  if (msg.method === 'item/started' && /commandExecution|fileChange|ToolCall/.test(params.item?.type ?? '')) {
    (activeTurn.toolItems ??= new Set()).add(String(params.item.id));
  }
  if (msg.method === 'item/completed') activeTurn.toolItems?.delete(String(params.item?.id));

  if (msg.method === 'hook/started' || msg.method === 'hook/completed') {
    activeTurn.adaptiveCheck?.();
    const phase = msg.method === 'hook/started' ? 'started' : 'completed';
    const run = params.run;
    if (phase === 'completed') {
      const atMs = normalizeCodexAppTimestampMs(run?.completedAt);
      const failure = codexAppHookFailure(run);
      if (failure) {
        writeLine(`\n[codex-app] ${failure.message}`);
        emitMarker('progress', {
          content: failure.message,
          turnId: activeTurn.turnId,
          startedAtMs: activeTurn.startedAtMs,
          updatedAtMs: atMs,
        });
        if (failure.critical) {
          activeTurn.criticalHookFailure = failure.message;
          const failedTurnId = activeTurn.turnId ?? params.turnId;
          if (threadId && failedTurnId) {
            void client.request('turn/interrupt', { threadId, turnId: failedTurnId }).catch(() => {});
          }
        }
      }
    }
    return;
  }

  if (msg.method === 'item/started') {
    const item = params.item;
    if (item?.type === 'agentMessage' && item.id) {
      // item 在 steer 前后可能交错完成；记录创建时的 epoch，迟到旧 item 不得污染新回复。
      activeTurn.itemEpoch.set(String(item.id), activeTurn.guidanceEpoch);
    } else if (item?.type === 'commandExecution') {
      writeLine(`\n$ ${item.command}`);
    } else if (item?.type === 'fileChange') {
      writeLine('\n[files changed]');
    }
    return;
  }

  if (msg.method === 'item/agentMessage/delta') {
    const delta = String(params.delta ?? '');
    const itemId = String(params.itemId ?? '');
    const itemEpoch = activeTurn.itemEpoch.get(itemId) ?? activeTurn.guidanceEpoch;
    if (!activeTurn.itemEpoch.has(itemId)) activeTurn.itemEpoch.set(itemId, itemEpoch);
    activeTurn.itemText.set(itemId, (activeTurn.itemText.get(itemId) ?? '') + delta);
    if (!activeTurn.structuredOutput) process.stdout.write(delta);
    if (itemEpoch !== activeTurn.guidanceEpoch) return;
    if (activeTurn.finalText && activeTurn.finalItemId !== itemId) {
      activeTurn.finalText = '';
      activeTurn.finalItemId = undefined;
    }
    activeTurn.allAgentText += delta;
    return;
  }

  if (msg.method === 'item/commandExecution/outputDelta' || msg.method === 'item/fileChange/outputDelta') {
    process.stdout.write(String(params.delta ?? ''));
    return;
  }

  if (msg.method === 'item/completed') {
    const item = params.item;
    if (item?.type === 'agentMessage') {
      const itemId = String(item.id ?? '');
      const itemEpoch = activeTurn.itemEpoch.get(itemId) ?? activeTurn.guidanceEpoch;
      if (itemEpoch !== activeTurn.guidanceEpoch) return;
      const completedText = String(item.text ?? activeTurn.itemText.get(itemId) ?? '');
      if (item.phase === 'final_answer') {
        activeTurn.finalText = String(item.text ?? '');
        activeTurn.finalItemId = itemId;
      } else {
        if (!activeTurn.itemText.has(item.id) && item.text) {
          activeTurn.allAgentText += String(item.text);
        }
        emitCompletedAssistantMessage(activeTurn, itemId, completedText);
      }
    }
    return;
  }

  if (msg.method === 'turn/completed') {
    const turn = params.turn;
    if (turn?.id && activeTurn.turnId && turn.id !== activeTurn.turnId) return;
    activeTurn.finished = true;
    // 正常完成可能先于排队中断返回；完成、关键 Hook 失败和用户停止都禁止自动续跑。
    if (turn?.status !== 'interrupted' || activeTurn.criticalHookFailure || activeTurn.userInterrupted) {
      activeTurn.adaptiveNextModel = undefined;
    }
    const errorMessage = String(turn?.error?.message ?? '').trim();
    activeTurn.turnFailed = !!errorMessage || turn?.status === 'failed' || turn?.status === 'interrupted';
    if (activeTurn.criticalHookFailure) {
      activeTurn.finalText = activeTurn.criticalHookFailure;
    } else if (activeExecutor === 'traex' && isTraexDailyQuotaExhausted(errorMessage)) {
      activeTurn.quotaExhaustedError = errorMessage;
    } else if (isCodexAppRetryLimit429(errorMessage)) {
      activeTurn.rateLimitError = errorMessage;
    } else if (errorMessage && !activeTurn.finalText) {
      activeTurn.finalText = `Codex App turn failed: ${errorMessage}`;
    }
    activeTurn.resolveDone();
  }
}
