export interface CodexAppProgressCardOperations {
  post: (cardJson: string, turnId: string) => Promise<string>;
  patch: (messageId: string, cardJson: string) => Promise<void>;
  remove: (messageId: string) => Promise<unknown>;
  canRepostAfterPatchFailure?: (error: unknown) => boolean;
  onStateChange?: (state: CodexAppProgressCardState) => void;
}

export interface CodexAppProgressCardState {
  turnId?: string;
  messageId?: string;
}

/** Maintains exactly one mutable Lark progress message for a Codex App turn.
 * Operations are serialized so two rapid app-server notifications cannot both
 * POST a card before either one records its message id. */
export class CodexAppProgressCard {
  private turnId?: string;
  private messageId?: string;
  private chain: Promise<void> = Promise.resolve();

  constructor(
    private readonly operations: CodexAppProgressCardOperations,
    initialState: CodexAppProgressCardState = {},
  ) {
    this.turnId = initialState.turnId;
    this.messageId = initialState.messageId;
  }

  upsert(turnId: string, cardJson: string): Promise<void> {
    return this.enqueue(async () => {
      if (this.messageId) {
        try {
          await this.operations.patch(this.messageId, cardJson);
          this.setState(turnId, this.messageId);
          return;
        } catch (error) {
          // A recalled/expired card is recreated below. The new message id
          // becomes the sole update target for subsequent snapshots.
          if (!this.operations.canRepostAfterPatchFailure?.(error)) throw error;
          this.setState(undefined, undefined);
        }
      }
      const messageId = await this.operations.post(cardJson, turnId);
      this.setState(turnId, messageId);
    });
  }

  /** Detach the previous user turn from its mutable progress card.
   *
   * A daemon/app-server restart may change the protocol turn id while the
   * same Lark user turn is still running, so `upsert()` deliberately keeps
   * patching the restored card across id changes. The daemon is the only
   * layer that knows when a genuinely new Lark user turn begins; it calls
   * this method before forwarding that prompt so the next progress update is
   * POSTed as a new reply instead of silently PATCHing an older message.
   */
  beginTurn(): Promise<void> {
    return this.enqueue(async () => {
      this.setState(undefined, undefined);
    });
  }

  finish(turnId: string, completedCardJson: string): Promise<void> {
    return this.enqueue(async () => {
      if (this.turnId !== turnId || !this.messageId) return;
      const messageId = this.messageId;
      try {
        await this.operations.remove(messageId);
      } catch {
        // If withdrawal is unavailable, at least remove the stale "running"
        // semantics from the existing card.
        try { await this.operations.patch(messageId, completedCardJson); } catch { /* best effort */ }
      }
      this.setState(undefined, undefined);
    });
  }

  private setState(turnId: string | undefined, messageId: string | undefined): void {
    if (this.turnId === turnId && this.messageId === messageId) return;
    this.turnId = turnId;
    this.messageId = messageId;
    this.operations.onStateChange?.({ turnId, messageId });
  }

  private enqueue(operation: () => Promise<void>): Promise<void> {
    const next = this.chain.then(operation, operation);
    this.chain = next.catch(() => {});
    return next;
  }
}
