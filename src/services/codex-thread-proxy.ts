import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { atomicWriteFileSync } from '../utils/atomic-write.js';
import { readCodexSyncEvents } from './codex-sync-reader.js';
import { submitNativeTurnToOriginalCodexDaemon, submitToOriginalCodexDaemon } from './codex-original-daemon.js';

export interface ProxyThread {
  threadId: string;
  rolloutPath: string;
  codexHome: string;
  title: string;
  cwd: string;
  bot: string;
}

type Phase = 'queued' | 'waiting_owner' | 'sending' | 'uncertain' | 'running' | 'finished' | 'aborted';
interface Receipt {
  threadId: string;
  requestId: string;
  text?: string;
  native?: Record<string, unknown>;
  nativeResult?: unknown;
  steer?: boolean;
  fingerprint: string;
  phase: Phase;
  checkedAt: number;
  turnId?: string;
}

export const validProxyRequestId = (value: unknown): value is string =>
  typeof value === 'string' && /^[\w-]{8,100}$/.test(value);

export class CodexThreadProxy {
  private readonly records: Receipt[];
  private readonly dispatching = new Set<string>();
  private readonly retryAt = new WeakMap<Receipt, number>();

  constructor(readonly threads: ProxyThread[], private readonly statePath: string,
    private readonly submit = submitToOriginalCodexDaemon,
    private readonly submitNative = submitNativeTurnToOriginalCodexDaemon) {
    this.records = existsSync(statePath) ? JSON.parse(readFileSync(statePath, 'utf8')) : [];
    // A crash after crossing the submit boundary leaves an uncertain receipt.
    // The original is never given another copy of that request automatically.
    for (const entry of this.records) if (entry.phase === 'sending') entry.phase = 'uncertain';
    this.save();
  }

  thread(id: string): ProxyThread | undefined {
    return this.threads.find(thread => thread.threadId === id);
  }

  private save(): void {
    atomicWriteFileSync(this.statePath, JSON.stringify(this.records), { mode: 0o600 });
  }

  private update(entry: Receipt, phase: Phase, turnId?: string): void {
    entry.phase = phase;
    if (turnId) entry.turnId = turnId;
    entry.checkedAt = Date.now();
    if (phase === 'finished' || phase === 'aborted') {
      delete entry.text;
      delete entry.native;
    }
    this.save();
  }

  receipt(threadId: string, requestId: string) {
    const entry = this.records.find(record => record.threadId === threadId && record.requestId === requestId);
    return entry ? { status: 'accepted', phase: entry.phase, turnId: entry.turnId,
      checkedAt: entry.checkedAt, nativeResult: entry.nativeResult } : { status: 'missing' };
  }

  private enqueueRecord(data: Omit<Receipt, 'phase' | 'checkedAt'>) {
    const existing = this.records.find(entry => entry.threadId === data.threadId && entry.requestId === data.requestId);
    if (existing) {
      if (existing.fingerprint !== data.fingerprint) return { conflict: true };
    } else {
      this.records.push({ ...data, phase: 'queued', checkedAt: Date.now() });
      this.save();
    }
    return { ok: true, ...this.receipt(data.threadId, data.requestId) };
  }

  enqueue(threadId: string, requestId: string, text: string, steer = false) {
    return this.enqueueRecord({ threadId, requestId, text, steer, fingerprint: createHash('sha256').update(text).digest('hex') });
  }

  enqueueNative(threadId: string, requestId: string, params: Record<string, unknown>) {
    const native = { ...params, threadId, clientUserMessageId: requestId };
    return this.enqueueRecord({ threadId, requestId, native,
      fingerprint: createHash('sha256').update('native:').update(JSON.stringify(native)).digest('hex') });
  }

  status(threadId: string) {
    const entries = this.records.filter(entry => entry.threadId === threadId);
    const current = entries.find(entry => ['running', 'sending', 'uncertain'].includes(entry.phase)) ??
      entries.find(entry => entry.phase === 'queued' || entry.phase === 'waiting_owner') ?? entries.at(-1);
    return {
      phase: current?.phase ?? 'idle',
      running: current?.phase === 'running',
      queued: entries.filter(entry => entry.phase === 'queued' || entry.phase === 'waiting_owner').length,
      checkedAt: current?.checkedAt,
    };
  }

  private reconcileUncertain(thread: ProxyThread, entry: Receipt): void {
    if ((this.retryAt.get(entry) ?? 0) > Date.now()) return;
    this.retryAt.set(entry, Date.now() + 5000);
    const filename = join(thread.codexHome, 'thread_history_1.sqlite');
    if (!existsSync(filename)) return;
    let db: DatabaseSync | undefined;
    try {
      db = new DatabaseSync(filename, { readOnly: true });
      const rows = db.prepare(`SELECT turn_id FROM thread_items WHERE thread_id = ?
        AND item_type = 'userMessage' AND json_extract(item_json, '$.clientId') = ? LIMIT 2`)
        .all(thread.threadId, entry.requestId);
      if (rows.length === 1 && typeof rows[0].turn_id === 'string') this.update(entry, 'running', rows[0].turn_id);
    } catch { /* The receipt stays uncertain if Codex has yet to persist its client ID. */ }
    finally { db?.close(); }
  }

  private async run(thread: ProxyThread): Promise<void> {
    const id = thread.threadId;
    if (this.dispatching.has(id)) return;
    const entries = this.records.filter(entry => entry.threadId === id);
    const current = entries.filter(entry => ['running', 'uncertain'].includes(entry.phase));
    if (current.length) {
      for (const entry of current) {
        if (entry.phase === 'uncertain' && !entry.turnId) this.reconcileUncertain(thread, entry);
      }
      const { events } = readCodexSyncEvents(thread.rolloutPath);
      for (const entry of current) {
        if (!entry.turnId) continue;
        const ended = events.find(event => event.id.startsWith(`${entry.turnId}:`) &&
          (event.kind === 'final' || (event.kind === 'status' && /本轮完成|已中断/.test(event.text))));
        if (ended) this.update(entry, ended.kind === 'status' && ended.text === '已中断' ? 'aborted' : 'finished');
      }
    }
    if (current.some(entry => entry.phase === 'uncertain')) return;
    const running = current.some(entry => entry.phase === 'running');
    const waiting = entries.filter(entry => entry.phase === 'queued' || entry.phase === 'waiting_owner');
    const queued = waiting.find(entry => entry.steer) ?? (running ? undefined : waiting[0]);
    if (!queued || (!queued.text && !queued.native)) return;
    if ((this.retryAt.get(queued) ?? 0) > Date.now()) return;
    this.dispatching.add(id);
    try {
      const checkpoint = (submitted?: boolean, turnId?: string, nativeResult?: unknown) => {
        if (turnId && nativeResult !== undefined) queued.nativeResult = nativeResult;
        this.update(queued, turnId ? 'running' : submitted === false ? 'waiting_owner' : 'sending', turnId);
      };
      const accepted = queued.native
        ? await this.submitNative(thread.codexHome, id, thread.rolloutPath, queued.native, checkpoint)
        : await this.submit(thread.codexHome, id, thread.rolloutPath, queued.text!, checkpoint, queued.requestId, queued.steer);
      if (!accepted) {
        this.retryAt.set(queued, Date.now() + (queued.steer ? 1000 : 5000));
        this.update(queued, 'waiting_owner');
      }
    } catch (error) {
      if (!queued.turnId) {
        this.retryAt.set(queued, Date.now() + 5000);
        this.update(queued, queued.phase === 'sending' ? 'uncertain' : 'waiting_owner');
      }
      // Do not log the submitted text or the downstream diagnostic payload.
      if (queued.phase === 'uncertain') console.warn(`Codex proxy awaiting an exact receipt on ${id}: ${(error as Error).name}`);
    } finally {
      this.dispatching.delete(id);
    }
  }

  async tick(): Promise<void> {
    await Promise.allSettled(this.threads.map(thread => this.run(thread)));
  }
}
