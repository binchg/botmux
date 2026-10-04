/** Isolated real worker + browser test. No model invocation, no Lark messages. Run after build. */
import { it, expect } from 'vitest';
import { fork, execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium, type Browser } from 'playwright';
import { WebSocket } from 'ws';
import { issueTerminalEntry } from '../src/services/terminal-access.js';
import { writeSessionModel, readSessionModel } from '../src/services/session-model-store.js';
import { startTerminalProxy, type TerminalProxyHandle } from '../src/core/terminal-proxy.js';

it('real worker enforces the gate and browser setup, control, hooks, lock and unlock work', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'botmux-secure-browser-'));
  const id = 'secure-browser-' + process.pid;
  const pane = 'test-' + id;
  let browser: Browser | undefined, proxy: TerminalProxyHandle | undefined;
  execFileSync('tmux', ['new-session', '-d', '-s', pane, '-x', '100', '-y', '30', 'cat']);
  const worker = fork(join(process.cwd(), 'dist/worker.js'), [], {
    env: { ...process.env, SESSION_DATA_DIR: dir, BOTMUX_WORKFLOW: '1', WEB_WORKER_HOST: '127.0.0.1' },
    stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
  });
  try {
    writeSessionModel(dir, id, { executor: 'traex', model: 'gpt-6-astra', effort: 'xhigh', hookTrust: 'review' });
    const ready = new Promise<{ port: number; token: string }>((resolve, reject) => {
      const timer = setTimeout(() => reject(Error('worker did not become ready')), 15_000);
      worker.on('message', (m: any) => { if (m.type === 'ready') { clearTimeout(timer); resolve(m); } });
      worker.once('exit', code => { clearTimeout(timer); reject(Error('worker exit ' + code)); });
    });
    worker.send({ type: 'init', sessionId: id, workingDir: dir, cliId: 'codex', prompt: '',
      larkAppId: '', larkAppSecret: '', adoptMode: true, adoptTmuxTarget: pane, locale: 'zh' });
    const { port, token } = await ready;
    proxy = await startTerminalProxy({ port: 0, host: '127.0.0.1', resolvePort: sid => sid === id ? port : undefined });
    const base = `http://127.0.0.1:${proxy.port}/s/${id}/`;
    const first = issueTerminalEntry(dir, id);
    // Actual worker, direct-port legacy token + spoofed role, before any browser setup.
    expect(await new Promise<number>((resolve, reject) => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}/?token=${token}`, { headers: { Origin: `http://127.0.0.1:${port}`, 'x-botmux-role': 'owner' } });
      ws.on('unexpected-response', (_req, r) => { r.resume(); ws.terminate(); resolve(r.statusCode!); });
      ws.on('open', () => { ws.terminate(); reject(Error('legacy token bypassed gate')); });
      ws.on('error', () => {});
    })).toBe(401);
    browser = await chromium.launch({ headless: true, executablePath: process.env.BOTMUX_TEST_CHROMIUM, args: ['--no-sandbox'] });
    const page = await browser.newPage({ viewport: { width: 1100, height: 760 } });
    page.setDefaultTimeout(10_000);
    page.setDefaultNavigationTimeout(10_000);
    const errors: string[] = [], external: string[] = [];
    page.on('pageerror', e => errors.push(e.message));
    page.on('request', r => { if (!r.url().startsWith(`http://127.0.0.1:${proxy!.port}/`)) external.push(r.url()); });
    await page.goto(base + '#entry=' + first.token);
    await page.getByRole('heading', { name: '首次设置二次密码' }).waitFor();
    if (process.env.BOTMUX_TERMINAL_SCREENSHOT_DIR) {
      mkdirSync(process.env.BOTMUX_TERMINAL_SCREENSHOT_DIR, { recursive: true });
      await page.screenshot({ path: join(process.env.BOTMUX_TERMINAL_SCREENSHOT_DIR, 'setup.png') });
    }
    expect(page.url()).toBe(base);
    const password = 'browser-test-only-password-42';
    await page.locator('#password').fill(password);
    await page.locator('#confirm').fill(password);
    await page.getByRole('button', { name: '确认并解锁 5 分钟' }).click();
    await page.locator('#secure-terminal-controls').waitFor();
    await page.waitForFunction(() => document.querySelector('#status')?.textContent === 'connected' || [...document.querySelectorAll('.ok')].some(n => n.textContent === 'connected'));
    // Real keyboard input through the gated WebSocket reaches only the isolated cat pane.
    await page.locator('.xterm-helper-textarea').focus();
    await page.keyboard.type('SECURE_TERMINAL_BROWSER_INPUT');
    await page.keyboard.press('Enter');
    await expect.poll(() => execFileSync('tmux', ['capture-pane', '-p', '-t', pane], { encoding: 'utf8' })).toContain('SECURE_TERMINAL_BROWSER_INPUT');
    page.once('dialog', dialog => dialog.accept());
    await page.getByRole('button', { name: '同意本会话 Hooks' }).click();
    await page.getByRole('status').filter({ hasText: '已保存' }).waitFor();
    expect(readSessionModel(dir, id)?.hookTrust).toBe('always');
    expect(readSessionModel(dir, id)?.executor).toBe('traex');
    if (process.env.BOTMUX_TERMINAL_SCREENSHOT_DIR) await page.screenshot({ path: join(process.env.BOTMUX_TERMINAL_SCREENSHOT_DIR, 'unlocked.png') });
    console.log('Browser checks: setup, terminal input and hooks passed');
    await page.getByRole('button', { name: '立即锁定' }).click();
    await page.getByRole('heading', { name: '输入二次密码' }).waitFor();
    console.log('Browser checks: locked');
    const second = issueTerminalEntry(dir, id);
    const unlockedStatus = page.waitForResponse(r => r.url().endsWith('/.terminal-auth/status'));
    await page.goto(base + '#entry=' + second.token);
    await unlockedStatus;
    console.log('Browser checks: new entry loaded');
    await page.getByRole('button', { name: '确认并解锁 5 分钟' }).waitFor({ state: 'visible' });
    await page.locator('#password').fill(password);
    await page.getByRole('button', { name: '确认并解锁 5 分钟' }).click();
    await page.locator('#secure-terminal-controls').waitFor();
    expect(errors).toEqual([]);
    expect(external).toEqual([]);
    console.log('Browser checks: re-unlock and local assets passed');
  } finally {
    await browser?.close();
    console.log('Browser closed');
    // The disposable adopted-pane fixture owns no user CLI. Force-stop this exact
    // child because its normal shutdown can wait on a screenshot subprocess.
    worker.kill('SIGKILL');
    await new Promise<void>(r => worker.exitCode !== null || worker.signalCode !== null ? r() : worker.once('exit', () => r()));
    console.log('Worker stopped');
    await proxy?.close();
    try { execFileSync('tmux', ['kill-session', '-t', pane]); } catch {}
    rmSync(dir, { recursive: true, force: true });
  }
}, 60_000);
