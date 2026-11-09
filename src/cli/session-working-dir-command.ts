export interface WorkingDirCommandContext { sessionId: string; ipcPort: number }

export const WORKING_DIR_COMMAND_HELP = `botmux cwd [status] [--session-id <id>] [--json]
botmux cwd set <path> [--session-id <id>] [--json]
botmux cwd cancel [--session-id <id>] [--json]
botmux cwd --help

默认查看当前会话；--session-id 指定目标会话。status 不接受路径，set 只接受一个路径，cancel 不接受参数。
始终输出后端 JSON；--json 用于显式声明该输出格式。
actualWorkingDir 是当前运行目录，workingDir 是会话目录，pendingWorkingDir 是待生效目录；以 status/appliesTo 为准。
set 不终止当前 worker，只在运行器确认空闲后的下一次安全输入生效；恢复重连保留待切换请求。cancel 撤销待生效切换。
所有操作仅影响目标会话，不修改全局配置（globalConfigChanged: false）。`;

type WorkingDirCommand = {
  action: 'status' | 'set' | 'cancel' | 'help';
  sessionId?: string;
  body?: { workingDir: string } | { cancel: true };
};

/** 先完整校验并剥离选项；非法参数和帮助命令都不进入 HTTP 请求。 */
export function parseWorkingDirCommand(args: string[]): WorkingDirCommand {
  const positional: string[] = [];
  const seen = new Set<string>();
  let sessionId: string | undefined;
  let help = false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    const option = arg === '-h' ? '--help' : arg;
    if (['--session-id', '--json', '--help'].includes(option)) {
      if (seen.has(option)) throw new Error('duplicate_option');
      seen.add(option);
      if (option === '--session-id') {
        const value = args[++i];
        if (!value?.trim() || value.startsWith('-')) throw new Error('option_value_required');
        sessionId = value;
      } else if (option === '--help') help = true;
    } else if (arg.startsWith('-')) throw new Error('unknown_option');
    else positional.push(arg);
  }
  const action = positional[0] ?? 'status';
  const command: WorkingDirCommand = { action: 'status', ...(sessionId ? { sessionId } : {}) };
  if (action === 'help' && positional.length === 1) return { ...command, action: 'help' };
  if ((action === 'status' || action === 'cancel') && positional.length <= 1) {
    command.action = action;
    if (action === 'cancel') command.body = { cancel: true };
  } else if (action === 'set' && positional.length === 2 && positional[1].trim()) {
    command.action = 'set';
    command.body = { workingDir: positional[1] };
  } else if (!(help && action === 'set' && positional.length === 1)) {
    throw new Error('invalid_working_dir_command');
  }
  return help ? { ...command, action: 'help' } : command;
}

/** 入口按 --session-id 选择会话及 daemon；这里只校验选项，不重新发现或改写注入上下文。 */
export async function runSessionWorkingDirCommand(args: string[], ctx?: WorkingDirCommandContext): Promise<number> {
  try {
    const command = parseWorkingDirCommand(args);
    if (command.action === 'help') { console.log(WORKING_DIR_COMMAND_HELP); return 0; }
    if (!ctx) throw new Error('current_session_or_daemon_not_found');
    const url = `http://127.0.0.1:${ctx.ipcPort}/api/sessions/${encodeURIComponent(ctx.sessionId)}/working-dir`;
    const signal = AbortSignal.timeout(30_000);
    const response = await fetch(url, command.action === 'status'
      ? { method: 'GET', signal }
      : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(command.body), signal });
    const result = await response.json().catch(() => {
      throw new Error(response.ok ? 'invalid_working_dir_response' : `HTTP ${response.status}`);
    });
    if (!response.ok || result?.ok !== true) {
      throw new Error(typeof result?.error === 'string' && result.error
        ? result.error : response.ok ? 'invalid_working_dir_response' : `HTTP ${response.status}`);
    }
    // 原样保留后端的实际目录、待切换目录和生效时机，不能把受理误报成已切换。
    console.log(JSON.stringify(result, null, 2));
    return 0;
  } catch (error) {
    console.error(error instanceof Error ? error.message : 'working_dir_command_failed');
    return 1;
  }
}
