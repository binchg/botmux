export interface ModelCommandContext { sessionId: string; ipcPort: number }
export const MODEL_COMMAND_HELP = `botmux model [status|list]
botmux model set <model> [effort] [--service-tier <tier>] [--session-id <id>]
botmux model effort <effort> [--session-id <id>]

仅修改当前指定会话；不改全局配置。已发出的推理从下一轮切换。
status 区分待更新运行器、下一轮生效、请求已接受和推理完成核验。`;
export function parseModelCommand(args: string[]) {
  const positional: string[] = [];
  let serviceTier: string | undefined;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--session-id' || arg === '--service-tier') {
      const value = args[++i]; if (!value || value.startsWith('--')) throw new Error('option_value_required');
      if (arg === '--service-tier') serviceTier = value;
    } else if (arg.startsWith('-')) throw new Error('unknown_option');
    else positional.push(arg);
  }
  const action = positional[0] ?? 'status';
  if (['status', 'list'].includes(action) && positional.length <= 1 && !serviceTier) return { action };
  if (action === 'set' && positional.length >= 2 && positional.length <= 3) return { action, body: { model: positional[1], ...(positional[2] ? { effort: positional[2] } : {}), ...(serviceTier ? { serviceTier } : {}) } };
  if (action === 'effort' && positional.length === 2 && !serviceTier) return { action: 'set', body: { effort: positional[1] } };
  throw new Error('invalid_model_command');
}
export async function runSessionModelCommand(args: string[], ctx?: ModelCommandContext): Promise<number> {
  if (args.some(x => ['help', '--help', '-h'].includes(x))) { console.log(MODEL_COMMAND_HELP); return 0; }
  try {
    const command = parseModelCommand(args);
    if (!ctx) throw new Error('current_session_or_daemon_not_found');
    const url = `http://127.0.0.1:${ctx.ipcPort}/api/sessions/${encodeURIComponent(ctx.sessionId)}/model${command.action === 'list' ? '/list' : ''}`;
    const response = await fetch(url, command.action === 'set'
      ? { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(command.body), signal: AbortSignal.timeout(30_000) }
      : { signal: AbortSignal.timeout(30_000) });
    const result = await response.json();
    if (!response.ok || !result.ok) throw new Error(result.error || `HTTP ${response.status}`);
    console.log(JSON.stringify(result, null, 2)); return 0;
  } catch (error) { console.error(error instanceof Error ? error.message : 'model_command_failed'); return 1; }
}
