export interface CodexAppProgressCardOperations {
  post: (cardJson: string, turnId: string) => Promise<string>;
  patch: (messageId: string, cardJson: string) => Promise<void>;
  remove: (messageId: string) => Promise<unknown>;
  canRepostAfterPatchFailure?: (error: unknown) => boolean;
}

/** Maintains exactly one mutable Lark progress message for a Codex App turn.
 * Operations are serialized so two rapid app-server notifications cannot both
 * POST a card before either one records its message id. */
export class CodexAppProgressCard {
  private turnId?: string;
  private messageId?: string;
  private chain: Promise<void> = Promise.resolve();

  constructor(private readonly operations: CodexAppProgressCardOperations) {}

  upsert(turnId: string, cardJson: string): Promise<void> {
    return this.enqueue(async () => {
      if (this.messageId) {
        try {
          await this.operations.patch(this.messageId, cardJson);
          this.turnId = turnId;
          return;
        } catch (error) {
          // A recalled/expired card is recreated below. The new message id
          // becomes the sole update target for subsequent snapshots.
          if (!this.operations.canRepostAfterPatchFailure?.(error)) throw error;
          this.messageId = undefined;
        }
      }
      this.messageId = await this.operations.post(cardJson, turnId);
      this.turnId = turnId;
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
      this.turnId = undefined;
      this.messageId = undefined;
    });
  }

  private enqueue(operation: () => Promise<void>): Promise<void> {
    const next = this.chain.then(operation, operation);
    this.chain = next.catch(() => {});
    return next;
  }
}
