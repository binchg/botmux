import { runInNewContext } from 'node:vm';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { describe, expect, it, vi } from 'vitest';
import { serveTerminalModelDisplay, terminalModelHeader, terminalModelScript } from '../src/utils/terminal-model-display.js';
import { sessionModelDisplay } from '../src/services/session-model-display.js';

const display = sessionModelDisplay({ sessionId: 'test', pid: process.pid, protocol: 4, phase: 'running',
  selection: { executor: 'traex', model: 'gpt-6.1-sol', effort: 'xhigh' }, updatedAt: new Date().toISOString() });

describe('Web terminal actual model header', () => {
  it('shows the initial actual model and escapes all HTML without rendering tokens', () => {
    expect(terminalModelHeader(display)).toContain('TraeX · GPT-6.1-Sol · xhigh');
    expect(terminalModelHeader(null)).toContain(' hidden');
    expect(terminalModelHeader({ ...display!, label: '<script>alert("x")</script>' })).not.toContain('<script>');
  });

  it('uses a read-only endpoint behind terminal auth and does not read metadata when locked', () => {
    const readDisplay = vi.fn(() => display);
    const response = { writeHead: vi.fn(), end: vi.fn() };
    const req = { method: 'GET' } as IncomingMessage;
    expect(serveTerminalModelDisplay(req, response as unknown as ServerResponse, '/', true, readDisplay)).toBe(false);
    expect(serveTerminalModelDisplay(req, response as unknown as ServerResponse, '/api/model-display', false, readDisplay)).toBe(true);
    expect(readDisplay).not.toHaveBeenCalled();
    expect(response.writeHead).toHaveBeenLastCalledWith(401, expect.objectContaining({ 'Cache-Control': 'no-store' }));
    serveTerminalModelDisplay({ method: 'POST' } as IncomingMessage, response as unknown as ServerResponse, '/api/model-display', true, readDisplay);
    expect(readDisplay).not.toHaveBeenCalled();
    serveTerminalModelDisplay(req, response as unknown as ServerResponse, '/api/model-display', true, readDisplay);
    const body = JSON.parse(response.end.mock.calls.at(-1)![0]);
    expect(body.display.model).toBe('gpt-6.1-sol');
    expect(body).not.toHaveProperty('pid');
    expect(body).not.toHaveProperty('threadId');
  });

  it('refreshes after a model switch on proxy paths and clears the header after relock', async () => {
    const node = { textContent: '', hidden: false, offsetHeight: 40 };
    const fetch = vi.fn().mockResolvedValue({ status: 200, ok: true, json: async () => ({ ok: true, display }) });
    const context: any = {
      document: { hidden: false, title: 'Terminal', getElementById: () => node,
        body: { classList: { toggle: vi.fn() }, style: { setProperty: vi.fn() } }, addEventListener: vi.fn() },
      window: { addEventListener: vi.fn() }, fit: { fit: vi.fn() }, fixedSize: false, sendResize: vi.fn(),
      location: { pathname: '/s/test/', search: '?token=private' }, fetch,
      AbortController, setTimeout, clearTimeout, setInterval: vi.fn(),
    };
    runInNewContext(terminalModelScript, context);
    await vi.waitFor(() => expect(node.textContent).toContain('GPT-6.1-Sol'));
    expect(fetch).toHaveBeenCalledWith('/s/test/api/model-display?token=private', expect.objectContaining({ credentials: 'same-origin' }));
    fetch.mockResolvedValue({ status: 200, ok: true, json: async () => ({ ok: true, display: { ...display, label: 'TraeX · GPT-5.6-Sol · xhigh' } }) });
    await context.refreshModelDisplay();
    expect(node.textContent).toContain('GPT-5.6-Sol');
    expect(context.document.title).toContain('GPT-5.6-Sol');
    expect(context.sendResize).toHaveBeenCalled();
    fetch.mockRejectedValue(new Error('offline'));
    await context.refreshModelDisplay();
    expect(context.document.title).toBe('模型状态暂不可用');
    expect(node.textContent).toBe('模型状态暂不可用');
    fetch.mockResolvedValue({ status: 401, ok: false });
    await context.refreshModelDisplay();
    expect(node.hidden).toBe(true);
    expect(node.textContent).toBe('');
    expect(context.document.title).toBe('Terminal');
  });
});
