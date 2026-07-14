import { describe, expect, it, vi } from 'vitest';
import { CodexAppProgressCard } from '../src/services/codex-app-progress-card.js';

describe('Codex App single progress card', () => {
  it('posts once then patches the same message for later progress', async () => {
    const post = vi.fn(async () => 'om_progress');
    const patch = vi.fn(async () => {});
    const remove = vi.fn(async () => {});
    const card = new CodexAppProgressCard({ post, patch, remove });

    await Promise.all([
      card.upsert('turn-1', 'first'),
      card.upsert('turn-1', 'second'),
      card.upsert('turn-1', 'third'),
    ]);

    expect(post).toHaveBeenCalledTimes(1);
    expect(patch).toHaveBeenNthCalledWith(1, 'om_progress', 'second');
    expect(patch).toHaveBeenNthCalledWith(2, 'om_progress', 'third');
  });

  it('withdraws the temporary card after the final answer succeeds', async () => {
    const remove = vi.fn(async () => {});
    const card = new CodexAppProgressCard({
      post: vi.fn(async () => 'om_progress'),
      patch: vi.fn(async () => {}),
      remove,
    });
    await card.upsert('turn-1', 'running');
    await card.finish('turn-1', 'completed');
    expect(remove).toHaveBeenCalledWith('om_progress');
  });

  it('patches the card to completed if withdrawal fails', async () => {
    const patch = vi.fn(async () => {});
    const card = new CodexAppProgressCard({
      post: vi.fn(async () => 'om_progress'),
      patch,
      remove: vi.fn(async () => { throw new Error('withdraw unavailable'); }),
    });
    await card.upsert('turn-1', 'running');
    await card.finish('turn-1', 'completed');
    expect(patch).toHaveBeenCalledWith('om_progress', 'completed');
  });

  it('reposts if the prior progress card can no longer be patched', async () => {
    const post = vi.fn()
      .mockResolvedValueOnce('om_old')
      .mockResolvedValueOnce('om_new');
    const card = new CodexAppProgressCard({
      post,
      patch: vi.fn(async () => { throw new Error('message recalled'); }),
      remove: vi.fn(async () => {}),
      canRepostAfterPatchFailure: () => true,
    });
    await card.upsert('turn-1', 'first');
    await card.upsert('turn-1', 'latest');
    expect(post).toHaveBeenCalledTimes(2);
  });

  it('keeps the same update target on a transient patch failure', async () => {
    const post = vi.fn(async () => 'om_progress');
    const patch = vi.fn()
      .mockRejectedValueOnce(new Error('temporary network error'))
      .mockResolvedValueOnce(undefined);
    const card = new CodexAppProgressCard({ post, patch, remove: vi.fn(async () => {}) });
    await card.upsert('turn-1', 'first');
    await expect(card.upsert('turn-1', 'second')).rejects.toThrow('temporary network error');
    await card.upsert('turn-1', 'third');
    expect(post).toHaveBeenCalledTimes(1);
    expect(patch).toHaveBeenLastCalledWith('om_progress', 'third');
  });
});
