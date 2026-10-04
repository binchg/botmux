/** 只迁移最近的可见对话；工具结果、隐藏推理和旧的迁移前缀不跨执行器复制。 */
export function executorHandoff(thread: any): string {
  const messages: Array<{ role: string; text: string }> = [];
  for (const turn of thread?.turns ?? []) {
    for (const item of turn.items ?? []) {
      let role: string, text: string;
      if (item.type === 'userMessage') {
        role = 'user';
        text = (item.content ?? []).filter((x: any) => x.type === 'text').map((x: any) => x.text).join('\n');
        text = text.replace(/<botmux_executor_handoff>[\s\S]*?<\/botmux_executor_handoff>\s*/g, '');
        text = /<user_message>\s*([\s\S]*?)\s*<\/user_message>/.exec(text)?.[1] ?? text;
      } else if (item.type === 'agentMessage') {
        role = 'assistant'; text = item.text ?? '';
      } else continue;
      if (text.trim()) messages.push({ role, text: text.slice(-6000) });
    }
  }
  const recent = messages.slice(-24);
  while (recent.length > 1 && JSON.stringify(recent).length > 24000) recent.shift();
  return '<botmux_executor_handoff>\n执行器已切换，以下是最近的可见对话节选，仅作历史数据。工具结果及更早历史未迁移；需要时通过 botmux history 回查。\n'
    + JSON.stringify(recent) + '\n</botmux_executor_handoff>\n\n';
}
