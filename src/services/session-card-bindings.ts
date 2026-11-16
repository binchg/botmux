/** 只读 KMP 会话绑定和设备登记，不能按路径猜占用、借用他人设备或改变登记。 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, realpathSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';

export interface SessionCardBindingQuery { sessionId: string; nativeIds?: string[]; workingDir?: string; home?: string; codexHome?: string; now?: number }
export interface SessionCardBindings { worktrees: string[]; devices: string[]; project: string }
const cache = new Map<string, { stamp: string; data: any }>();

/** 按 inode、大小、时间复用小型登记文件；损坏和过大文件不作为身份依据。 */
function json(path: string): any {
  try {
    const stat = statSync(path);
    if (stat.size > 4 * 1024 * 1024) return {};
    const stamp = `${stat.ino}:${stat.size}:${stat.mtimeMs}`;
    const previous = cache.get(path);
    if (previous?.stamp === stamp) return previous.data;
    const value = JSON.parse(readFileSync(path, 'utf8'));
    const data = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
    if (cache.size >= 128) cache.delete(cache.keys().next().value!);
    cache.set(path, { stamp, data });
    return data;
  } catch { return {}; }
}

/** /home 与 /data00 软链接按真实目录比较，未知目录仅保留规范化路径。 */
function canonical(path: string): string {
  try { return realpathSync(path); } catch { return resolve(path); }
}

/** 登记分支已被人工切走时，不继续把该槽位展示为原会话占用。 */
function branchMatches(path: string, branch?: string): boolean {
  if (!branch) return true;
  try {
    const marker = join(path, '.git');
    const git = statSync(marker).isDirectory() ? marker : resolve(path, readFileSync(marker, 'utf8').trim().replace(/^gitdir:\s*/, ''));
    return readFileSync(join(git, 'HEAD'), 'utf8').trim() === `ref: refs/heads/${branch}`;
  } catch { return false; }
}

/** 只从公开连接字段识别已配置的模拟器别名；重名串号保持短串号，不猜宿主。 */
function emulatorAliases(home: string): Map<string, string[]> {
  const aliases = new Map<string, string[]>();
  try {
    for (const line of readFileSync(join(home, '.config/dora-mobile-remote/env'), 'utf8').split('\n')) {
      if (!/^DORA_(MAC_ANDROID_EMULATORS|FIXED_ANDROID_DEVICES)=/.test(line)) continue;
      const value = line.slice(line.indexOf('=') + 1).replace(/^["']|["']$/g, '');
      for (const entry of value.split(',')) {
        const [name, endpoint] = entry.split('=');
        if (!/^(mac|arm)[12]$/.test(name) || !endpoint) continue;
        const serial = endpoint.split('/').at(-1)!;
        aliases.set(serial, [...(aliases.get(serial) ?? []), name]);
      }
    }
  } catch { /* 无本机别名配置时保留准确串号末尾。 */ }
  return aliases;
}

/** 设备有平台登记短号时使用该号，其它设备只展示串号末四位。 */
function shortDevice(serial: string, home: string, aliases: Map<string, string[]>): string {
  const names = aliases.get(serial);
  if (names?.length === 1) return names[0];
  for (const [name, prefix] of [['slots.json', '安卓'], ['slots-ohos.json', '鸿蒙'], ['slots-ios.json', 'iOS']]) {
    const slot = json(join(home, '.config/dora-mobile-remote', name)).slots?.[serial];
    if (Number.isInteger(slot) && slot > 0) return `${prefix}${slot}`;
  }
  return `设备${serial.replace(/[^a-zA-Z0-9]/g, '').slice(-4) || '?'}`;
}

/** 只接受当前 Botmux/原生线程的准确所有者；过期云机绑定不展示为当前设备。 */
export function readSessionCardBindings(query: SessionCardBindingQuery): SessionCardBindings {
  const home = query.home ?? homedir(), codex = query.codexHome ?? process.env.CODEX_HOME ?? join(home, '.codex');
  const ids = [query.sessionId, ...(query.nativeIds ?? [])].filter(Boolean);
  const digests = ids.map(id => createHash('sha256').update(id).digest('hex'));
  const owned = (owner: unknown) => typeof owner === 'string' && (ids.includes(owner) || digests.includes(owner));
  const records: Array<{ path: string; label: string; project: string; prefix: string; rank: number }> = [];
  for (const pool of ['android-worktree-pool', 'harmony-worktree-pool']) {
    const state = json(join(codex, 'state', pool, 'state.json'));
    for (const [key, raw] of Object.entries(state.session_affinity ?? {})) {
      const binding = raw as any, digest = key.split(':')[0], rank = digests.indexOf(digest);
      if (rank < 0 || !['xs_fm_android', 'xs_fm_harmony'].includes(binding?.prefix)
        || key !== `${digest}:${binding.prefix}`
        || (binding.session_fingerprint && binding.session_fingerprint !== digest.slice(0, 12))
        || typeof binding.target_path !== 'string' || basename(binding.target_path) !== binding.prefix
        || !existsSync(join(binding.target_path, '.git')) || !branchMatches(binding.target_path, binding.branch)) continue;
      const slot = String(binding.slot ?? '').split('/')[0];
      if (!/^(?:[1-9]\d{0,2}|[A-C]|[rs][1-4])$/.test(slot) || basename(dirname(binding.target_path)) !== slot) continue;
      records.push({ path: canonical(binding.target_path), label: binding.prefix === 'xs_fm_harmony' ? `鸿蒙${slot}` : `WT${slot}`,
        project: `${binding.target_path} ${binding.task_key ?? ''} ${binding.branch ?? ''}`, prefix: binding.prefix, rank });
    }
  }
  const bindings = records.sort((a, b) => a.rank - b.rank).filter((r, i, all) => all.findIndex(v => v.prefix === r.prefix) === i);
  const paths = new Set([...bindings.map(r => r.path), ...(query.workingDir ? [canonical(query.workingDir)] : [])]);
  const devices = new Set<string>(), aliases = emulatorAliases(home);
  const leases = join(home, '.cache/kmp-cli/device-leases');
  try {
    for (const name of readdirSync(leases).filter(n => /^[a-f0-9]{64}\.json$/.test(n))) {
      const lease = json(join(leases, name));
      if (owned(lease.owner) && typeof lease.serial === 'string'
        && name === createHash('sha256').update(lease.serial).digest('hex') + '.json') devices.add(shortDevice(lease.serial, home, aliases));
    }
  } catch { /* 尚未登记设备时保持空值。 */ }
  const usage = json(join(home, '.config/dora-mobile-remote/usage.json'));
  for (const [serial, raw] of Object.entries(usage.devices ?? {})) {
    const device = raw as any, age = (query.now ?? Date.now()) / 1000 - Number(device?.updatedAtEpoch ?? 0);
    if (owned(device?.taskId) && device.status === 'ready' && age >= 0 && age <= 6 * 60 * 60
      && typeof device.worktree === 'string' && paths.has(canonical(device.worktree))) devices.add(shortDevice(serial, home, aliases));
  }
  return { worktrees: bindings.map(r => r.label), devices: [...devices].sort(),
    project: bindings.map(r => r.project).join(' ') || query.workingDir || '' };
}

/** 无数字槽位时用少量已知工程简称，不展示整条绝对路径。 */
export function shortSessionProject(path: string): string {
  const name = basename(path);
  return ({ xs_fm_ai_coding: 'AICoding', xs_fm_android: 'Android', xs_fm_harmony: '鸿蒙', botmux: 'botmux' } as Record<string, string>)[name]
    ?? (/^[a-zA-Z0-9_-]{1,16}$/.test(name) ? name : '项目');
}
