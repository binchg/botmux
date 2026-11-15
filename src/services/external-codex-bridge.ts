import { readFileSync, statSync, openSync, readSync, closeSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { atomicWriteFileSync } from '../utils/atomic-write.js';
import { selectCodexAppProgressChunk } from './codex-app-progress.js';
import { publicCodexToolEvent } from './codex-sync-events.js';

export type ExternalCodexOutputKind = 'user' | 'progress' | 'tool' | 'final';

export interface ExternalCodexBinding {
  threadId: string;
  rolloutPath: string;
  cwd: string;
  chatId: string;
  larkAppId: string;
  ownerOpenId: string;
  rootMessageId: string;
  firstUserMessage?: string;
}
export interface ExternalCodexCursor {
  offset: number;
  carry: string;
  busy: boolean;
  outbox: Array<{ id: string; text: string; kind?: ExternalCodexOutputKind }>;
  received: string[];
  completed?: string[];
  notBefore?: number;
  queued?: Array<{ messageId: string; text: string }>;
  pending?: { messageId: string; text: string; status: 'queued' | 'started' };
  turnId?: string;
  eventSequence?: number;
  progressCarry?: string;
  /** Inputs already visible in Lark must not echo back from the rollout. */
  echoInputs?: string[];
}
export function consumeExternalCodex(state: ExternalCodexCursor, text: string): void {
  const lines = (state.carry + text).split('\n');
  state.carry = lines.pop()!;
  for (const line of lines) {
    if (!line.trim()) continue;
    const row = JSON.parse(line);
    if (state.notBefore && typeof row.timestamp === 'string' && Date.parse(row.timestamp) < state.notBefore) continue;
    const p = row.payload ?? {};
    const enqueue = (kind: ExternalCodexOutputKind, text: string) => {
      const sequence = state.eventSequence = (state.eventSequence ?? 0) + 1;
      state.outbox.push({ id: `${state.turnId ?? 'event'}:${kind}:${sequence}`, text, kind });
    };
    const tool = publicCodexToolEvent(row);
    if (tool) enqueue('tool', tool);
    if (row.type !== 'event_msg') continue;
    if (p.type === 'task_started') {
      state.busy = true;
      state.turnId = p.turn_id ?? p.root_turn_id;
      state.progressCarry = '';
    }
    if (p.type === 'user_message' && typeof p.message === 'string') {
      const echo = state.echoInputs?.indexOf(p.message.trim()) ?? -1;
      if (echo >= 0) state.echoInputs!.splice(echo, 1);
      else enqueue('user', p.message);
    }
    if (p.type === 'agent_message' && p.phase === 'commentary' && typeof p.message === 'string') {
      state.progressCarry = (state.progressCarry ?? '') + p.message;
      // Exactly the same sentence/chunk selector used by native Botmux cards.
      let chunk;
      while ((chunk = selectCodexAppProgressChunk(state.progressCarry, 240, false))) {
        enqueue('progress', chunk.content);
        state.progressCarry = state.progressCarry.slice(chunk.consumedChars);
      }
    }
    if (p.type === 'task_complete' || p.type === 'turn_aborted') state.busy = false;
    if (p.type === 'task_complete' || p.type === 'turn_aborted') {
      if (state.progressCarry?.trim()) enqueue('progress', state.progressCarry.trim());
      state.progressCarry = '';
    }
    // Completion is authoritative; response_item/item_completed contain copies.
    if (p.type === 'task_complete' && p.last_agent_message) {
      const id = p.turn_id ?? p.root_turn_id;
      if (typeof id === 'string' && !state.completed?.includes(id) && !state.outbox.some(x => x.id === id)) {
        state.outbox.push({ id, text: String(p.last_agent_message), kind: 'final' });
      }
    }
  }
}

export class ExternalCodexBridge {
  private running = false;
  private submitting = new Set<string>();
  private timer?: NodeJS.Timeout;
  private states = new Map<string, ExternalCodexCursor>();
  constructor(private bindings: ExternalCodexBinding[], private stateFile: string, private deps: {
    reply: (binding: ExternalCodexBinding, text: string, uuid: string, kind?: ExternalCodexOutputKind) => Promise<unknown>;
    turn: (binding: ExternalCodexBinding, text: string, checkpoint: () => void) => Promise<void>;
    error: (error: unknown) => void;
  }, initialOffsets?: Record<string, number>, notBefore?: number) {
    const saved = existsSync(stateFile) ? JSON.parse(readFileSync(stateFile, 'utf8')) : {};
    for (const b of bindings) {
      const existing = readFileSync(b.rolloutPath, 'utf8');
      const first = JSON.parse(existing.split('\n')[0]);
      if (first.type !== 'session_meta' || first.payload.id !== b.threadId) throw new Error('External Codex binding metadata mismatch');
      // New bindings start at EOF. Never replay imported archives into Lark.
      const state: ExternalCodexCursor = saved[b.threadId] ?? {
        offset: initialOffsets?.[b.threadId] ?? statSync(b.rolloutPath).size, carry: '', busy: false, outbox: [], received: [], notBefore,
        echoInputs: initialOffsets?.[b.threadId] !== undefined && b.firstUserMessage ? [b.firstUserMessage.trim()] : [],
      };
      if (!saved[b.threadId] && initialOffsets?.[b.threadId] === undefined) {
        consumeExternalCodex(state, existing);
        state.outbox = [];
        state.carry = '';
        // Leave an incomplete final line for the next tick.
        state.offset = Buffer.byteLength(existing.slice(0, existing.lastIndexOf('\n') + 1));
      }
      this.states.set(b.threadId, state);
    }
    this.save();
  }
  private save(): void {
    atomicWriteFileSync(this.stateFile, JSON.stringify(Object.fromEntries(this.states), null, 2), { mode: 0o600 });
  }
  owns(rootId: string, appId: string): boolean {
    return this.bindings.some(b => b.rootMessageId === rootId && b.larkAppId === appId);
  }
  isBusy(rootId: string, appId: string): boolean {
    const b = this.bindings.find(b => b.rootMessageId === rootId && b.larkAppId === appId);
    return !!b && (!!this.states.get(b.threadId)?.busy || this.submitting.has(b.threadId));
  }
  async receive(rootId: string, appId: string, sender: string, messageId: string, text: string): Promise<boolean> {
    const b = this.bindings.find(b => b.rootMessageId === rootId && b.larkAppId === appId);
    if (!b) return false;
    if (sender !== b.ownerOpenId) return true;
    const state = this.states.get(b.threadId)!;
    if (state.received.includes(messageId)) return true;
    state.received.push(messageId);
    (state.echoInputs ??= []).push(text.trim());
    if (state.pending) (state.queued ??= []).push({ messageId, text });
    else state.pending = { messageId, text, status: 'queued' };
    this.save();
    return true;
  }
  start(): void {
    this.timer = setInterval(() => { void this.tick().catch(this.deps.error); }, 1000);
    this.timer.unref();
  }
  stop(): void { if (this.timer) clearInterval(this.timer); }
  async tick(): Promise<void> {
    if (this.running) return;
    this.running = true;
    const dispatches: Array<() => Promise<void>> = [];
    try {
      for (const b of this.bindings) {
        const state = this.states.get(b.threadId)!;
        const size = statSync(b.rolloutPath).size;
        if (size < state.offset) throw new Error('External Codex rollout truncated; refusing replay');
        if (size > state.offset) {
          const fd = openSync(b.rolloutPath, 'r');
          const data = Buffer.alloc(size - state.offset);
          try { readSync(fd, data, 0, data.length, state.offset); } finally { closeSync(fd); }
          // Persist only after parsing succeeds. Decode complete lines so split
          // UTF-8 characters never become replacement characters.
          const lastNewline = data.lastIndexOf(10);
          if (lastNewline >= 0) {
            consumeExternalCodex(state, data.subarray(0, lastNewline + 1).toString('utf8'));
            state.offset += lastNewline + 1;
            this.save();
          }
        }
        while (state.outbox.length) {
          const item = state.outbox[0];
          const uuid = createHash('sha256').update(`${b.threadId}:${item.id}`).digest('hex').slice(0, 32);
          await this.deps.reply(b, item.text, uuid, item.kind);
          (state.completed ??= []).push(item.id);
          state.outbox.shift();
          this.save();
        }
        if (!state.pending && state.queued?.length) {
          state.pending = { ...state.queued.shift()!, status: 'queued' };
          this.save();
        }
        if (state.pending?.status === 'queued' && !state.busy && !this.submitting.has(b.threadId)) {
          const pending = state.pending;
          // Persist at the turn/start boundary; an uncertain started input is
          // retained for inspection after a crash, never blindly resubmitted.
          this.submitting.add(b.threadId);
          dispatches.push(async () => {
            try {
              await this.deps.turn(b, pending.text, () => {
                pending.status = 'started';
                this.save();
              });
              if (state.pending === pending) state.pending = undefined;
              this.save();
            } finally { this.submitting.delete(b.threadId); }
          });
        }
      }
    } finally { this.running = false; }
    // Waiting for a long model/tool run must not hold the transcript reader's
    // lock: subsequent ticks still deliver incremental progress for this turn.
    await Promise.all(dispatches.map(dispatch => dispatch()));
  }
}
