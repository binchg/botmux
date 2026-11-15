import { describe, expect, it, vi } from 'vitest';
import { resumeStoredAppThread } from '../src/services/app-runner-thread-resume.js';

describe('stored conversation recovery', () => {
  it('returns the same thread and forwards resume options', async () => {
    const result = { thread: { id: 'original' } };
    const request = vi.fn().mockResolvedValue(result);
    await expect(resumeStoredAppThread(request, 'original', { excludeTurns: true })).resolves.toBe(result);
    expect(request).toHaveBeenCalledExactlyOnceWith('thread/resume', { threadId: 'original', excludeTurns: true });
  });

  it.each(['migration 1 was previously applied but has been modified', 'thread owned by another process',
    'modelProviderMismatch', 'connection closed'])('preserves the binding on %s', async message => {
    const request = vi.fn().mockRejectedValue(new Error(message));
    await expect(resumeStoredAppThread(request, 'original', {})).rejects.toThrow(`original binding preserved. ${message}`);
    expect(request).toHaveBeenCalledExactlyOnceWith('thread/resume', { threadId: 'original' });
  });

  it.each([{ thread: { id: 'replacement' } }, { thread: {} }, {}])('rejects a mismatched resume response %j', async response => {
    const request = vi.fn().mockResolvedValue(response);
    await expect(resumeStoredAppThread(request, 'original', {})).rejects.toThrow('original binding preserved');
    expect(request).toHaveBeenCalledTimes(1);
  });

  it('can retry the same thread after recovery without creating another one', async () => {
    const request = vi.fn().mockRejectedValueOnce(new Error('database unavailable'))
      .mockResolvedValueOnce({ thread: { id: 'original' } });
    await expect(resumeStoredAppThread(request, 'original', {})).rejects.toThrow('database unavailable');
    await expect(resumeStoredAppThread(request, 'original', {})).resolves.toEqual({ thread: { id: 'original' } });
    expect(request.mock.calls.map(call => call[0])).toEqual(['thread/resume', 'thread/resume']);
  });
});
