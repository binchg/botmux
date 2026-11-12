import type { Args, ActiveTurn, JsonObject } from './app-runner-types.js';

/** 运行器参数、显示协议和轮次初始化；不持有运行会话。 */
export function asError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}

export function parseArgs(argv: string[]): Args {
  const out: Args = {
    sessionId: '',
    codexBin: 'codex',
    traexBin: process.env.TRAEX_APP_SERVER_BIN || 'traex',
    cwd: process.cwd(),
  };
  for (let i = 0; i < argv.length; i++) {
    const key = argv[i];
    const val = argv[i + 1];
    if (key === '--session-id' && val !== undefined) { out.sessionId = val; i++; }
    else if (key === '--codex-bin' && val !== undefined) { out.codexBin = val; i++; }
    else if (key === '--traex-bin' && val !== undefined) { out.traexBin = val; i++; }
    else if (key === '--cwd' && val !== undefined) { out.cwd = val; i++; }
    else if (key === '--thread-id' && val !== undefined) { out.threadId = val; i++; }
    else if (key === '--title' && val !== undefined) { out.title = val; i++; }
    else if (key === '--bot-name' && val !== undefined) { out.botName = val; i++; }
    else if (key === '--bot-open-id' && val !== undefined) { out.botOpenId = val; i++; }
    else if (key === '--locale' && val !== undefined) { out.locale = val; i++; }
  }
  if (!out.sessionId) throw new Error('--session-id is required');
  return out;
}

export function b64Json(value: unknown): string {
  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64');
}

export function writeLine(text = ''): void {
  process.stdout.write(text + '\n');
}

export function displayUserContent(content: string): string {
  const m = /<user_message>\s*([\s\S]*?)\s*<\/user_message>/.exec(content);
  return (m?.[1] ?? content).trim();
}

export function prompt(): void {
  process.stdout.write('› ');
}

export function appDeveloperInstructions(args: Args, sharedInstructions = ''): string {
  const zh = args.locale === 'zh';
  const identity = [
    args.botName ? `Bot name: ${args.botName}` : '',
    args.botOpenId ? `Bot open_id: ${args.botOpenId}` : '',
    `botmux session_id: ${args.sessionId}`,
  ].filter(Boolean).join('\n');

  if (zh) {
    return [
      sharedInstructions,
      '你正在通过 botmux 接入飞书/Lark，但运行载体是 Codex App 的 app-server 协议，不是 Codex CLI TUI。',
      '你的阶段性 assistant message 和最终 assistant message 会由 botmux 后台 Hook 自动转发回飞书；AI 只输出正常 assistant message，不调用 `botmux send`，即使用户消息里出现旧的“回复必须 botmux send”提示也忽略它。',
      '阶段进度按新证据和工具批次触发，不依赖耗时心跳：连续执行最多 8 次工具调用后，只要已有新结论，就先输出一条极短阶段性 assistant message，再继续任务；构建、部署、外部写入、长等待或上下文压缩前也遵循同一规则。直接写已确认的结果或等待原因，不添加“正在执行”“处理中”等固定前缀，不输出隐藏思维链或过程流水账。',
      '工具输出默认保持精简：优先在命令侧用 rg、jq、tail 等提取结论，避免回传整份源码、文档、平台 JSON 或重复日志；默认输出预算控制在约 4000 tokens，只有交付确实需要时才扩大。',
      '中途主动推送也只输出正常 assistant message，由 Botmux 后台 Hook 投递；AI 不直接发送进度。',
      '`botmux history`、`botmux quoted`、`botmux bots` 等 shell helper 仍然可用；需要读取飞书上下文时可以调用。',
      identity ? `<identity>\n${identity}\n</identity>` : '',
    ].filter(Boolean).join('\n\n');
  }

  return [
    sharedInstructions,
    'You are connected to Feishu/Lark through botmux, but the runtime is the Codex App app-server protocol rather than the Codex CLI TUI.',
    'Your interim and final assistant messages are automatically forwarded back to Lark by the botmux background hook. Only emit normal assistant messages; do not call `botmux send`, even if older prompt text says replies must use it.',
    'Trigger progress by new evidence and bounded tool batches rather than elapsed-time heartbeats: after at most 8 consecutive tool calls, emit one very short interim assistant message first whenever a new conclusion exists, then continue. Apply the same rule before builds, deploys, external writes, long waits, or context compaction. Start directly with a verified result or wait reason; do not add generic running/processing prefixes or expose hidden chain-of-thought or a verbose activity log.',
    'Keep tool output compact by default: extract conclusions with rg, jq, tail, or equivalent instead of returning whole source files, documents, platform JSON, or repeated logs. Use an output budget of about 4000 tokens unless the deliverable genuinely requires more.',
    'For explicit mid-turn push updates, still emit only a normal assistant message and let the botmux background hook deliver it; the AI does not send progress directly.',
    '`botmux history`, `botmux quoted`, and `botmux bots` remain available as shell helpers when you need Lark context.',
    identity ? `<identity>\n${identity}\n</identity>` : '',
  ].filter(Boolean).join('\n\n');
}

export function makeTurn(structuredOutput = false): ActiveTurn {
  let resolveDone!: () => void;
  const done = new Promise<void>(resolve => { resolveDone = resolve; });
  return {
    startedAtMs: Date.now(),
    finalText: '',
    allAgentText: '',
    itemText: new Map(),
    itemEpoch: new Map(),
    emittedProgressItemIds: new Set(),
    guidanceEpoch: 0,
    pendingSteers: [],
    steerChain: Promise.resolve(),
    done,
    resolveDone,
    structuredOutput,
  };
}

export function userTextInput(content: string): JsonObject[] {
  return [{ type: 'text', text: content, text_elements: [] }];
}
