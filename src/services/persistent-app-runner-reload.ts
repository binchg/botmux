const BOTMUX_APP_RUNNER_CLI_IDS = new Set(['codex-app', 'mira', 'mir']);

/** daemon 重启默认保留持久 AI 进程，不把终端重放的就绪标记当成重载授权。
 * runner 实现更新通过显式重建生效；单纯更新消息投递策略不应打断后台任务。 */
export function shouldReloadPersistentAppRunner(
  cliId: string | undefined,
  willReattachPersistent: boolean,
  reloadRequested = false,
): boolean {
  return reloadRequested && willReattachPersistent && BOTMUX_APP_RUNNER_CLI_IDS.has(cliId ?? '');
}
