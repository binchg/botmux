import type { AppServerClient } from './app-runner-client.js';
import { displayUserContent, userTextInput, writeLine } from './app-runner-protocol.js';
import type { ActiveTurn } from './app-runner-types.js';
import { beginSessionModelReplyEpoch } from './session-model-reply-budget.js';

interface SteeringContext {
  dataDir: string;
  sessionId: string;
  activeTurn: ActiveTurn | null;
  activeExecutor: string;
  threadId?: string;
  client: AppServerClient;
  enqueueNextTurn: (content: string) => void;
  sharedContextPrefix: () => string;
  emitMarker: (kind: string, payload: unknown) => void;
}

/** 进行中的追问使用 turn/steer，未送达的追问回到待执行队列。 */
export function createAppRunnerSteering(context: SteeringContext) {
  const { enqueueNextTurn, sharedContextPrefix, emitMarker } = context;
  function queuePendingSteersAsNextTurns(turn: ActiveTurn): void {
    const pending = turn.pendingSteers.splice(0);
    for (const content of pending) enqueueNextTurn(content);
  }

  function flushSteers(turn: ActiveTurn): void {
    turn.steerChain = turn.steerChain.then(async () => {
      if (context.activeTurn !== turn) {
        queuePendingSteersAsNextTurns(turn);
        return;
      }
      if (!context.threadId || !turn.turnId) return;

      while (turn.pendingSteers.length > 0) {
        if (context.activeTurn !== turn) {
          queuePendingSteersAsNextTurns(turn);
          return;
        }
        const expectedTurnId = turn.turnId;
        if (!context.threadId || !expectedTurnId) return;

        const content = turn.pendingSteers.shift()!;
        try {
          const result = await context.client.request('turn/steer', {
            threadId: context.threadId,
            input: userTextInput(sharedContextPrefix() + content),
            expectedTurnId,
          });
          if (result?.turnId) turn.turnId = String(result.turnId);
          writeLine();
          writeLine('[user guidance]');
          writeLine(content);
          emitMarker('user', {
            kind: 'guidance',
            content: displayUserContent(content),
            at: Date.now(),
            turnId: turn.turnId ?? expectedTurnId,
          });
          if (context.activeExecutor === 'traex' && !turn.structuredOutput) emitMarker('progress', {
            content: '已接收追问，沿当前线程继续；如实际排队会自动重选模型。',
            turnId: turn.turnId, startedAtMs: turn.startedAtMs, updatedAtMs: Date.now(), complete: true,
          });
          writeLine();
        } catch (err: any) {
          writeLine(`[codex-app] steer failed, queued as next turn: ${err?.message ?? err}`);
          enqueueNextTurn(content);
          queuePendingSteersAsNextTurns(turn);
          return;
        }
      }
    }).catch((err: any) => {
      writeLine(`[codex-app] steer flush failed: ${err?.message ?? err}`);
      queuePendingSteersAsNextTurns(turn);
    });
  }

  function handleUserMessage(content: string): void {
    const turn = context.activeTurn;
    if (!turn || turn.modelSwitchPending) {
      enqueueNextTurn(content);
      return;
    }
    // 用户可能在 final_answer 已生成、turn/completed 尚未到达时继续追问。
    // 清除上一答案的终态闩锁，确保新阶段消息继续进入飞书进度卡，最终回包也采用新答案。
    beginSessionModelReplyEpoch(context.dataDir, context.sessionId);
    turn.adaptiveCheck?.();
    turn.guidanceEpoch += 1;
    turn.finalText = '';
    turn.finalItemId = undefined;
    turn.allAgentText = '';
    turn.pendingSteers.push(content);
    flushSteers(turn);
  }

  return { queuePendingSteersAsNextTurns, flushSteers, handleUserMessage };
}
