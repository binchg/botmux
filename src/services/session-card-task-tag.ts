/** 会话任务标签：从首轮主题提炼方向，首次写入后不随追问、模型或目录变化重命名。 */
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { atomicWriteFileSync } from '../utils/atomic-write.js';
import { withFileLockSync } from '../utils/file-lock.js';

const domains: Array<[RegExp, string]> = [
  [/\bbotmux\b|\btraex\b/i, 'botmux'], [/ad[_-]?kmp|广告.*kmp|kmp.*广告/i, 'adkmp'],
  [/\bkmp-cli\b/i, 'kmp-cli'], [/新闻|\bnews[_-]?kmp\b/i, '新闻'],
  [/鸿蒙|harmony|ohos/i, '鸿蒙'], [/\bios\b|iphone|ipad/i, 'iOS'],
  [/播放器|player[_-]?sdk/i, '播放器'], [/compose/i, 'Compose'],
  [/工作台|ai.workspace/i, '工作台'], [/\bxgit\b/i, 'xgit'],
  [/贡献率|贡献归因|ai.?归因/i, 'AI归因'], [/\bkmp\b/i, 'KMP'],
  [/android|安卓/i, 'Android'], [/设备|真机|模拟器|投屏/i, '设备'],
  [/文档|总结|okr|复盘/i, '文档'],
];

/** 只使用首轮主题与已绑定工程线索；不从最新追问或任意正文截取个人信息。 */
export function inferSessionTaskTag(title: string, project = ''): string {
  const prompt = /<user_message>\s*([\s\S]*?)\s*<\/user_message>/i.exec(title)?.[1] ?? title;
  const primary = domains.find(([pattern]) => pattern.test(prompt));
  if (primary) return primary[1];
  const secondary = domains.find(([pattern]) => pattern.test(project));
  if (secondary) return secondary[1];
  if (/xs_fm_ai_coding/i.test(project)) return 'AICoding';
  return '研发';
}

/** 私有摘要路径与原子锁保障 daemon 重启、并发建卡后标签仍相同，不保存首轮正文。 */
export function stableSessionTaskTag(dir: string, id: string, title: string, project = ''): string {
  const tag = inferSessionTaskTag(title, project);
  if (!id || id.length > 200) return tag;
  const root = join(dir, 'session-card-task-tags');
  const path = join(root, createHash('sha256').update(id).digest('hex') + '.json');
  const read = (): string | undefined => {
    try {
      const value = JSON.parse(readFileSync(path, 'utf8'));
      return value.version === 1 && typeof value.tag === 'string' && /^[\p{L}\p{N}-]{1,12}$/u.test(value.tag) ? value.tag : undefined;
    } catch { return undefined; }
  };
  const existing = read();
  if (existing) return existing;
  try {
    mkdirSync(root, { recursive: true, mode: 0o700 });
    return withFileLockSync(path, () => {
      const current = read();
      if (current) return current;
      atomicWriteFileSync(path, JSON.stringify({ version: 1, tag }), { mode: 0o600 });
      return tag;
    }, { maxWaitMs: 250 });
  } catch { return read() ?? tag; }
}
