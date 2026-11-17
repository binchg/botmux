/** 只显示会话自己的 worktree 与设备登记，不能把控制仓或其它任务的设备当成本会话。 */
import { afterEach, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { readSessionCardBindings } from '../src/services/session-card-bindings.js';
const dirs: string[] = [];
const hash = (id: string) => createHash('sha256').update(id).digest('hex');
const put = (path: string, data: unknown) => { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, JSON.stringify(data)); };
const setup = () => { const home = mkdtempSync(join(tmpdir(), 'card-bindings-')); dirs.push(home); return { home, codexHome: join(home, '.codex'), sessionId: 'bot-session', nativeIds: ['native-thread'] }; };
afterEach(() => dirs.splice(0).forEach(dir => rmSync(dir, { recursive: true, force: true })));

/** 建立最小真实 Git 标记与规范绑定，不执行任何业务工作区操作。 */
function binding(home: string, slot: string, owner = 'bot-session', prefix = 'xs_fm_android') {
  const path = join(home, 'workspace', slot, prefix);
  mkdirSync(join(path, '.git'), { recursive: true }); writeFileSync(join(path, '.git/HEAD'), 'ref: refs/heads/feature_ad_kmp\n');
  return { key: `${hash(owner)}:${prefix}`, value: { slot: `${slot}/${prefix}`, target_path: path, prefix,
    branch: 'feature_ad_kmp', session_fingerprint: hash(owner).slice(0, 12) } };
}

it('通过准确会话摘要和原生线程租约显示 WT5、mac1，不显示他人设备', () => {
  const q = setup(), own = binding(q.home, '5'), other = binding(q.home, '6', 'other');
  put(join(q.codexHome, 'state/android-worktree-pool/state.json'), { session_affinity: { [own.key]: own.value, [other.key]: other.value } });
  put(join(q.home, '.cache/kmp-cli/device-leases', hash('emulator-5554') + '.json'), { serial: 'emulator-5554', owner: 'native-thread' });
  put(join(q.home, '.cache/kmp-cli/device-leases', hash('private-other') + '.json'), { serial: 'private-other', owner: 'other' });
  mkdirSync(join(q.home, '.config/dora-mobile-remote'), { recursive: true });
  writeFileSync(join(q.home, '.config/dora-mobile-remote/env'), 'DORA_MAC_ANDROID_EMULATORS="mac1=127.0.0.1:5038/emulator-5554"\nSECRET=hidden\n');
  expect(readSessionCardBindings(q)).toMatchObject({ worktrees: ['WT5'], devices: ['mac1'] });
  expect(readSessionCardBindings({ ...q, sessionId: 'unbound', nativeIds: [], workingDir: own.value.target_path }).worktrees).toEqual([]);
  writeFileSync(join(own.value.target_path, '.git/HEAD'), 'ref: refs/heads/other-task\n');
  expect(readSessionCardBindings(q).worktrees).toEqual([]);
});

it('云机需要准确任务、worktree、就绪状态和未过期登记，使用已登记平台短号', () => {
  const q = setup(), now = 1_800_000_000_000, own = binding(q.home, 'A', 'bot-session', 'xs_fm_harmony');
  put(join(q.codexHome, 'state/harmony-worktree-pool/state.json'), { session_affinity: { [own.key]: own.value } });
  const dora = join(q.home, '.config/dora-mobile-remote');
  put(join(dora, 'slots-ohos.json'), { slots: { serialH: 7 } });
  put(join(dora, 'usage.json'), { devices: {
    serialH: { taskId: 'bot-session', worktree: own.value.target_path, status: 'ready', updatedAtEpoch: now / 1000 },
    stale: { taskId: 'bot-session', worktree: own.value.target_path, status: 'ready', updatedAtEpoch: now / 1000 - 21601 },
    alien: { taskId: 'other', worktree: own.value.target_path, status: 'ready', updatedAtEpoch: now / 1000 },
  } });
  expect(readSessionCardBindings({ ...q, now })).toMatchObject({ worktrees: ['鸿蒙A'], devices: ['鸿蒙7'] });
});

it('损坏状态、错误摘要或路径与槽位不一致时留空，不猜占用', () => {
  const q = setup(), own = binding(q.home, '5');
  own.value.slot = '6/xs_fm_android';
  put(join(q.codexHome, 'state/android-worktree-pool/state.json'), { session_affinity: { [own.key]: own.value } });
  expect(readSessionCardBindings(q).worktrees).toEqual([]);
  put(join(q.codexHome, 'state/android-worktree-pool/state.json'), null);
  expect(readSessionCardBindings(q).worktrees).toEqual([]);
});
