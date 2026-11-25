import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { atomicWriteFileSync } from '../utils/atomic-write.js';
import { readCodexSyncEvents } from './codex-sync-reader.js';
import { submitToOriginalCodexDaemon } from './codex-original-daemon.js';

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
  private readonly retryAt = new Map<string, number>();

  constructor(readonly threads: ProxyThread[], private readonly statePath: string,
    private readonly submit = submitToOriginalCodexDaemon) {
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
    if (phase === 'finished' || phase === 'aborted') delete entry.text;
    this.save();
  }

  receipt(threadId: string, requestId: string) {
    const entry = this.records.find(record => record.threadId === threadId && record.requestId === requestId);
    return entry ? { status: 'accepted', phase: entry.phase, turnId: entry.turnId, checkedAt: entry.checkedAt } : { status: 'missing' };
  }

  enqueue(threadId: string, requestId: string, text: string) {
    const fingerprint = createHash('sha256').update(text).digest('hex');
    const existing = this.records.find(entry => entry.threadId === threadId && entry.requestId === requestId);
    if (existing) {
      if (existing.fingerprint !== fingerprint) return { conflict: true };
    } else {
      this.records.push({ threadId, requestId, text, fingerprint, phase: 'queued', checkedAt: Date.now() });
      this.save();
    }
    return { ok: true, ...this.receipt(threadId, requestId) };
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
    if ((this.retryAt.get(thread.threadId) ?? 0) > Date.now()) return;
    this.retryAt.set(thread.threadId, Date.now() + 5000);
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
    const current = entries.find(entry => ['running', 'sending', 'uncertain'].includes(entry.phase));
    if (current) {
      if (current.phase === 'uncertain' && !current.turnId) this.reconcileUncertain(thread, current);
      if (current.turnId) {
        const { events } = readCodexSyncEvents(thread.rolloutPath);
        const ended = events.find(event => event.id.startsWith(`${current.turnId}:`) &&
          (event.kind === 'final' || (event.kind === 'status' && /本轮完成|已中断/.test(event.text))));
        if (ended) this.update(current, ended.text === '已中断' && ended.kind === 'status' ? 'aborted' : 'finished');
      }
      return;
    }
    if ((this.retryAt.get(id) ?? 0) > Date.now()) return;
    const queued = entries.find(entry => entry.phase === 'queued' || entry.phase === 'waiting_owner');
    if (!queued?.text) return;
    this.dispatching.add(id);
    try {
      const accepted = await this.submit(thread.codexHome, id, thread.rolloutPath, queued.text, (_, turnId) => {
        this.update(queued, turnId ? 'running' : 'sending', turnId);
      }, queued.requestId);
      if (!accepted) {
        this.retryAt.set(id, Date.now() + 5000);
        this.update(queued, 'waiting_owner');
      }
    } catch (error) {
      if (!queued.turnId) {
        this.retryAt.set(id, Date.now() + 5000);
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
