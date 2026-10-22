/** 卡片发出前异步预热面板进程的历史缓存；不读取响应正文，也不改变授权有效期。 */
import { get } from 'node:http';
const attempts = new Map<string, number>();

/** 单个链接一分钟内只预热一次，使用固定回环地址且限制连接时间。 */
export function preloadConversationHistory(token: string, port: string | number): void {
  if (process.env.NODE_ENV === 'test') return;
  const now = Date.now();
  if (now - (attempts.get(token) ?? 0) < 60_000) return;
  if (attempts.size >= 128) attempts.delete(attempts.keys().next().value!);
  attempts.set(token, now);
  const request = get({ hostname: '127.0.0.1', port, path: `/conversation/${token}?preload=1`,
    signal: AbortSignal.timeout(3000) }, response => response.resume());
  request.on('error', () => {});
}
