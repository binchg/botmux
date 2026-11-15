/** Public execution summaries only. Never export reasoning or full shell/tool arguments. */
export function publicCodexToolEvent(row: any): string | undefined {
  if (row?.type !== 'response_item') return;
  const p = row.payload ?? {};
  if (p.type === 'function_call' || p.type === 'custom_tool_call') {
    const name = String(p.name ?? 'tool').replace(/[^\w.:-]/g, '').slice(0, 80);
    return `⚙️ ${name} · 开始执行`;
  }
  if (p.type === 'function_call_output' || p.type === 'custom_tool_call_output') return '✓ 工具执行已返回';
}

export interface CodexSyncEvent { id: string; kind: 'user' | 'progress' | 'tool' | 'final' | 'status'; text: string; at?: string }
export function publicCodexEvent(row: any, id: string): CodexSyncEvent | undefined {
  const tool = publicCodexToolEvent(row);
  if (tool) return { id, kind: 'tool', text: tool, at: row.timestamp };
  if (row?.type !== 'event_msg') return;
  const p = row.payload ?? {};
  if (p.type === 'user_message' && typeof p.message === 'string') {
    // Botmux wrappers are transport metadata, not the user's question.
    const match = /<user_message>\s*([\s\S]*?)\s*<\/user_message>/.exec(p.message);
    return { id, kind: 'user', text: match?.[1] ?? p.message, at: row.timestamp };
  }
  if (p.type === 'agent_message' && p.phase === 'commentary') return { id, kind: 'progress', text: String(p.message ?? ''), at: row.timestamp };
  if (p.type === 'task_complete' && p.last_agent_message) return { id, kind: 'final', text: String(p.last_agent_message), at: row.timestamp };
  if (p.type === 'task_started') return { id, kind: 'status', text: '执行中', at: row.timestamp };
  if (p.type === 'task_complete' || p.type === 'turn_aborted') return { id, kind: 'status', text: p.type === 'turn_aborted' ? '已中断' : '本轮完成', at: row.timestamp };
}
