import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { runLockedAuthProcess } from '../src/services/codex-auth-process-lock.js';

const dirs: string[] = [];
afterEach(() => { while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true }); });
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'codex-auth-lock-')); dirs.push(dir);
  return { dir, lock: join(dir, 'refresh.lock'), script: join(dir, 'worker.cjs'), started: join(dir, 'started') };
}

describe.skipIf(process.platform !== 'linux')('kernel-owned global auth refresh', () => {
  it('elects one process across concurrent daemons without queueing refreshers', async () => {
    const f = fixture();
    writeFileSync(f.script, `const fs=require('fs'); fs.writeFileSync(${JSON.stringify(f.started)},'ready');
setTimeout(()=>console.log('refreshed'),1800);`);
    const owner = runLockedAuthProcess(f.lock, [process.execPath, f.script]);
    await vi.waitFor(() => expect(existsSync(f.started)).toBe(true));
    const contenders = await Promise.all(Array.from({ length: 16 }, () =>
      runLockedAuthProcess(f.lock, [process.execPath, f.script])));
    expect(contenders.every(result => result.busy)).toBe(true);
    expect((await owner).output.trim()).toBe('refreshed');
    expect(readFileSync(f.started, 'utf8')).toBe('ready');
  });

  it('releases locks after crashes without deleting or stealing a lock inode', async () => {
    const f = fixture();
    await expect(runLockedAuthProcess(f.lock, [process.execPath, '-e', "process.kill(process.pid,'SIGKILL')"]))
      .rejects.toThrow('exited');
    expect(existsSync(f.lock)).toBe(true);
    expect(await runLockedAuthProcess(f.lock, [process.execPath, '-e', "console.log('recovered')"]))
      .toEqual({ busy: false, output: 'recovered\n' });
  });

  it('bounds a hung worker and releases its lock for the next attempt', async () => {
    const f = fixture();
    await expect(runLockedAuthProcess(f.lock,
      [process.execPath, '-e', "process.on('SIGTERM',()=>{});setInterval(()=>{},1000)"], process.env, 250))
      .rejects.toThrow('timed out');
    expect((await runLockedAuthProcess(f.lock, [process.execPath, '-e', "console.log('ok')"])).busy).toBe(false);
  });
});
