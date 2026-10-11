import { it, expect } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { chromium, type Browser } from 'playwright';
import { WebSocket } from 'ws';
import { startLocalShell } from '../src/local-shell-server.js';
import { issueTerminalEntry } from '../src/services/terminal-access.js';

it('independent shell accepts real keyboard commands, resizes and survives lock/reconnect', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'local-shell-browser-'));
  const socket = 'local-shell-test-' + process.pid;
  const entry = issueTerminalEntry(dir, 'shell');
  const service = await startLocalShell({ dataDir: dir, id: 'shell', port: 0, cwd: dir, shell: '/bin/bash', tmuxSocket: socket, publicBaseUrl: 'http://localhost/' });
  const base = `http://127.0.0.1:${service.port}/`;
  let browser: Browser | undefined;
  try {
    expect(await new Promise<number>((resolve, reject) => {
      const ws = new WebSocket(base.replace('http:', 'ws:'), { headers: { Origin: new URL(base).origin } });
      ws.on('unexpected-response', (_, r) => { r.resume(); ws.terminate(); resolve(r.statusCode!); });
      ws.on('open', () => { ws.terminate(); reject(Error('unlocked without a password')); });
      ws.on('error', () => {});
    })).toBe(401);
    browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
    const page = await browser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
    page.setDefaultTimeout(10000);
    const errors: string[] = []; page.on('pageerror', e => errors.push(e.message));
    await page.goto(base + '#entry=' + entry.token);
    await page.getByRole('heading', { name: '首次设置二次密码' }).waitFor();
    await page.locator('#password').fill('only-for-shell-test-123');
    await page.locator('#confirm').fill('only-for-shell-test-123');
    await page.getByRole('button', { name: '确认并解锁 5 分钟' }).click();
    await expect.poll(() => page.locator('#status').textContent()).toBe('已连接');
    expect(await page.getByRole('button', { name: '同意本会话 Hooks' }).count()).toBe(0);
    await page.locator('.xterm-helper-textarea').focus();
    await page.keyboard.type('export LOCAL_SHELL_PROOF=from_real_shell; printf "\\n%s\\n" "$LOCAL_SHELL_PROOF"');
    await page.keyboard.press('Enter');
    const capture = () => execFileSync('tmux', ['-L', socket, 'capture-pane', '-p', '-t', 'main'], { encoding: 'utf8' });
    await expect.poll(capture).toContain('from_real_shell');
    await page.setViewportSize({ width: 900, height: 700 });
    await expect.poll(() => Number(execFileSync('tmux', ['-L', socket, 'display-message', '-p', '-t', 'main', '#{pane_width}'], { encoding: 'utf8' }).trim())).toBeGreaterThan(70);
    await page.getByRole('button', { name: '锁定', exact: true }).click();
    await page.getByRole('heading', { name: '输入二次密码' }).waitFor();
    const next = issueTerminalEntry(dir, 'shell');
    await page.goto(base + '#entry=' + next.token);
    await page.locator('#password').fill('only-for-shell-test-123');
    await page.getByRole('button', { name: '确认并解锁 5 分钟' }).click();
    await expect.poll(() => page.locator('#status').textContent()).toBe('已连接');
    await page.locator('.xterm-helper-textarea').focus();
    await page.keyboard.type('printf "\\nRECONNECTED_%s\\n" "$LOCAL_SHELL_PROOF"');
    await page.keyboard.press('Enter');
    await expect.poll(capture).toContain('RECONNECTED_from_real_shell');
    expect(errors).toEqual([]);
  } finally {
    await browser?.close();
    await service.close();
    try { execFileSync('tmux', ['-L', socket, 'kill-server'], { stdio: 'ignore' }); } catch {}
    rmSync(dir, { recursive: true, force: true });
  }
}, 45000);
