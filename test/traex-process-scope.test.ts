/** 回归 Hook 包装器、进程隔离和队列积压后的准入状态。 */
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { afterEach, describe, expect, it } from 'vitest';
import { traexAppServerPids } from '../src/services/traex-process-scope.js';
import { parseTraexQueueEvidence, TraexQueueReader } from '../src/services/traex-adaptive-model.js';

const roots: string[] = [];
/** 创建隔离的进程目录或 SQLite 数据库，不读取真实会话。 */
function temp(): string {
  const path = mkdtempSync(join(tmpdir(), 'traex-scope-'));
  roots.push(path);
  return path;
}
afterEach(() => { roots.splice(0).forEach(path => rmSync(path, { recursive: true, force: true })); });

describe('TraeX 包装进程排队归属', () => {
  it('发现多层启动器后的 app-server，排除普通工具和其它进程树', () => {
    const root = temp();
    /** 按 Linux /proc 格式写入进程关系。 */
    const process = (pid: number, children: number[], args: string[]) => {
      mkdirSync(join(root, `${pid}/task/${pid}`), { recursive: true });
      writeFileSync(join(root, `${pid}/task/${pid}/children`), children.join(' '));
      writeFileSync(join(root, `${pid}/cmdline`), args.join('\0') + '\0');
    };
    process(10, [11, 12], ['python', 'launcher.py']);
    process(11, [13], ['sh', 'nested-wrapper']);
    process(12, [], ['sh', 'build.sh']);
    process(13, [], ['traex', 'app-server', '--listen', 'stdio://']);
    process(99, [], ['traex', 'app-server']);
    expect(traexAppServerPids(10, root, 'linux')).toEqual([10, 13]);
    expect(traexAppServerPids(1234, root, 'linux')).toEqual([1234]);
  });

  it('识别纯 JSON 队列位置，零位不触发降级', () => {
    const row = { id: 1, ts: 2, ts_nanos: 0 };
    expect(parseTraexQueueEvidence({ ...row, feedback_log_body: 'request_wait_in_queue {"position":1046}' }))
      .toMatchObject({ position: 1046 });
    expect(parseTraexQueueEvidence({ ...row, feedback_log_body: 'request_wait_in_queue {"position":0}' })).toBeUndefined();
  });

  it('超过旧分页上限的排队日志后，以最新准入或排队事件为准', () => {
    const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite');
    const path = join(temp(), 'logs.sqlite');
    const db = new DatabaseSync(path);
    db.exec('CREATE TABLE logs(id INTEGER PRIMARY KEY,ts INTEGER,ts_nanos INTEGER,thread_id TEXT,process_uuid TEXT,feedback_log_body TEXT)');
    const reader = new TraexQueueReader('mine', 42, path);
    const insert = db.prepare('INSERT INTO logs VALUES(?,2,0,?,?,?)');
    try {
      for (let id = 1; id <= 300; id++) insert.run(id, null, 'pid:42:x', 'request_wait_in_queue {"position":99}');
      insert.run(301, null, 'pid:42:x', 'queue_end');
      expect(reader.poll(1000)).toBeUndefined();
      insert.run(302, null, 'pid:42:x', 'request_wait_in_queue {"position":7}');
      insert.run(303, 'other', 'pid:42:x', 'queue_end');
      insert.run(304, null, 'pid:43:x', 'queue_end');
      expect(reader.poll(1000)).toMatchObject({ id: 302, position: 7 });
      expect(reader.poll(1000)).toBeUndefined();
    } finally { reader.close(); db.close(); }
  });
});
