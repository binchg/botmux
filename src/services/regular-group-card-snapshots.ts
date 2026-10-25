/** 保存实际发送的群设置卡；飞书回读会删除回调参数，不能据此重建其它按钮。 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { config } from '../config.js';

const limit = 1000;
/** 文件名只包含身份摘要，完整卡片以私有权限保存，最多保留最近一千张。 */
function location(appId: string, messageId: string): { directory: string; file: string } {
  const directory = join(config.session.dataDir, 'regular-group-card-snapshots');
  const digest = createHash('sha256').update(JSON.stringify([appId, messageId])).digest('hex');
  return { directory, file: join(directory, `${digest}.json`) };
}

/** 只有新增卡片才清理容量，流卡片更新不重复扫描目录。 */
function trim(directory: string): void {
  const files = readdirSync(directory).filter(file => /^[a-f0-9]{64}\.json$/.test(file));
  if (files.length <= limit) return;
  const oldest = files.flatMap(file => {
    try { return [{ file: join(directory, file), time: statSync(join(directory, file)).mtimeMs }]; }
    catch { return []; }
  }).sort((a, b) => a.time - b.time);
  for (const entry of oldest.slice(0, Math.max(0, oldest.length - limit))) {
    try { unlinkSync(entry.file); } catch { /* 并发清理已删除的文件不影响当前卡片。 */ }
  }
}

/** 发送成功后记录原卡，包括所有按钮的 value；刷新时按消息身份原子替换。 */
export function saveGroupCardSnapshot(appId: string, messageId: string, card: any): void {
  const { directory, file } = location(appId, messageId);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const fresh = !existsSync(file);
  const temporary = `${file}.tmp.${process.pid}`;
  writeFileSync(temporary, JSON.stringify({ appId, messageId, card }), { mode: 0o600 });
  renameSync(temporary, file);
  if (fresh) trim(directory);
}

/** 重启后仍可刷新旧卡；不存在的快照不能从平台缺失的回调参数猜测。 */
export function readGroupCardSnapshot(appId: string, messageId: string): any | undefined {
  try {
    const snapshot = JSON.parse(readFileSync(location(appId, messageId).file, 'utf8'));
    return snapshot.appId === appId && snapshot.messageId === messageId ? snapshot.card : undefined;
  } catch { return undefined; }
}
