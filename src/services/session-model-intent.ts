/** 只识别用户正文中的明确选模指令；引用、代码示例和模型讨论不修改配置。 */
export interface SessionModelIntent {
  model?: string;
  effort?: string;
  serviceTier?: 'default' | 'priority';
  routingMode?: 'fixed' | 'adaptive';
}

/** 模型别名只做拼写归一，最终是否可用仍以当前执行器目录为准。 */
export function normalizeModelAlias(value: string): string {
  const normalized = value.toLowerCase().replace(/[\s_-]+/g, '');
  if (normalized === 'gpt6.1') return 'gpt-6.1-sol';
  return normalized;
}

/** 提取当前用户明确发出的命令，不能从附带的历史或机器人提示中提权。 */
export function parseSessionModelIntent(content: string): SessionModelIntent | undefined {
  const user = /<user_message>\s*([\s\S]*?)\s*<\/user_message>/u.exec(content)?.[1] ?? content;
  const text = user.replace(/```[\s\S]*?```/g, '').replace(/<(quoted_message|history|botmux_executor_handoff)>[\s\S]*?<\/\1>/g, '');
  let example = false;
  for (const line of text.split(/\r?\n/)) {
    const value = line.trim();
    if (/^(?:比如|例如|示例|举例|example)(?:[:：]|\s|$)/iu.test(value)) { example = true; continue; }
    if (!value) { example = false; continue; }
    if (example || /^>/u.test(value)) continue;
    if (/^(?:请\s*)?(?:(?:本|当前|这个)会话\s*)?(?:不是|不要|不用|关闭|取消|禁用)\s*(?:fast|priority|快速|加速)[。！!]?$/iu.test(value)) {
      return { serviceTier: 'default' };
    }
    if (/^(?:请\s*)?(?:(?:本|当前|这个)会话\s*)?(?:恢复|开启|使用)自动选(?:模|择模型)[。！!]?$/u.test(value)) {
      return { routingMode: 'adaptive' };
    }
    const command = /^(?:请|麻烦|帮我)?\s*(?:(?:本|当前|这个|新建)会话\s*)?(?:的?模型\s*[:：]?\s*)?(?:(?:切换|设置|换|改)(?:成|到|为)?|指定(?:使用|为)?|使用|用)\s*(?:模型\s*)?/u.exec(value);
    const bare = /^(?:模型\s*[:：]\s*|gpt\s*[-_]?\s*\d)/iu.test(value);
    if (!command && !bare) continue;
    const body = command ? value.slice(command[0].length) : value.replace(/^模型\s*[:：]\s*/u, '');
    const clause = body.split(/[，,。；;]/u)[0];
    if (/[?？]|哪个|区别|是否|怎么样|会不会|能不能|对比|比较|吗/u.test(clause)) continue;
    const model = /\bgpt\s*[-_]?\s*\d+(?:\.\d+)?(?:[\s_-]*(?:sol|terra|astra|luna))?(?:[-_][a-z][a-z0-9_.-]*)*\b/iu.exec(body)?.[0];
    const effort = /\b(xhigh|ultra|max|high|medium|low)\b/iu.exec(body)?.[1]?.toLowerCase();
    const normalSpeed = /(?:不是|不要|不用|关闭|取消|禁用|非)\s*(?:fast|priority|快速|加速)/iu.test(value);
    const fast = !normalSpeed && /(?:\bfast\b|\bpriority\b|开启快速|开启加速)/iu.test(body);
    if (!model && !effort && !normalSpeed && !fast) continue;
    return { ...(model ? { model, routingMode: 'fixed' } : {}), ...(effort ? { effort } : {}),
      ...(normalSpeed ? { serviceTier: 'default' } : fast ? { serviceTier: 'priority' } : {}) };
  }
  return undefined;
}
