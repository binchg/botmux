import type { DaemonToWorker } from '../types.js';
import { readSessionModelRuntime } from './session-model-store.js';

/** 新建 TraeX 话题统一走可控 app-server；已有原生终端只保留原样恢复。 */
export function configureTraexAppLaunch(config: Extract<DaemonToWorker, { type: 'init' }>, dataDir: string, explicitMigration = false): void {
  if (config.cliId !== 'traex' || config.adoptMode || config.wrapperCli || config.env?.TRAEX_ADAPTIVE_ENABLED === '0') return;
  if (config.resume && !explicitMigration && !readSessionModelRuntime(dataDir, config.sessionId)) return;
  config.env = { ...config.env, TRAEX_APP_SERVER_DEFAULT: '1', TRAEX_APP_SERVER_BIN: config.cliPathOverride || 'traex' };
  config.cliId = 'codex-app';
  config.cliPathOverride = undefined;
}
