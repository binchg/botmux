import { spawn } from 'node:child_process';
import { closeSync, mkdirSync, openSync } from 'node:fs';
import { dirname } from 'node:path';

/** Kernel-owned lock: crashed refreshers release it without stale-PID deletion races. */
export function runLockedAuthProcess(
  lockPath: string,
  command: string[],
  env: NodeJS.ProcessEnv = process.env,
  timeoutMs = 55_000,
): Promise<{ busy: boolean; output: string }> {
  mkdirSync(dirname(lockPath), { recursive: true, mode: 0o700 });
  closeSync(openSync(lockPath, 'a', 0o600));
  return new Promise((resolve, reject) => {
    const child = spawn('flock', ['--nonblock', '--conflict-exit-code', '75', '--no-fork', lockPath, ...command], {
      env, detached: true, stdio: ['ignore', 'pipe', 'ignore'],
    });
    let output = '', timedOut = false;
    let escalation: ReturnType<typeof setTimeout> | undefined;
    const signalGroup = (signal: NodeJS.Signals) => {
      if (child.pid) try { process.kill(-child.pid, signal); } catch { /* already exited */ }
    };
    child.stdout.on('data', data => { output = (output + data.toString()).slice(-4096); });
    const timer = setTimeout(() => {
      timedOut = true;
      signalGroup('SIGTERM');
      escalation = setTimeout(() => signalGroup('SIGKILL'), 2_000);
    }, timeoutMs);
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('close', code => {
      clearTimeout(timer);
      if (escalation) clearTimeout(escalation);
      // A worker can exit before an unresponsive app-server child does.
      signalGroup('SIGKILL');
      if (timedOut) reject(new Error('Codex auth refresh worker timed out'));
      else if (code === 75) resolve({ busy: true, output: '' });
      else if (code === 0) resolve({ busy: false, output });
      else reject(new Error(`Codex auth refresh worker exited (${code})`));
    });
  });
}
