/**
 * Ordering barrier for an explicit terminal `botmux send`.
 *
 * Automatic progress/final cards are emitted by the daemon while `botmux send`
 * posts directly from a child process. Without a shared barrier those two
 * channels race, so an older progress card can land after the explicit final
 * card. The daemon marks the current logical turn terminal first, waits for all
 * daemon replies that were already in flight, then lets the CLI post the final
 * card. New progress/final events observe the marker and are dropped until the
 * next inbound turn clears it.
 */

export interface TerminalSendState {
  requestId: string;
  turnId: string;
  markedAtMs: number;
  status: 'preparing' | 'committed';
  decision: Promise<'committed' | 'cancelled'>;
}

const terminalDecisionResolvers = new WeakMap<TerminalSendState, (decision: 'committed' | 'cancelled') => void>();

function settleTerminalSend(state: TerminalSendState, decision: 'committed' | 'cancelled'): void {
  terminalDecisionResolvers.get(state)?.(decision);
  terminalDecisionResolvers.delete(state);
}

export interface TerminalSendHost {
  outboundReplies?: Set<Promise<unknown>>;
  terminalSend?: TerminalSendState;
}

/**
 * Reserve one daemon-originated reply before it reaches its first async await.
 * Tracking only the final Lark API promise is insufficient: chat-scope routing
 * may await `getChatMode` first, leaving an untracked send that can cross the
 * terminal barrier later.
 */
export function beginOutboundReply(host: TerminalSendHost): { release: () => void } {
  let resolve!: () => void;
  const pending = new Promise<void>(done => { resolve = done; });
  (host.outboundReplies ??= new Set()).add(pending);
  let released = false;
  return {
    release: () => {
      if (released) return;
      released = true;
      host.outboundReplies?.delete(pending);
      resolve();
    },
  };
}

/**
 * Mark this turn terminal before waiting. The mark prevents any newly arriving
 * automatic progress/final event from entering the outbound set while the
 * already-started operations drain.
 */
export async function prepareTerminalSend(
  host: TerminalSendHost,
  input: { requestId: string; turnId: string; nowMs?: number },
): Promise<{ drained: number }> {
  // A newer terminal send supersedes an older successful/abandoned marker in
  // the same turn. Resolve old waiters conservatively as committed so a stale
  // final can never leak after the newer final card.
  if (host.terminalSend) settleTerminalSend(host.terminalSend, 'committed');
  let resolveDecision!: (decision: 'committed' | 'cancelled') => void;
  const decision = new Promise<'committed' | 'cancelled'>(resolve => { resolveDecision = resolve; });
  const state: TerminalSendState = {
    requestId: input.requestId,
    turnId: input.turnId,
    markedAtMs: input.nowMs ?? Date.now(),
    status: 'preparing',
    decision,
  };
  terminalDecisionResolvers.set(state, resolveDecision);
  host.terminalSend = state;
  const pending = [...(host.outboundReplies ?? [])];
  await Promise.allSettled(pending);
  return { drained: pending.length };
}

/** Commit only after the direct Lark card has been delivered successfully. */
export function commitTerminalSend(host: TerminalSendHost, requestId: string): boolean {
  const state = host.terminalSend;
  if (!state || state.requestId !== requestId) return false;
  state.status = 'committed';
  settleTerminalSend(state, 'committed');
  return true;
}

/** A failed direct send may release only the marker it created. */
export function cancelTerminalSend(host: TerminalSendHost, requestId: string): boolean {
  const state = host.terminalSend;
  if (!state || state.requestId !== requestId) return false;
  host.terminalSend = undefined;
  settleTerminalSend(state, 'cancelled');
  return true;
}

/** Every new inbound user turn re-enables automatic progress/final delivery. */
export function clearTerminalSend(host: TerminalSendHost): void {
  // A new user turn must not release a late final from the previous turn. If a
  // process died between card delivery and the commit IPC, conservatively keep
  // the previous turn terminal while clearing the marker for new progress.
  if (host.terminalSend) settleTerminalSend(host.terminalSend, 'committed');
  host.terminalSend = undefined;
}

export function shouldSuppressAfterTerminalSend(host: TerminalSendHost): boolean {
  return host.terminalSend !== undefined;
}

/** A final arriving during prepare waits for direct-send success/failure. */
export async function terminalSendDecision(
  host: TerminalSendHost,
): Promise<'none' | 'committed' | 'cancelled'> {
  const state = host.terminalSend;
  if (!state) return 'none';
  if (state.status === 'committed') return 'committed';
  return state.decision;
}
