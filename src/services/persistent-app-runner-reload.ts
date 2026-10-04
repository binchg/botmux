import { readGlobalConfig } from '../global-config.js';
import { modelRuntimeAlive, readSessionModelRuntime } from './session-model-store.js';

const BOTMUX_APP_RUNNER_CLI_IDS = new Set(['codex-app', 'mira', 'mir']);

/** A saved global decision survives daemon/worker replacement before the queued reload. */
export function globalHookPolicyNeedsReload(cliId: string | undefined, dataDir: string, sessionId: string): boolean {
  const policy = readGlobalConfig().hookTrust;
  if (cliId !== 'codex-app' || !policy) return false;
  try {
    const runtime = readSessionModelRuntime(dataDir, sessionId);
    return !modelRuntimeAlive(runtime) || runtime?.selection?.hookTrust !== policy;
  } catch { return true; }
}

/** daemon 重启默认保留持久 AI 进程，不把终端重放的就绪标记当成重载授权。
 * runner 实现更新通过显式重建生效；单纯更新消息投递策略不应打断后台任务。 */
export function shouldReloadPersistentAppRunner(
  cliId: string | undefined,
  willReattachPersistent: boolean,
  reloadRequested = false,
): boolean {
  return reloadRequested && willReattachPersistent && BOTMUX_APP_RUNNER_CLI_IDS.has(cliId ?? '');
}
