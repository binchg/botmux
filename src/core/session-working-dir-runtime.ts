import { forkWorker, killWorker } from './worker-pool.js';
import { sendInputWithSessionWorkingDir } from './session-working-dir.js';
import type { DaemonToWorker } from '../types.js';
import type { DaemonSession } from './types.js';

/** 目录切换的进程适配层：旧 worker 完全退出后才能复用同一后台会话名称。 */
async function stopWorkingDirWorker(live: DaemonSession): Promise<void> {
  const worker = live.worker;
  if (!worker || worker.killed || worker.exitCode !== null || worker.signalCode !== null) {
    killWorker(live);
    return;
  }
  await new Promise<void>((resolve, reject) => {
    const finish = () => { clearTimeout(timeout); worker.off('exit', finish); resolve(); };
    const timeout = setTimeout(() => {
      worker.off('exit', finish);
      reject(new Error('working_dir_worker_exit_timeout'));
    }, 10_000);
    worker.once('exit', finish);
    // killWorker 自带 TERM/KILL 后备；这里等待真实 exit，不使用固定 sleep 假装完成。
    killWorker(live);
  });
}

type SessionInput = Extract<DaemonToWorker, { type: 'message' }>;

/** 启动中的 worker 尚未建立输入队列；必须等本进程真实 ready，不能提前投递后假装成功。 */
function sendWorkingDirInput(live: DaemonSession, message: SessionInput): Promise<void> | void {
  const worker = live.worker;
  if (!worker) throw new Error('session_worker_unavailable');
  const assertCurrent = () => {
    if (live.worker !== worker) throw new Error('session_worker_changed');
    if (worker.killed || worker.exitCode !== null || worker.signalCode !== null) {
      throw new Error('session_worker_unavailable');
    }
  };
  assertCurrent();
  // 已就绪进程保持同步投递，避免增加输入到达顺序的额外异步窗口。
  if (live.workerPort) { worker.send(message); return; }
  return new Promise<void>((resolve, reject) => {
    const cleanup = () => {
      clearTimeout(timeout);
      worker.off('message', onReady);
      worker.off('exit', onExit);
    };
    const fail = (error: Error) => { cleanup(); reject(error); };
    const onExit = () => fail(new Error('session_worker_exited_before_ready'));
    const onReady = (event: { type?: string }) => {
      if (event?.type !== 'ready') return;
      try {
        assertCurrent();
        cleanup();
        worker.send(message);
        resolve();
      } catch (error) {
        fail(error instanceof Error ? error : new Error('session_worker_send_failed'));
      }
    };
    const timeout = setTimeout(() => fail(new Error('session_worker_ready_timeout')), 30_000);
    worker.on('message', onReady);
    worker.once('exit', onExit);
  });
}

/** 触发输入由 init 携带；后续输入等真实就绪再发送，避免启动期间丢失或重复投递。 */
export async function sendSessionInput(live: DaemonSession, message: SessionInput): Promise<void> {
  await sendInputWithSessionWorkingDir(live, message, {
    stop: stopWorkingDirWorker,
    start: (session, input) => forkWorker(session, input.content, session.hasHistory, input.turnId),
    send: sendWorkingDirInput,
  });
}
