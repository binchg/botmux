import { createHash } from 'node:crypto';
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
export function publicCodexUserText(text: string): string | undefined {
  // Codex stores selected-response annotations as a user-role prompt. The
  // English preamble and JSON are internal context; only the user's request
  // belongs in the mirrored question and answer-card title.
  if (/^\s*# Response annotations:\s*/.test(text)) {
    const request = /\n#{1,3}\s*My request:\s*([\s\S]*)$/i.exec(text)?.[1]?.trim();
    return request || undefined;
  }
  // These are host-injected context records stored with role=user, not a
  // human question. In particular, selected Pages must never be mirrored.
  if (/^\s*(?:# AGENTS\.md instructions|<(?:environment_context|permissions instructions|collaboration_mode|external_codex_apps_[\w]+|user_instructions|system_reminder|recommended_plugins|skills_instructions)(?:\s|>))/.test(text)) return;
  const match = /<user_message>\s*([\s\S]*?)\s*<\/user_message>/.exec(text);
  if (!match && /^\s*<botmux_reminder>/.test(text)) return;
  return match?.[1] ?? text;
}
export function publicCodexEvent(row: any, id: string): CodexSyncEvent | undefined {
  const tool = publicCodexToolEvent(row);
  if (tool) return { id, kind: 'tool', text: tool, at: row.timestamp };
  const p = row.payload ?? {};
  if (row?.type === 'response_item' && p.type === 'message') {
    const text = (Array.isArray(p.content) ? p.content : []).filter((c: any) => ['input_text', 'output_text'].includes(c.type)).map((c: any) => c.text ?? '').join('');
    if (p.role === 'user') {
      const question = publicCodexUserText(text);
      if (question?.trim()) return { id, kind: 'user', text: question, at: row.timestamp };
    }
    if (p.role === 'assistant' && p.phase === 'commentary' && text.trim()) return { id, kind: 'progress', text, at: row.timestamp };
    return;
  }
  if (row?.type !== 'event_msg') return;
  if (p.type === 'user_message' && typeof p.message === 'string') {
    // Botmux wrappers are transport metadata, not the user's question.
    const question = publicCodexUserText(p.message);
    if (question?.trim()) return { id, kind: 'user', text: question, at: row.timestamp };
    return;
  }
  if (p.type === 'agent_message' && p.phase === 'commentary') return { id, kind: 'progress', text: String(p.message ?? ''), at: row.timestamp };
  if (p.type === 'task_complete' && p.last_agent_message) return { id, kind: 'final', text: String(p.last_agent_message), at: row.timestamp };
  if (p.type === 'task_started') return { id, kind: 'status', text: '执行中', at: row.timestamp };
  if (p.type === 'task_complete' || p.type === 'turn_aborted') return { id, kind: 'status', text: p.type === 'turn_aborted' ? '已中断' : '本轮完成', at: row.timestamp };
}

/** Stable across event_msg/response_item copies and Codex history rewrites. */
export function codexSyncEventKey(row: any, event: CodexSyncEvent, turnId?: string): string {
  const p = row.payload ?? {};
  const key = event.kind === 'tool' ? `${p.type}:${p.call_id ?? p.id ?? event.text}` : `${event.kind}:${event.text.trim()}`;
  return `${turnId ?? ''}:${createHash('sha256').update(key).digest('hex').slice(0, 24)}`;
}
