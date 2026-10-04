/** 会话独立的期望配置和运行回执；不改 Codex 全局配置，不保存对话正文。 */
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { atomicWriteFileSync } from '../utils/atomic-write.js';

export interface ModelSelection {
  executor?: 'codex-app' | 'traex';
  hookTrust?: 'always' | 'review';
  model: string;
  effort: string;
  serviceTier?: string;
}
export interface SessionModelRequest extends ModelSelection {
  sessionId: string;
  revision: string;
  updatedAt: string;
}
export interface SessionModelRuntime {
  sessionId: string;
  protocol: 1 | 2 | 3;
  pid: number;
  threadId?: string;
  phase: 'ready' | 'running' | 'completed' | 'failed';
  revision?: string;
  selection?: ModelSelection;
  turnId?: string;
  updatedAt: string;
}
function filename(dir: string, id: string, kind: string): string {
  if (!id || id.length > 200) throw new Error('invalid_session_id');
  return join(dir, 'session-models', createHash('sha256').update(id).digest('hex') + '.' + kind + '.json');
}
function read<T>(dir: string, id: string, kind: string): T | undefined {
  const file = filename(dir, id, kind);
  if (!existsSync(file)) return undefined;
  const value = JSON.parse(readFileSync(file, 'utf8'));
  if (value.sessionId !== id) throw new Error('session_model_identity_mismatch');
  return value;
}
function write(dir: string, id: string, kind: string, value: unknown): void {
  mkdirSync(join(dir, 'session-models'), { recursive: true, mode: 0o700 });
  atomicWriteFileSync(filename(dir, id, kind), JSON.stringify(value, null, 2), { mode: 0o600 });
}
export const readSessionModel = (dir: string, id: string) => read<SessionModelRequest>(dir, id, 'desired');
export const readSessionModelRuntime = (dir: string, id: string) => read<SessionModelRuntime>(dir, id, 'runtime');
export function writeSessionModel(dir: string, sessionId: string, selection: ModelSelection): SessionModelRequest {
  const previous = readSessionModel(dir, sessionId);
  if (previous && previous.model === selection.model && previous.effort === selection.effort && previous.serviceTier === selection.serviceTier && previous.executor === selection.executor && previous.hookTrust === selection.hookTrust) return previous;
  const value = { ...selection, sessionId, revision: randomUUID(), updatedAt: new Date().toISOString() };
  write(dir, sessionId, 'desired', value);
  return value;
}
export function writeSessionModelRuntime(dir: string, value: Omit<SessionModelRuntime, 'updatedAt' | 'protocol'>): void {
  write(dir, value.sessionId, 'runtime', { ...value, protocol: 3, updatedAt: new Date().toISOString() });
}
export function modelRuntimeAlive(runtime?: SessionModelRuntime): boolean {
  if (!runtime || ![1, 2, 3].includes(runtime.protocol) || !Number.isInteger(runtime.pid) || runtime.pid < 1) return false;
  try { process.kill(runtime.pid, 0); return true; } catch { return false; }
}
export function sessionModelStatus(dir: string, sessionId: string) {
  const desired = readSessionModel(dir, sessionId), runtime = readSessionModelRuntime(dir, sessionId);
  const alive = modelRuntimeAlive(runtime), accepted = alive && !!desired && runtime?.revision === desired.revision;
  return { desired: desired ?? null, runtime: runtime ?? null, runnerAlive: alive,
    status: !desired ? 'default' : !alive || (!!desired.executor && (runtime?.protocol ?? 0) < 2) || (!!desired.hookTrust && (runtime?.protocol ?? 0) < 3) ? 'pending_runner_reload' : !accepted ? 'pending_next_turn'
      : runtime?.phase === 'completed' ? 'verified' : runtime?.phase === 'failed' ? 'failed' : 'accepted' };
}

export interface SessionExecutorState {
  sessionId: string;
  executor: 'codex-app' | 'traex';
  threadId: string;
  handoff?: string;
  hookTrust?: 'always' | 'review';
}
export const readSessionExecutor = (dir: string, id: string) => read<SessionExecutorState>(dir, id, 'executor');
export const writeSessionExecutor = (dir: string, value: SessionExecutorState) => write(dir, value.sessionId, 'executor', value);
