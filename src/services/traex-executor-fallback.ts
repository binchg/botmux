import { TraexAdmissionStopped } from './traex-admission.js';
import { listCodexAppModels } from './codex-app-threads.js';
import { validateModelSelection } from './session-model-selection.js';
import { readSessionModel, writeSessionModel, type SessionModelRequest } from './session-model-store.js';

/** TraeX 准入失败后的可选单向接续；默认关闭，保留显式模型选择和取消边界。 */
export interface TraexFallbackOptions {
  dataDir: string;
  sessionId: string;
  cwd: string;
  codexBin: string;
  executor: () => 'traex' | 'codex-app';
  run: () => Promise<void>;
  notice: (text: string) => void;
  signal: AbortSignal;
  env?: NodeJS.ProcessEnv;
  models?: typeof listCodexAppModels;
}

/** 仅准入耗尽触发一次接续，目标失败直接向上返回，不在执行器间循环。 */
export async function runWithTraexFallback(options: TraexFallbackOptions): Promise<void> {
  const { dataDir, sessionId, run, notice } = options;
  const env = options.env ?? process.env;
  const initial = readSessionModel(dataDir, sessionId);
  try { await run(); return; }
  catch (error) {
    if (!(error instanceof TraexAdmissionStopped) || options.executor() !== 'traex'
      || env.TRAEX_ADAPTIVE_FALLBACK_EXECUTOR !== 'codex-app') throw error;
  }
  options.signal.throwIfAborted();
  // 只接受完整配置，禁止把 TraeX 专用型号或速度参数带到另一执行器。
  const model = env.TRAEX_ADAPTIVE_FALLBACK_MODEL;
  const effort = env.TRAEX_ADAPTIVE_FALLBACK_EFFORT ?? 'xhigh';
  if (!model) throw new Error('TraeX 接续未配置 Codex 模型，原会话已保留。');
  const unchanged = (current?: SessionModelRequest) => current?.revision === initial?.revision;
  if (!unchanged(readSessionModel(dataDir, sessionId))) throw new Error('选模配置已变化，本轮不自动覆盖。');
  const models = await (options.models ?? listCodexAppModels)({ cwd: options.cwd, codexBin: options.codexBin });
  options.signal.throwIfAborted();
  const selection = validateModelSelection({ executor: 'codex-app', model, effort, serviceTier: 'default',
    ...(initial?.hookTrust ? { hookTrust: initial.hookTrust } : {}) }, models);
  if (!unchanged(readSessionModel(dataDir, sessionId))) throw new Error('选模配置已变化，本轮不自动覆盖。');
  // 复用运行器的执行器切换：目标初始化成功才替换原线程，并迁移最近可见对话。
  // 持久保存选择，后续追问留在 Codex；只有用户显式切回才再次使用 TraeX。
  writeSessionModel(dataDir, sessionId, selection);
  notice(`TraeX 无法取得准入，尝试切换到 Codex · ${selection.model} · ${selection.effort} 接续原请求。最近可见对话会迁移，更早历史可回查；后续追问继续使用 Codex。`);
  await run();
}
