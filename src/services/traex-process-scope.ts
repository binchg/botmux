/** 解析启动器下的 app-server 进程，仅把当前进程树纳入排队观测。 */
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

/** Linux 逐层读 /proc；其它 Unix 使用有超时的进程快照，失败仅保留启动 PID。 */
export function traexAppServerPids(rootPid: number, procRoot = '/proc', platform = process.platform): number[] {
  const result = new Set([rootPid]);
  const visited = new Set<number>();
  const pending = [{ pid: rootPid, depth: 0 }];
  let snapshot: { pid: number; parent: number; appServer: boolean }[] = [];
  if (platform !== 'linux') {
    try {
      snapshot = execFileSync('ps', ['-axo', 'pid=,ppid=,args='], {
        encoding: 'utf8', timeout: 1000, maxBuffer: 4 * 1024 * 1024,
      }).split('\n').flatMap(line => {
        const match = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line);
        return match ? [{ pid: Number(match[1]), parent: Number(match[2]),
          appServer: /(?:^|\s)app-server(?:\s|$)/.test(match[3]) }] : [];
      });
    } catch { return [...result]; }
  }
  // 包装器可能不止一层；限制遍历范围，避免工具派生树无限扩大。
  while (pending.length && visited.size < 64) {
    const { pid, depth } = pending.shift()!;
    if (visited.has(pid) || depth > 8) continue;
    visited.add(pid);
    try {
      const children = platform === 'linux'
        ? readFileSync(`${procRoot}/${pid}/task/${pid}/children`, 'utf8').trim().split(/\s+/).map(Number).filter(n => n > 0)
        : snapshot.filter(row => row.parent === pid).map(row => row.pid);
      for (const child of children) {
        pending.push({ pid: child, depth: depth + 1 });
        try {
          const appServer = platform === 'linux'
            ? readFileSync(`${procRoot}/${child}/cmdline`, 'utf8').split('\0').includes('app-server')
            : snapshot.some(row => row.pid === child && row.appServer);
          if (appServer) result.add(child);
        } catch { /* 子进程退出时保留其它已验证进程。 */ }
      }
    } catch { /* 启动器退出或 /proc 不可读时不扩大范围。 */ }
  }
  return [...result];
}
