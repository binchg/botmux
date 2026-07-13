import { describe, expect, it } from 'vitest';
import {
  beginOutboundReply,
  cancelTerminalSend,
  clearTerminalSend,
  commitTerminalSend,
  prepareTerminalSend,
  shouldSuppressAfterTerminalSend,
  terminalSendDecision,
  type TerminalSendHost,
} from '../src/services/terminal-send-barrier.js';

describe('terminal send barrier', () => {
  it('marks terminal before draining daemon replies already in flight', async () => {
    const host: TerminalSendHost = {};
    const reply = beginOutboundReply(host);

    let prepared = false;
    const preparing = prepareTerminalSend(host, {
      requestId: 'req-1',
      turnId: 'turn-1',
      nowMs: 123,
    }).then(result => {
      prepared = true;
      return result;
    });

    expect(shouldSuppressAfterTerminalSend(host)).toBe(true);
    expect(host.terminalSend).toMatchObject({ requestId: 'req-1', turnId: 'turn-1', markedAtMs: 123, status: 'preparing' });
    expect(prepared).toBe(false);

    reply.release();
    await expect(preparing).resolves.toEqual({ drained: 1 });
    expect(host.outboundReplies?.size).toBe(0);
  });

  it('only lets the matching failed send cancel its marker', async () => {
    const host: TerminalSendHost = {};
    await prepareTerminalSend(host, { requestId: 'latest', turnId: 'turn-2' });

    expect(cancelTerminalSend(host, 'stale')).toBe(false);
    expect(shouldSuppressAfterTerminalSend(host)).toBe(true);
    expect(cancelTerminalSend(host, 'latest')).toBe(true);
    expect(shouldSuppressAfterTerminalSend(host)).toBe(false);
  });

  it('holds a final during prepare, then releases it on explicit send failure', async () => {
    const host: TerminalSendHost = {};
    await prepareTerminalSend(host, { requestId: 'will-fail', turnId: 'turn-fail' });
    let settled = false;
    const decision = terminalSendDecision(host).then(value => { settled = true; return value; });
    await Promise.resolve();
    expect(settled).toBe(false);

    expect(cancelTerminalSend(host, 'will-fail')).toBe(true);
    await expect(decision).resolves.toBe('cancelled');
  });

  it('commits suppression only after the direct final card succeeds', async () => {
    const host: TerminalSendHost = {};
    await prepareTerminalSend(host, { requestId: 'will-pass', turnId: 'turn-pass' });
    const decision = terminalSendDecision(host);

    expect(commitTerminalSend(host, 'will-pass')).toBe(true);
    await expect(decision).resolves.toBe('committed');
    expect(host.terminalSend?.status).toBe('committed');
  });

  it('clears the terminal marker for the next inbound turn', async () => {
    const host: TerminalSendHost = {};
    await prepareTerminalSend(host, { requestId: 'req-3', turnId: 'turn-3' });
    const decision = terminalSendDecision(host);
    clearTerminalSend(host);
    expect(host.terminalSend).toBeUndefined();
    await expect(decision).resolves.toBe('committed');
  });
});
