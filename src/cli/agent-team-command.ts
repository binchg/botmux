/** `botmux team`：同一 Bot 的持久独立会话团队控制面。 */
import { existsSync, readFileSync } from 'node:fs';
import { MAX_AGENT_TEAM_ACTIVE_WORKERS } from '../services/agent-team-store.js';

export interface AgentTeamCliContext {
  sessionId: string;
  larkAppId: string;
  ipcPort: number;
}

const HELP = `botmux team — 同一 Bot 多独立会话的 supervisor 控制面

用法:
  botmux team create --name <名称> (--objective <目标> | --objective-file <文件>) [--max-active-workers <1..6>]
  botmux team list
  botmux team status [--team <team_id>]
  botmux team configure [--team <team_id>] [--max-active-workers <1..6>]
      [--worker <worker_id> --clear-depends-on]
  botmux team spawn [--team <team_id>] --id <worker_id> --title <标题>
      (--assignment <任务> | --assignment-file <文件>) [--repo <目录>] [--depends-on <worker_id> ...]
      [--reuse-key <稳定任务坐标>] [--writer]
  botmux team send [--team <team_id>] --worker <worker_id> (--content <纠偏> | --content-file <文件>)
      [--kind correction|replacement|addition|status_query]
      [--lifetime task-scoped|one-shot|revoked] [--revoke-revision <revision_id>]
  botmux team milestone --team <team_id> --type audit_eligible|commit_pushed|bits_mr_ready|build_started|build_terminal|human_required
      (--summary <摘要> | --summary-file <文件>) [--url <BITS_URL>] [--evidence-ref <引用> ...]
      [--branch <分支>] [--sha <提交SHA>] [--build-job <构建节点或URL>]
      [--attempt-id <attempt_id>] [--revision-id <revision_id>] [--idempotency-key <稳定键>]
  botmux team interrupt [--team <team_id>] --worker <worker_id>
  botmux team reap [--team <team_id>] [--close-team]

说明:
  - leader 只负责编排；spawn 出来的每个 worker 都是同一飞书 Bot 的独立 Codex App session。
  - 默认最多 3 个额外活跃 worker，create/configure 可调到 1..6，leader 全局硬上限 6；queued 不占配额，status 显示双层容量。
  - configure 持久写入审计事件；重复配置幂等，禁止缩到当前 Team 活跃数以下，清依赖不删除 attempt/history。
  - depends-on 未满足时只登记 queued，不创建 session；只有依赖当前 attempt succeeded 才启动。
  - reuse-key 或同 --repo 的 --writer 命中时不重复 spawn，返回已有 worker 并引导 team send。
  - send 默认 addition/task-scoped；每次可执行 guidance 创建 revision/attempt。status_query 只读，不创建 attempt/恢复 session。
  - closed/已回报 worker 的 send 会复用原 session/thread 并 cold-resume；失败保持 fail-closed。
  - milestone 是当前 attempt 的非终态产物事件；BITS URL 立即进入 leader 可见 outbox，重复 URL 幂等，旧 revision 隔离。
  - worker final 必须含 attemptId/revisionId/status/summary/evidenceRefs/metrics，invalid/旧 attempt 不计成功。
  - interrupt 只中断当前 turn，不删除会话；活 runner 必须等 Codex App Server 回执；registry/session 明确消失时才 crash-safe 回收并保留审计。
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
      const maxRaw = value(rest, '--max-active-workers');
      const maxActiveWorkers = maxRaw === undefined ? undefined : Number(maxRaw);
      if (maxRaw !== undefined && (!Number.isInteger(maxActiveWorkers) || maxActiveWorkers! < 1 || maxActiveWorkers! > MAX_AGENT_TEAM_ACTIVE_WORKERS)) {
        throw new Error(`--max-active-workers 必须是 1..${MAX_AGENT_TEAM_ACTIVE_WORKERS} 的整数`);
      }
      print(await request(ctx, '/api/agent-teams', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ leaderSessionId: ctx.sessionId, name, objective, maxActiveWorkers }),
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
    if (sub === 'configure') {
      const maxRaw = value(rest, '--max-active-workers');
      const maxActiveWorkers = maxRaw === undefined ? undefined : Number(maxRaw);
      const workerId = (value(rest, '--worker') ?? '').trim();
      const clearDependsOn = rest.includes('--clear-depends-on');
      if (maxRaw === undefined && !clearDependsOn) {
        throw new Error('configure 需要 --max-active-workers 或 --worker ... --clear-depends-on');
      }
      if (maxRaw !== undefined && (!Number.isInteger(maxActiveWorkers) || maxActiveWorkers! < 1 || maxActiveWorkers! > MAX_AGENT_TEAM_ACTIVE_WORKERS)) {
        throw new Error(`--max-active-workers 必须是 1..${MAX_AGENT_TEAM_ACTIVE_WORKERS} 的整数`);
      }
      if (clearDependsOn && !workerId) throw new Error('--clear-depends-on 需要 --worker');
      print(await request(ctx, `/api/agent-teams/${encodeURIComponent(teamId)}/configure`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          actorSessionId: ctx.sessionId,
          maxActiveWorkers,
          workerId: workerId || undefined,
          clearDependsOn,
        }),
      }));
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
          reuseKey: value(rest, '--reuse-key'),
          writer: rest.includes('--writer'),
        }),
      }));
      return 0;
    }
    if (sub === 'milestone') {
      const type = (value(rest, '--type') ?? '').trim();
      const summary = textArg(rest, '--summary', '--summary-file');
      if (!type || !summary) throw new Error('milestone 需要 --type 和 --summary/--summary-file');
      print(await request(ctx, `/api/agent-teams/${encodeURIComponent(teamId)}/milestones`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          actorSessionId: ctx.sessionId,
          workerId: value(rest, '--worker'),
          type,
          summary,
          url: value(rest, '--url'),
          evidenceRefs: values(rest, '--evidence-ref'),
          attemptId: value(rest, '--attempt-id'),
          revisionId: value(rest, '--revision-id'),
          idempotencyKey: value(rest, '--idempotency-key'),
          branch: value(rest, '--branch'),
          sha: value(rest, '--sha'),
          buildJob: value(rest, '--build-job'),
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
        body: JSON.stringify({
          actorSessionId: ctx.sessionId,
          content,
          guidanceType: value(rest, '--kind'),
          lifetime: value(rest, '--lifetime'),
          revokesRevisionId: value(rest, '--revoke-revision'),
        }),
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
