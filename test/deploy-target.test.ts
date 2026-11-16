/** 定向部署必须绑定准确机器人与 canonical 入口，不能重启其它机器人。 */
import { expect, it } from 'vitest';
import { resolveDeployTarget, verifyTargetRestart } from '../scripts/lib/deploy-target.mjs';

/** 最小 PM2 快照，不含凭据与其它环境变量。 */
const app = (name: string, index: number, pid: number, path = '/repo/dist/index-daemon.js') => ({ name, pid,
  pm2_env: { status: 'online', pm_exec_path: path, env: { BOTMUX_BOT_INDEX: String(index) } } });
const bots = [{ larkAppId: 'cli_snow' }, { larkAppId: 'cli_x' }];
it('只选择准确 AppID，回读时要求其它进程 PID 不变', () => {
  const before = [app('snow', 0, 10), app('x', 1, 20)];
  const target = resolveDeployTarget('cli_x', bots, before, '/repo');
  expect(target.name).toBe('x');
  expect(verifyTargetRestart(target, before, [before[0], app('x', 1, 21)]).otherProcessesPreserved).toBe(true);
  expect(() => verifyTargetRestart(target, before, [app('snow', 0, 11), app('x', 1, 21)])).toThrow('非目标');
  expect(() => verifyTargetRestart(target, before, before)).toThrow('回读失败');
});
it('拒绝未知 AppID、重复机器人、错误 checkout 与重复目标进程', () => {
  const apps = [app('x', 1, 20)];
  expect(() => resolveDeployTarget('cli_missing', bots, apps, '/repo')).toThrow();
  expect(() => resolveDeployTarget('cli_x', [...bots, bots[1]], apps, '/repo')).toThrow();
  expect(() => resolveDeployTarget('cli_x', bots, [app('x', 1, 20, '/other/dist/index-daemon.js')], '/repo')).toThrow();
  expect(() => resolveDeployTarget('cli_x', bots, [...apps, ...apps], '/repo')).toThrow();
});
