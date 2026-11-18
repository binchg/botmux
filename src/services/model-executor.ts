/** 执行器的进程级隔离与模型目录；方舟配置只注入明确启用的机器人子进程。 */
import { isAbsolute } from 'node:path';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { listCodexAppModels } from './codex-app-threads.js';
import type { AvailableSessionModel } from './session-model-selection.js';

export type ModelExecutor = 'codex-app' | 'traex' | 'ark' | 'gateway';

/** 方舟使用独立 CODEX_HOME；禁止复用默认目录或把凭据写进共享进程环境。 */
export function modelExecutorEnv(executor: ModelExecutor, env = process.env): NodeJS.ProcessEnv {
  if (executor !== 'ark' && executor !== 'gateway') return env;
  const home = executor === 'ark' ? env.ARK_CODEX_HOME : env.GATEWAY_CODEX_HOME;
  if (!home || !isAbsolute(home) || !existsSync(home + '/config.toml')) throw new Error(`${executor}_isolated_config_required`);
  const target = realpathSync(home);
  const defaults = [env.CODEX_HOME, `${env.HOME ?? homedir()}/.codex`].filter((path): path is string => !!path);
  if (defaults.some(path => existsSync(path) && realpathSync(path) === target)) {
    throw new Error(`${executor}_global_config_forbidden`);
  }
  return { ...env, CODEX_HOME: home };
}

/** 仅返回已配置的方舟模型；目录不含密钥，也不把公共基础模型当作可调用接入点。 */
export function arkModels(env = process.env): AvailableSessionModel[] {
  return providerModels('ark', env);
}

/** 独立网关与直连分别读取目录，密钥配置不会随模型切换带到其它提供方。 */
export function providerModels(executor: 'ark' | 'gateway', env = process.env): AvailableSessionModel[] {
  modelExecutorEnv(executor, env);
  const file = executor === 'ark' ? env.ARK_MODELS_FILE : env.GATEWAY_MODELS_FILE;
  if (!file || !isAbsolute(file)) throw new Error(`${executor}_model_catalog_required`);
  const rows = JSON.parse(readFileSync(file, 'utf8'));
  if (!Array.isArray(rows) || rows.length > 100 || rows.some(row => !row.model
    || !Array.isArray(row.supportedReasoningEfforts) || !row.supportedReasoningEfforts.length)) {
    throw new Error('invalid_ark_model_catalog');
  }
  return rows.map(row => ({ ...row, executor }));
}

/** 目录探测与实际运行复用同一环境，原生 Codex 和 TraeX 不继承方舟配置。 */
export async function executorModels(executor: ModelExecutor, cwd = process.cwd(), codexBin?: string,
  env = process.env, traexBin = env.TRAEX_APP_SERVER_BIN || 'traex'): Promise<AvailableSessionModel[]> {
  if (executor === 'ark' || executor === 'gateway') return providerModels(executor, env);
  return listCodexAppModels({ cwd, codexBin: executor === 'traex' ? traexBin : codexBin });
}
