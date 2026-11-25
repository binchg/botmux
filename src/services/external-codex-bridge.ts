import { readFileSync, statSync, openSync, readSync, closeSync, existsSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { atomicWriteFileSync } from '../utils/atomic-write.js';
import { publicCodexEvent, codexSyncEventKey } from './codex-sync-events.js';
import { jsonlFrontierAnchor } from './jsonl-cursor.js';
import { splitMobileReply } from './mobile-reply.js';

export type ExternalCodexOutputKind = 'user' | 'progress' | 'tool' | 'final';

export interface ExternalCodexBinding {
  threadId: string;
  rolloutPath: string;
  cwd: string;
  chatId: string;
  larkAppId: string;
  ownerOpenId: string;
  replySenderOpenIds?: string[];
  allowGroupMembers?: boolean;
  rootMessageId: string;
  /** Output-only mirror target; never changes the thread used for inbound questions. */
  outputRootMessageId?: string;
  firstUserMessage?: string;
  currentUserMessage?: string;
}
export type FollowupCheckpoint = (submitted?: boolean, acceptedTurnId?: string) => void;

export type FollowupPhase = 'queued' | 'waiting_turn' | 'protected' | 'waiting_owner' | 'retrying' | 'sending' | 'uncertain' | 'accepted' | 'running' | 'finished' | 'aborted';

export interface FollowupCard {
  messageId: string;
  text: string;
  phase: FollowupPhase;
  checkedAt: number;
  publishedAt?: number;
  cardId?: string;
  clientId?: string;
  turnId?: string;
  retryAt?: number;
}

function setPhase(card: FollowupCard | undefined, phase: FollowupPhase): void {
  if (!card || card.phase === 'finished' || card.phase === 'aborted') return;
  card.phase = phase;
  card.checkedAt = Math.max(Date.now(), card.checkedAt + 1);
}

export class NativeOwnerUnavailable extends Error {}
export class NativeProxyPending extends Error {
  constructor(readonly phase: 'queued' | 'waiting_owner' | 'sending' | 'uncertain') { super('Stored in the 5090 process queue'); }
}

export interface ExternalCodexCursor {
  offset: number;
  carry: string;
  busy: boolean;
  outbox: Array<{ id: string; text: string; kind?: ExternalCodexOutputKind; question?: string; nextPart?: number }>;
  received: string[];
  completed?: string[];
  notBefore?: number;
  retryAfter?: number;
  queued?: Array<{ messageId: string; text: string }>;
  pending?: { messageId: string; text: string; status: 'queued' | 'started'; clientUserMessageId?: string; receiptTurnId?: string; errorNotified?: boolean };
  turnId?: string;
  eventSequence?: number;
  progressCarry?: string;
  currentUserMessage?: string;
  /** Inputs already visible in Lark must not echo back from the rollout. */
  echoInputs?: string[];
  eventKeys?: string[];
  frontierAnchor?: string;
  inode?: number;
  deliveryBlockedRoot?: string;
  followupCards?: Record<string, FollowupCard>;
  lastEndedTurn?: { id: string; phase: 'finished' | 'aborted' };
}
export function consumeExternalCodex(state: ExternalCodexCursor, text: string): void {
  const lines = (state.carry + text).split('\n');
  state.carry = lines.pop()!;
  const seen = new Set(state.eventKeys ?? []);
  for (const line of lines) {
    if (!line.trim()) continue;
    let row: any;
    try { row = JSON.parse(line); } catch { continue; }
    const p = row.payload ?? {};
    if (row.type === 'event_msg' && p.type === 'task_started') {
      state.busy = true; state.turnId = p.turn_id ?? p.root_turn_id; state.progressCarry = '';
      for (const card of Object.values(state.followupCards ?? {})) {
        if (card.turnId && card.turnId === state.turnId) setPhase(card, 'running');
      }
    }
    const ended = row.type === 'event_msg' && (p.type === 'task_complete' || p.type === 'turn_aborted');
    if (ended) state.busy = false;
    // A receipt may arrive after the owner RPC timed out. Correlate its exact
    // client ID, never replay the input or infer delivery from matching text.
    if (state.pending?.status === 'started' && row.type === 'event_msg' && p.type === 'user_message'
      && state.pending.clientUserMessageId && p.client_id === state.pending.clientUserMessageId) {
      state.pending.receiptTurnId = state.turnId;
    }
    if (ended && state.pending?.receiptTurnId && state.pending.receiptTurnId === (p.turn_id ?? p.root_turn_id)) state.pending = undefined;
    if (row.type === 'event_msg' && p.type === 'user_message' && typeof p.client_id === 'string') {
      const card = Object.values(state.followupCards ?? {}).find(item => item.clientId === p.client_id);
      if (card) {
        card.turnId = p.turn_id ?? p.root_turn_id ?? state.turnId;
        setPhase(card, state.busy && card.turnId ? 'running' : 'accepted');
      }
    }
    if (ended) {
      const endedTurn = p.turn_id ?? p.root_turn_id;
      if (endedTurn) {
        const phase = p.type === 'turn_aborted' ? 'aborted' : 'finished';
        state.lastEndedTurn = { id: endedTurn, phase };
        for (const card of Object.values(state.followupCards ?? {})) {
          if (card.turnId === endedTurn) setPhase(card, phase);
        }
      }
    }
    const event = publicCodexEvent(row, '');
    if (!event) continue;
    const key = codexSyncEventKey(row, event, state.turnId);
    const duplicate = seen.has(key);
    if (!duplicate) { seen.add(key); (state.eventKeys ??= []).push(key); }
    const historical = state.notBefore && typeof row.timestamp === 'string' && Date.parse(row.timestamp) < state.notBefore;
    if (duplicate || historical) continue;
    let part = 0;
    const enqueue = (kind: ExternalCodexOutputKind, text: string, id = `${key}:${part++}`) => {
      if (!text.trim()) return;
      if (!state.completed?.includes(id) && !state.outbox.some(o => o.id === id)) state.outbox.push({ id, text, kind, question: state.currentUserMessage });
    };
    if (event.kind === 'user') {
      state.currentUserMessage = event.text;
      const echo = state.echoInputs?.indexOf(event.text.trim()) ?? -1;
      if (echo >= 0) state.echoInputs!.splice(echo, 1);
      else enqueue('user', event.text);
    }
    if (event.kind === 'progress') {
      // A commentary record is one public update, matching normal Botmux replies.
      // Preserve a legacy partial update once when upgrading persisted cursors.
      const progress = (state.progressCarry ?? '') + event.text;
      state.progressCarry = '';
      if (progress.trim()) enqueue('progress', progress);
    }
    if (ended) {
      if (state.progressCarry?.trim()) enqueue('progress', state.progressCarry.trim());
      state.progressCarry = '';
    }
    if (event.kind === 'final') {
      const id = p.turn_id ?? p.root_turn_id;
      if (typeof id === 'string') enqueue('final', event.text, id);
    }
  }
}

export class ExternalCodexBridge {
  private running = false;
  private submitting = new Set<string>();
  private publishing = new Set<string>();
  private timer?: NodeJS.Timeout;
  private states = new Map<string, ExternalCodexCursor>();
  constructor(private bindings: ExternalCodexBinding[], private stateFile: string, private deps: {
    reply: (binding: ExternalCodexBinding, text: string, uuid: string, kind?: ExternalCodexOutputKind) => Promise<unknown>;
    received?: (binding: ExternalCodexBinding, messageId: string, text: string) => Promise<unknown>;
    isProtected?: (binding: ExternalCodexBinding) => boolean;
    status?: (binding: ExternalCodexBinding, card: Readonly<FollowupCard>) => Promise<string | undefined>;
    turn: (binding: ExternalCodexBinding, text: string, checkpoint: FollowupCheckpoint, clientUserMessageId?: string) => Promise<void>;
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
      if (!saved[b.threadId] && initialOffsets?.[b.threadId] !== undefined) {
        consumeExternalCodex(state, Buffer.from(existing).subarray(0, initialOffsets[b.threadId]).toString('utf8'));
        state.outbox = []; state.carry = ''; state.progressCarry = '';
      }
      if (!saved[b.threadId] && initialOffsets?.[b.threadId] === undefined) {
        consumeExternalCodex(state, existing);
        state.outbox = [];
        state.carry = '';
        // Leave an incomplete final line for the next tick.
        state.offset = Buffer.byteLength(existing.slice(0, existing.lastIndexOf('\n') + 1));
      }
      if (!state.eventKeys) {
        // Upgrade legacy cursors by seeding dedup from the already-read prefix.
        // No historical output is posted, and no source record is rewritten.
        const prefix = Buffer.from(existing).subarray(0, state.offset).toString('utf8');
        const seed: ExternalCodexCursor = { offset: 0, carry: '', busy: false, outbox: [], received: [] };
        consumeExternalCodex(seed, prefix);
        state.eventKeys = seed.eventKeys ?? [];
        state.turnId ??= seed.turnId;
      }
      // Existing cursors predate question titles. Recover only their latest
      // visible user input; never replay old messages or submit model input.
      if (!state.currentUserMessage) {
        const prefix = Buffer.from(existing).subarray(0, state.offset).toString('utf8').split('\n');
        for (let i = prefix.length - 1; i >= 0; i--) {
          let row: any;
          try { row = JSON.parse(prefix[i]); } catch { continue; }
          const event = publicCodexEvent(row, '');
          if (event?.kind === 'user') { state.currentUserMessage = event.text; break; }
        }
      }
      if (state.pending?.status === 'started' && state.pending.clientUserMessageId) {
        const seed: ExternalCodexCursor = { offset: 0, carry: '', busy: false, outbox: [], received: [], pending: { ...state.pending } };
        consumeExternalCodex(seed, Buffer.from(existing).subarray(0, state.offset).toString('utf8'));
        state.pending = seed.pending;
      }
      if (this.deps.status) {
        const current = state.pending;
        for (const input of [...(current ? [current] : []), ...(state.queued ?? [])]) {
          const phase = current?.messageId === input.messageId && current.status === 'started' ? 'uncertain' : 'queued';
          (state.followupCards ??= {})[input.messageId] ??= { messageId: input.messageId, text: input.text,
            phase, checkedAt: Date.now(), clientId: current?.messageId === input.messageId ? current.clientUserMessageId : undefined };
        }
        for (const card of Object.values(state.followupCards ?? {})) {
          if (card.phase === 'sending') setPhase(card, 'uncertain');
          if (card.phase === 'uncertain' && card.turnId && state.busy && state.turnId === card.turnId) setPhase(card, 'running');
        }
      }
      const st = statSync(b.rolloutPath);
      state.frontierAnchor ??= jsonlFrontierAnchor(b.rolloutPath, state.offset);
      state.inode ??= st.ino;
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
  followupStatus(rootId: string, appId: string) {
    const b = this.bindings.find(b => b.rootMessageId === rootId && b.larkAppId === appId);
    const state = b && this.states.get(b.threadId);
    if (!state) return undefined;
    const pending = state.pending;
    const relevant = (pending && state.followupCards?.[pending.messageId]) ??
      Object.values(state.followupCards ?? {}).find(card => ['accepted', 'sending', 'uncertain'].includes(card.phase));
    return {
      phase: relevant?.phase ?? (pending ? 'queued' : state.busy ? 'running' : 'idle'),
      queued: (state.queued?.length ?? 0) + (pending?.status === 'queued' ? 1 : 0),
      running: state.busy,
      checkedAt: relevant?.checkedAt,
    };
  }
  hasReceived(rootId: string, appId: string, messageId: string): boolean {
    const b = this.bindings.find(b => b.rootMessageId === rootId && b.larkAppId === appId);
    return !!b && !!this.states.get(b.threadId)?.received.includes(messageId);
  }
  async receive(rootId: string, appId: string, sender: string, messageId: string, text: string): Promise<boolean> {
    const b = this.bindings.find(b => b.rootMessageId === rootId && b.larkAppId === appId);
    if (!b) return false;
    if (sender !== b.ownerOpenId && !b.replySenderOpenIds?.includes(sender)
        && !(b.allowGroupMembers && sender.startsWith('ou_'))) return true;
    const state = this.states.get(b.threadId)!;
    if (state.received.includes(messageId)) return true;
    state.received.push(messageId);
    (state.echoInputs ??= []).push(text.trim());
    if (state.pending) (state.queued ??= []).push({ messageId, text });
    else state.pending = { messageId, text, status: 'queued' };
    if (this.deps.status) (state.followupCards ??= {})[messageId] = {
      messageId, text, phase: 'queued', checkedAt: Date.now(),
    };
    this.save();
    if (this.deps.received) {
      try { await this.deps.received(b, messageId, text); }
      catch (error) { this.deps.error(error); }
    }
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
        const st = statSync(b.rolloutPath), size = st.size;
        if (size < state.offset || state.inode !== st.ino || jsonlFrontierAnchor(b.rolloutPath, state.offset) !== state.frontierAnchor) {
          // Codex rewrites canonical history on resume. Rebuild lifecycle from
          // the log; stable event keys keep previously delivered output silent.
          state.offset = 0; state.carry = ''; state.busy = false; state.turnId = undefined; state.progressCarry = '';
        }
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
            state.frontierAnchor = jsonlFrontierAnchor(b.rolloutPath, state.offset); state.inode = st.ino;
            this.save();
          }
        }
        const protectedSource = this.deps.isProtected?.(b) === true;
        for (const input of [...(state.pending?.status === 'queued' ? [state.pending] : []), ...(state.queued ?? [])]) {
          const card = state.followupCards?.[input.messageId];
          if (!card) continue;
          const phase = protectedSource ? 'protected' : state.busy ? 'waiting_turn' :
            card.phase === 'waiting_turn' || card.phase === 'protected' ? 'queued' : card.phase;
          if (phase !== card.phase) setPhase(card, phase);
        }
        for (const card of Object.values(state.followupCards ?? {})) {
          if (this.deps.status && !this.publishing.has(card.messageId) && (card.retryAt ?? 0) <= Date.now()
              && (!card.cardId || card.checkedAt > (card.publishedAt ?? 0))) {
            const snapshot = { ...card };
            this.publishing.add(card.messageId);
            dispatches.push(async () => {
              try {
                const cardId = await this.deps.status!(b, snapshot);
                if (!cardId) return;
                card.cardId = cardId;
                card.publishedAt = snapshot.checkedAt;
                if (card.phase === snapshot.phase && ['finished', 'aborted'].includes(card.phase)) delete state.followupCards![card.messageId];
              } catch (error) {
                if ((error as Error)?.name === 'MessageWithdrawnError') {
                  delete state.followupCards![card.messageId];
                } else {
                  card.retryAt = Date.now() + 60_000;
                  this.deps.error(error);
                }
              } finally {
                this.publishing.delete(card.messageId);
                this.save();
              }
            });
          }
        }
        const outputRoot = b.outputRootMessageId ?? b.rootMessageId;
        if (state.deliveryBlockedRoot && state.deliveryBlockedRoot !== outputRoot) delete state.deliveryBlockedRoot;
        while (state.outbox.length && state.deliveryBlockedRoot !== outputRoot) {
          const item = state.outbox[0];
          // An upgrade may restore tool notifications queued by an older build.
          // Keep tool events for local inspection/statistics, never post them to IM.
          if (item.kind === 'tool' || !item.text.trim()) {
            state.outbox.shift();
            this.save();
            continue;
          }
          const parts = item.kind === 'user' ? [item.text] : splitMobileReply(item.text);
          try {
            for (let part = item.nextPart ?? 0; part < parts.length; part++) {
              // Keep the original first-card UUID, including retries after an upgrade.
              const id = part === 0 ? item.id : `${item.id}:mobile-part:${part}`;
              const uuid = createHash('sha256').update(`${b.threadId}:${outputRoot}:${id}`).digest('hex').slice(0, 32);
              await this.deps.reply({ ...b, currentUserMessage: item.question ?? state.currentUserMessage ?? b.firstUserMessage }, parts[part], uuid, item.kind);
              item.nextPart = part + 1;
              this.save();
            }
          } catch (error) {
            if ((error as Error)?.name === 'MessageWithdrawnError') { state.deliveryBlockedRoot = outputRoot; this.save(); }
            throw error;
          }
          (state.completed ??= []).push(item.id);
          state.outbox.shift();
          this.save();
        }
        if (!state.pending && state.queued?.length) {
          state.pending = { ...state.queued.shift()!, status: 'queued' };
          this.save();
        }
        if (!protectedSource && state.pending?.status === 'queued' && !state.busy && !this.submitting.has(b.threadId)
            && (!state.retryAfter || Date.now() >= state.retryAfter)) {
          const pending = state.pending;
          pending.clientUserMessageId ??= randomUUID();
          const card = state.followupCards?.[pending.messageId];
          if (card) card.clientId = pending.clientUserMessageId;
          this.save();
          // Persist at the turn/start boundary; an uncertain started input is
          // retained for inspection after a crash, never blindly resubmitted.
          this.submitting.add(b.threadId);
          dispatches.push(async () => {
            try {
              await this.deps.turn(b, pending.text, (submitted = true, acceptedTurnId) => {
                pending.status = submitted ? 'started' : 'queued';
                if (submitted) {
                  delete state.retryAfter;
                  if (acceptedTurnId && card) {
                    card.turnId = acceptedTurnId;
                    const completed = state.lastEndedTurn;
                    setPhase(card, completed?.id === acceptedTurnId ? completed.phase :
                      state.busy && state.turnId === acceptedTurnId ? 'running' : 'accepted');
                  } else setPhase(card, 'sending');
                }
                this.save();
              }, pending.clientUserMessageId);
              if (card?.phase === 'sending') setPhase(card, 'accepted');
              if (state.pending === pending) state.pending = undefined;
              this.save();
            } catch (error) {
              if (pending.status === 'queued') state.retryAfter = Date.now() + 15_000;
              if (card) {
                const phase = pending.status === 'started' ? 'uncertain' :
                  error instanceof NativeProxyPending ? error.phase :
                  error instanceof NativeOwnerUnavailable ? 'waiting_owner' : 'retrying';
                if (card.phase !== 'running' && (card.phase !== phase || Date.now() - card.checkedAt >= 60_000)) setPhase(card, phase);
                this.save();
              }
              if (!this.deps.status && state.pending === pending && !pending.errorNotified) {
                pending.errorNotified = true;
                state.outbox.push({ id: `delivery-status:${pending.messageId}`, kind: 'progress', question: pending.text,
                  text: pending.status === 'started' ? '原生窗口尚未确认接收，追问已保留；确认结果前不会重复提交。' : '原生窗口暂未就绪，追问已保留，正在等待原会话。' });
                this.save();
              }
              if (!(error instanceof NativeProxyPending)) throw error;
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
