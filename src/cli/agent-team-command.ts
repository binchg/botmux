/** `botmux team`：同一 Bot 的持久独立会话团队控制面。 */
import { existsSync, readFileSync } from 'node:fs';

export interface AgentTeamCliContext {
  sessionId: string;
  larkAppId: string;
  ipcPort: number;
}

const HELP = `botmux team — 同一 Bot 多独立会话的 supervisor 控制面

用法:
  botmux team create --name <名称> (--objective <目标> | --objective-file <文件>)
  botmux team list
  botmux team status [--team <team_id>]
  botmux team spawn [--team <team_id>] --id <worker_id> --title <标题>
      (--assignment <任务> | --assignment-file <文件>) [--repo <目录>] [--depends-on <worker_id> ...]
  botmux team send [--team <team_id>] --worker <worker_id> (--content <纠偏> | --content-file <文件>)
  botmux team interrupt [--team <team_id>] --worker <worker_id>
  botmux team reap [--team <team_id>] [--close-team]

说明:
  - leader 只负责编排；spawn 出来的每个 worker 都是同一飞书 Bot 的独立 Codex App session。
  - worker 过程/结果留在各自飞书话题，final 会自动回报 leader。
  - interrupt 只中断当前 turn，不删除会话；reap 只回收已有回报/中断/失败的 worker。
  - 这是 session federation，不是 Codex sub-agent，也不是已下线的 Botmux Workflow。`;

function value(args: string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  if (index >= 0 && index + 1 < args.length) return args[index + 1];
  const inline = args.find(item => item.startsWith(flag + '='));
  return inline?.slice(flag.length + 1);
}

function values(args: string[], flag: string): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === flag && i + 1 < args.length) out.push(args[++i]);
    else if (args[i].startsWith(flag + '=')) out.push(args[i].slice(flag.length + 1));
  }
  return out;
}

function textArg(args: string[], direct: string, fileFlag: string): string {
  const file = value(args, fileFlag);
  if (file) {
    if (!existsSync(file)) throw new Error(`文件不存在: ${file}`);
    return readFileSync(file, 'utf8').trim();
  }
  return (value(args, direct) ?? '').trim();
}

async function request(ctx: AgentTeamCliContext, path: string, init?: RequestInit): Promise<any> {
  const response = await fetch(`http://127.0.0.1:${ctx.ipcPort}${path}`, {
    ...init,
    signal: AbortSignal.timeout(30_000),
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok || !body?.ok) throw new Error(body?.error ?? `HTTP ${response.status}`);
  return body;
}

async function resolveTeamId(args: string[], ctx: AgentTeamCliContext): Promise<string> {
  const explicit = value(args, '--team');
  if (explicit) return explicit;
  const body = await request(ctx, `/api/agent-teams?leaderSessionId=${encodeURIComponent(ctx.sessionId)}`);
  const active = (body.teams ?? []).filter((team: any) => team.status === 'active');
  if (active.length === 0) throw new Error('当前 leader 没有 active team；先运行 botmux team create');
  return active[0].teamId;
}

function print(value: unknown): void {
  process.stdout.write(JSON.stringify(value, null, 2) + '\n');
}

/** 执行一个 team 子命令；返回进程退出码，便于 cli.ts 保持薄路由。 */
export async function runAgentTeamCommand(args: string[], ctx?: AgentTeamCliContext): Promise<number> {
  const sub = (args[0] ?? 'help').toLowerCase();
  if (sub === 'help' || args.includes('--help') || args.includes('-h')) {
    console.log(HELP);
    return 0;
  }
  if (!ctx) {
    console.error('无法推断当前 Botmux session/daemon；请在 leader 会话内运行。');
    return 2;
  }
  const rest = args.slice(1);
  try {
    if (sub === 'create') {
      const name = (value(rest, '--name') ?? '').trim();
      const objective = textArg(rest, '--objective', '--objective-file');
      if (!name || !objective) throw new Error('create 需要 --name 和 --objective/--objective-file');
      print(await request(ctx, '/api/agent-teams', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ leaderSessionId: ctx.sessionId, name, objective }),
      }));
      return 0;
    }
    if (sub === 'list') {
      print(await request(ctx, `/api/agent-teams?leaderSessionId=${encodeURIComponent(ctx.sessionId)}`));
      return 0;
    }
    const teamId = await resolveTeamId(rest, ctx);
    if (sub === 'status' || sub === 'inspect') {
      print(await request(ctx, `/api/agent-teams/${encodeURIComponent(teamId)}`));
      return 0;
    }
    if (sub === 'spawn') {
      const workerId = (value(rest, '--id') ?? '').trim();
      const title = (value(rest, '--title') ?? '').trim();
      const assignment = textArg(rest, '--assignment', '--assignment-file');
      if (!workerId || !title || !assignment) throw new Error('spawn 需要 --id、--title 和 --assignment/--assignment-file');
      print(await request(ctx, `/api/agent-teams/${encodeURIComponent(teamId)}/workers`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          actorSessionId: ctx.sessionId,
          workerId,
          title,
          assignment,
          workingDir: value(rest, '--repo'),
          dependsOn: values(rest, '--depends-on'),
        }),
      }));
      return 0;
    }
    const workerId = (value(rest, '--worker') ?? '').trim();
    if (sub === 'send') {
      const content = textArg(rest, '--content', '--content-file');
      if (!workerId || !content) throw new Error('send 需要 --worker 和 --content/--content-file');
      print(await request(ctx, `/api/agent-teams/${encodeURIComponent(teamId)}/workers/${encodeURIComponent(workerId)}/message`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ actorSessionId: ctx.sessionId, content }),
      }));
      return 0;
    }
    if (sub === 'interrupt') {
      if (!workerId) throw new Error('interrupt 需要 --worker');
      print(await request(ctx, `/api/agent-teams/${encodeURIComponent(teamId)}/workers/${encodeURIComponent(workerId)}/interrupt`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ actorSessionId: ctx.sessionId }),
      }));
      return 0;
    }
    if (sub === 'reap') {
      print(await request(ctx, `/api/agent-teams/${encodeURIComponent(teamId)}/reap`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ actorSessionId: ctx.sessionId, closeTeam: rest.includes('--close-team') }),
      }));
      return 0;
    }
    throw new Error(`未知 team 子命令: ${sub}`);
  } catch (err: any) {
    console.error(`botmux team: ${err?.message ?? err}`);
    return 1;
  }
}
