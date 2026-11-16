import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { realpathSync } from 'node:fs';

/** 允许同一个 canonical 目录的 /home 与 /data00 软链接入口。 */
function canonical(path) { try { return realpathSync(path); } catch { return resolve(path); } }

/** 从已注册进程中精确绑定单个机器人；不允许名称模糊匹配或串用其它 checkout。 */
export function resolveDeployTarget(appId, bots, apps, repoRoot) {
  const matches = bots.map((bot, index) => ({ bot, index })).filter(x => x.bot.larkAppId === appId);
  if (matches.length !== 1) throw new Error('定向部署必须匹配唯一 AppID');
  const { index } = matches[0];
  const targets = apps.filter(app => String(app.pm2_env?.env?.BOTMUX_BOT_INDEX ?? app.pm2_env?.BOTMUX_BOT_INDEX) === String(index)
    && canonical(app.pm2_env?.pm_exec_path ?? '/') === canonical(join(repoRoot, 'dist', 'index-daemon.js')));
  if (targets.length !== 1 || targets[0].pm2_env.status !== 'online') throw new Error('定向部署目标进程不唯一或未在线');
  return { appId, name: targets[0].name, pid: targets[0].pid, index };
}

/** 重启后必须确认目标进程已替换，其他机器人的 PID 完全保持。 */
export function verifyTargetRestart(target, before, after) {
  const current = after.find(app => app.name === target.name);
  if (!current?.pid || current.pid === target.pid || current.pm2_env?.status !== 'online') throw new Error('定向重启回读失败');
  for (const app of before.filter(app => app.name !== target.name)) {
    if (after.find(item => item.name === app.name)?.pid !== app.pid) throw new Error(`非目标进程发生变化: ${app.name}`);
  }
  return { appId: target.appId, name: target.name, previousPid: target.pid, pid: current.pid, otherProcessesPreserved: true };
}

/** 与 CLI 使用同一隔离 PM2_HOME，防止碰到系统的其他 PM2 实例。 */
export function deployPm2Home() { return join(homedir(), '.botmux', 'pm2'); }
