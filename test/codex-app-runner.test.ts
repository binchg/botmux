import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('codex-app runner steering', () => {
  const source = readFileSync(join(process.cwd(), 'src/codex-app-runner.ts'), 'utf8');

  it('uses app-server turn/steer for busy follow-up guidance', () => {
    expect(source).toContain("client.request('turn/steer'");
    expect(source).toContain('expectedTurnId');
    expect(source).toContain('input: userTextInput(content)');
  });

  it('falls back to next-turn queueing when steering is unavailable', () => {
    expect(source).toContain('pendingSteers');
    expect(source).toContain('steer failed, queued as next turn');
    expect(source).toContain('queuePendingSteersAsNextTurns(turn)');
  });

  it('ticks progress independently from app-server delta arrival', () => {
    expect(source).toContain('const PROGRESS_TICK_MS = 250');
    expect(source).toContain('turn.progressTimer = setInterval');
    expect(source).toContain('clearInterval(turn.progressTimer)');
  });

  it('asks the model for concise evidence-based checkpoints without elapsed-time heartbeats', () => {
    expect(source).toContain('连续执行最多 8 次工具调用后');
    expect(source).toContain('直接写已确认的结果或等待原因');
    expect(source).toContain('不添加“正在执行”“处理中”等固定前缀');
    expect(source).toContain('不输出隐藏思维链');
    expect(source).toContain('默认输出预算控制在约 4000 tokens');
  });

  it('starts a new progress epoch when busy follow-up guidance arrives', () => {
    expect(source).toContain('activeTurn.progress.resetTo()');
  });

  it('reopens progress when guidance races with a completed final answer item', () => {
    const handler = source.slice(
      source.indexOf('function handleUserMessage'),
      source.indexOf('function handleServerRequest'),
    );
    expect(handler).toContain('activeTurn.guidanceEpoch += 1');
    expect(handler).toContain("activeTurn.finalText = ''");
    expect(handler).toContain("activeTurn.allAgentText = ''");
    expect(handler.indexOf("activeTurn.finalText = ''"))
      .toBeLessThan(handler.indexOf('activeTurn.pendingSteers.push(content)'));
  });

  it('ignores an old agent item that completes after newer guidance', () => {
    expect(source).toContain('itemEpoch: Map<string, number>');
    expect(source).toContain('activeTurn.itemEpoch.set(String(item.id), activeTurn.guidanceEpoch)');
    expect(source).toContain('if (itemEpoch !== activeTurn.guidanceEpoch) return');
    expect(source).toContain('activeTurn.finalItemId = itemId');
  });

  it('keeps structured item and hook lifecycles internal', () => {
    expect(source).toContain("msg.method === 'hook/started' || msg.method === 'hook/completed'");
    expect(source).not.toContain("emitMarker('activity'");
    expect(source).toContain('normalizeCodexAppTimestampMs');
  });

  it('makes a resumed terminal explicit instead of looking like an empty failed session', () => {
    expect(source).toContain('Codex App 已恢复原会话；终端仅显示恢复后的新输出。');
    expect(source).toContain('Codex App resumed the existing conversation');
  });

  it('uses the local Botmux title through app-server without adding a naming prompt', () => {
    expect(source).toContain("else if (key === '--title'");
    expect(source).toContain("client.request('thread/name/set'");
    expect(source).toContain('name: args.title?.trim()');
    expect(source).toContain('name: args.title.trim()');
    expect(source).toContain('恢复旧 Botmux 会话时同步迁移');
    expect(source).not.toContain('请生成会话标题');
  });

  it('checks hook trust before each turn and fails critical hooks visibly', () => {
    expect(source).toContain("client.request('hooks/list'");
    expect(source).toContain('codexAppHookTrustIssue(response, args.cwd)');
    expect(source).toContain("client.request('turn/interrupt'");
    expect(source).toContain('activeTurn.criticalHookFailure');
  });

  it('accepts the structured same-bot team interrupt control line', () => {
    expect(source).toContain("decoded?.type === 'interrupt'");
    expect(source).toContain('void interruptActiveTurn()');
    expect(source).toContain("client.request('turn/interrupt', { threadId, turnId: turn.turnId })");
    expect(source).toContain("emitMarker('interrupt_ack', { acknowledged: true");
  });

  it('enables a narrow output schema only for Agent Team turns', () => {
    expect(source).toContain("import { agentTeamOutputSchema }");
    expect(source).toContain('...(outputSchema ? { outputSchema } : {})');
  });

  it('collects Team structured deltas without writing them to terminal or progress markers', () => {
    expect(source).toContain('structuredOutput: boolean');
    expect(source).toContain('const turn = makeTurn(!!outputSchema)');
    expect(source).toContain('if (turn.structuredOutput) return');
    expect(source).toContain('if (!activeTurn.structuredOutput) process.stdout.write(delta)');
  });

  it('automatically continues bounded HTTP 429 retry-limit failures', () => {
    expect(source).toContain('isCodexAppRetryLimit429(errorMessage)');
    expect(source).toContain('CODEX_APP_RATE_LIMIT_MAX_CONTINUES');
    expect(source).toContain('codexAppAutoContinueDelayMs(autoContinueCount)');
    expect(source).toContain('codexAppAutoContinuePrompt(args.locale)');
    expect(source).toContain("writeLine(autoContinue ? '[auto continue]' : '[user]')");
  });

  it('overrides resumed legacy threads with the current default provider', () => {
    expect(source).toContain("client.request('config/read', { cwd: args.cwd })");
    expect(source).toContain('defaultThreadModel =');
    expect(source).toContain('defaultThreadModelProvider =');
    expect(source).toContain('model: defaultThreadModel');
    expect(source).toContain('modelProvider: defaultThreadModelProvider');
    expect(source).toContain('await loadDefaultThreadModel()');
  });
});
