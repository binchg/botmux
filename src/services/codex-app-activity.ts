export type CodexAppActivityPhase = 'started' | 'completed';

export interface CodexAppActivityUpdate {
  phase: CodexAppActivityPhase;
  id: string;
  label: string;
  detail?: string;
  atMs: number;
  durationMs?: number;
  status?: string;
}

type JsonObject = Record<string, any>;

const MAX_DETAIL_CHARS = 96;

/** app-server currently mixes Unix seconds (`startedAt` / `completedAt`) and
 * JavaScript epoch milliseconds (`startedAtMs`). Normalize both before any
 * elapsed-time calculation so a seconds value cannot become tens of millions
 * of minutes. Microsecond timestamps are accepted defensively as well. */
export function normalizeCodexAppTimestampMs(value: unknown, fallbackMs = Date.now()): number {
  const raw = Number(value);
  if (!Number.isFinite(raw) || raw <= 0) return fallbackMs;
  if (raw < 100_000_000_000) return Math.round(raw * 1_000);
  if (raw > 100_000_000_000_000) return Math.round(raw / 1_000);
  return Math.round(raw);
}

function cleanDetail(value: unknown): string | undefined {
  const text = String(value ?? '')
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\b(?:sk|rk|pk|api|access|refresh|session)[_-]?(?:key|token)?[-_][A-Za-z0-9._-]{8,}\b/gi, '[已脱敏]')
    .replace(/(authorization|token|password|secret)\s*[:=]\s*\S+/gi, '$1=[已脱敏]')
    .replace(/\s+/g, ' ')
    .trim();
  if (!text) return undefined;
  return text.length <= MAX_DETAIL_CHARS ? text : `${text.slice(0, MAX_DETAIL_CHARS - 1)}…`;
}

function basename(path: unknown): string | undefined {
  const normalized = String(path ?? '').replace(/\\/g, '/').replace(/\/+$/, '');
  return cleanDetail(normalized.split('/').pop() || normalized);
}

function commandActivity(item: JsonObject): Pick<CodexAppActivityUpdate, 'label' | 'detail'> {
  const actions = Array.isArray(item.commandActions) ? item.commandActions : [];
  const first = actions[0] as JsonObject | undefined;
  const suffix = actions.length > 1 ? ` 等 ${actions.length} 项` : '';
  if (first?.type === 'read') {
    return { label: '读取文件', detail: cleanDetail(`${basename(first.path) ?? first.name ?? ''}${suffix}`) };
  }
  if (first?.type === 'listFiles') {
    return { label: '扫描文件', detail: cleanDetail(`${basename(first.path) ?? '当前目录'}${suffix}`) };
  }
  if (first?.type === 'search') {
    const query = cleanDetail(first.query);
    const path = basename(first.path);
    return { label: '搜索代码', detail: cleanDetail([query, path].filter(Boolean).join(' · ') + suffix) };
  }

  // Do not forward the full shell command: it may contain credentials or
  // private prompt data. The app-server parser's command name is enough to
  // explain what is running without leaking arguments.
  const commandName = cleanDetail(first?.command)?.split(/\s+/)[0]
    ?? cleanDetail(item.command)?.split(/\s+/)[0];
  return { label: '执行命令', detail: commandName };
}

function fileChangeDetail(item: JsonObject): string | undefined {
  const changes = Array.isArray(item.changes) ? item.changes : [];
  if (changes.length === 0) return undefined;
  const first = basename(changes[0]?.path);
  return cleanDetail(changes.length === 1 ? first : `${first ?? '文件'} 等 ${changes.length} 个文件`);
}

function collabLabel(tool: unknown): string {
  switch (tool) {
    case 'spawnAgent': return '启动子 Agent';
    case 'sendInput': return '向子 Agent 补充任务';
    case 'resumeAgent': return '恢复子 Agent';
    case 'wait': return '等待子 Agent';
    case 'closeAgent': return '关闭子 Agent';
    default: return '调度子 Agent';
  }
}

function dynamicToolDescription(item: JsonObject): Pick<CodexAppActivityUpdate, 'label' | 'detail'> {
  const rawInput = (() => {
    const value = item.input ?? item.arguments ?? item.params;
    if (typeof value === 'string') return value;
    try { return value == null ? '' : JSON.stringify(value); } catch { return ''; }
  })();
  const toolName = cleanDetail([item.namespace, item.tool].filter(Boolean).join(' / '));
  const lastNestedTool = rawInput.lastIndexOf('tools.');
  const classifiableInput = lastNestedTool >= 0 ? rawInput.slice(lastNestedTool) : rawInput;

  // Classify only into fixed, non-sensitive stages. Never forward the raw
  // dynamic-tool input: code-mode wrappers can contain prompts or credentials.
  if (/\bgit\s+push\b/i.test(classifiableInput)) return { label: '推送代码', detail: undefined };
  if (/\bbits\b[\s\S]{0,120}\bmr\b|\bmr\b[\s\S]{0,120}\bbits\b/i.test(classifiableInput)) {
    return { label: '处理 BITS MR', detail: undefined };
  }
  if (/remote\s+start|remote[xX][\s/]|gradlew|assemble|generateSoHar/i.test(classifiableInput)) {
    return { label: '运行构建', detail: undefined };
  }
  if (/\bmeego\b/i.test(classifiableInput)) return { label: '同步 Meego', detail: undefined };
  if (/write_stdin|tools\.wait\b|\bwait\s*\(/i.test(classifiableInput)) {
    return { label: '等待工具结果', detail: undefined };
  }
  if (/apply_patch|fileChange|write_file|edit_file/i.test(classifiableInput)) {
    return { label: '修改代码', detail: undefined };
  }
  if (/exec_command|\brg\b|\bgit\s+(?:diff|status|log|show)\b|\bsed\b|bytebuild|\blog\b/i.test(classifiableInput)) {
    return { label: '检查代码与日志', detail: undefined };
  }
  return { label: '调用工具', detail: toolName };
}

function itemDescription(item: JsonObject): Pick<CodexAppActivityUpdate, 'label' | 'detail'> | null {
  switch (item?.type) {
    case 'commandExecution': return commandActivity(item);
    case 'fileChange': return { label: '修改文件', detail: fileChangeDetail(item) };
    case 'mcpToolCall': return { label: '调用 MCP 工具', detail: cleanDetail(`${item.server ?? ''} / ${item.tool ?? ''}`) };
    case 'dynamicToolCall': return dynamicToolDescription(item);
    case 'collabAgentToolCall': return { label: collabLabel(item.tool), detail: undefined };
    case 'subAgentActivity': return { label: '子 Agent 执行', detail: cleanDetail(item.agentPath) };
    case 'webSearch': return { label: '搜索外部资料', detail: cleanDetail(item.query) };
    case 'imageView': return { label: '查看图片', detail: basename(item.path) };
    case 'imageGeneration': return { label: '生成图片', detail: undefined };
    case 'sleep': return { label: '等待定时阶段', detail: `${Math.max(1, Math.round(Number(item.durationMs ?? 0) / 1_000))} 秒` };
    case 'contextCompaction': return { label: '压缩会话上下文', detail: undefined };
    case 'enteredReviewMode': return { label: '进入代码审查', detail: undefined };
    case 'exitedReviewMode': return { label: '结束代码审查', detail: undefined };
    case 'plan': return { label: '更新执行计划', detail: undefined };
    case 'reasoning': return { label: '分析问题', detail: undefined };
    default: return null;
  }
}

export function codexAppItemActivity(
  item: JsonObject,
  phase: CodexAppActivityPhase,
  atMs: number,
): CodexAppActivityUpdate | null {
  const description = itemDescription(item);
  if (!description || typeof item?.id !== 'string') return null;
  return {
    phase,
    id: `item:${item.id}`,
    ...description,
    atMs,
    durationMs: typeof item.durationMs === 'number' ? item.durationMs : undefined,
    status: typeof item.status === 'string' ? item.status : undefined,
  };
}

const HOOK_LABELS: Record<string, string> = {
  preToolUse: '工具调用前检查',
  permissionRequest: '权限检查',
  postToolUse: '工具完成后检查',
  preCompact: '上下文压缩前检查',
  postCompact: '上下文压缩后检查',
  sessionStart: '会话启动检查',
  userPromptSubmit: '用户输入检查',
  subagentStart: '子 Agent 启动检查',
  subagentStop: '子 Agent 收口检查',
  stop: '任务结束检查',
};

export function codexAppHookActivity(
  run: JsonObject,
  phase: CodexAppActivityPhase,
  atMs: number,
): CodexAppActivityUpdate | null {
  if (typeof run?.id !== 'string') return null;
  const event = HOOK_LABELS[String(run.eventName ?? '')] ?? cleanDetail(run.eventName) ?? 'Hook 检查';
  const statusMessage = cleanDetail(run.statusMessage);
  const source = cleanDetail(run.source);
  return {
    phase,
    id: `hook:${run.id}`,
    label: '运行 Codex Hook',
    detail: cleanDetail([event, statusMessage, source].filter(Boolean).join(' · ')),
    atMs,
    durationMs: run.durationMs == null ? undefined : Number(run.durationMs),
    status: typeof run.status === 'string' ? run.status : undefined,
  };
}
