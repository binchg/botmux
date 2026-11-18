/** 执行器切换事务：目标初始化成功才替换进程，并保留最近可见消息与 Hook 策略。 */
import { invalidateGlobalConfigCache, readGlobalConfig } from '../global-config.js';
import { AppServerClient } from './app-runner-client.js';
import type { Args } from './app-runner-types.js';
import { executorHandoff } from './session-executor-handoff.js';
import { localExecutorHandoff } from './executor-handoff-tail.js';
import { modelExecutorEnv, type ModelExecutor } from './model-executor.js';
import { writeSessionExecutor, type SessionModelRequest } from './session-model-store.js';

export interface ExecutorSnapshot {
  client: AppServerClient; executor: ModelExecutor; hookTrust: 'always' | 'review';
  threadId?: string; handoff: string; defaults?: Record<string, any>;
}
/** 初始化和读取旧历史均有期限；失败关闭候选，旧线程和已保存选择保持可回读。 */
export async function switchAppExecutor(options: {
  args: Args; dataDir: string; current: ExecutorSnapshot; requested?: SessionModelRequest;
  instructions: () => string; activate: (state: ExecutorSnapshot) => void;
}): Promise<void> {
  const { current, requested, args } = options;
  const target = requested?.executor ?? current.executor;
  invalidateGlobalConfigCache();
  const hookTrust = readGlobalConfig().hookTrust ?? requested?.hookTrust ?? current.hookTrust;
  if (target === current.executor && hookTrust === current.hookTrust && current.client.connected) return;
  const changing = target !== current.executor;
  const bounded = async <T,>(promise: Promise<T>, stage: string, timeout = 15000): Promise<T> => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try { return await Promise.race([promise, new Promise<T>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`executor_switch_timeout:${stage}`)), timeout);
    })]); } finally { if (timer) clearTimeout(timer); }
  };
  let handoff = current.handoff;
  if (changing && current.threadId) {
    const recent = localExecutorHandoff(current.executor, current.threadId, options.dataDir, args.sessionId);
    if (recent) handoff = recent;
    else if (!handoff) {
      const previous = await bounded(current.client.request('thread/read', { threadId: current.threadId, includeTurns: true }), 'old_thread_read', 5000);
      handoff = executorHandoff(previous?.thread);
    }
  }
  const candidate = new AppServerClient(target === 'traex' ? args.traexBin : args.codexBin, args.cwd, modelExecutorEnv(target));
  try {
    await bounded(candidate.initialize(), 'initialize');
    const response = await bounded(candidate.request('config/read', { cwd: args.cwd }), 'config_read');
    const defaults = response?.config ?? {};
    const model = requested?.model ?? defaults.model;
    const resume = !changing && !!current.threadId;
    const started = await bounded(candidate.request(resume ? 'thread/resume' : 'thread/start', {
      ...(resume ? { threadId: current.threadId } : {}), cwd: args.cwd, model, modelProvider: defaults.model_provider,
      approvalPolicy: 'never', sandbox: 'danger-full-access',
      config: { shell_environment_policy: { inherit: 'all' }, bypass_hook_trust: hookTrust === 'always' },
      serviceTier: requested?.serviceTier ?? 'default', developerInstructions: options.instructions(), ephemeral: false,
    }), resume ? 'thread_resume' : 'thread_start');
    if (resume && started.thread?.id !== current.threadId) throw new Error('executor_thread_mismatch');
    if (!started.thread?.id || (started.model && model && started.model !== model)) throw new Error('executor_model_mismatch');
    const threadId = String(started.thread.id);
    writeSessionExecutor(options.dataDir, { sessionId: args.sessionId, executor: target, threadId, handoff, hookTrust });
    options.activate({ client: candidate, executor: target, hookTrust, threadId, handoff, defaults });
    current.client.close();
  } catch (error) { candidate.close(); throw error; }
}
