import { request } from 'node:http';
import { join } from 'node:path';

export const codexThreadProxySocket = () => join('/run/user', String(process.getuid?.()), 'botmux-codex-thread-proxy.sock');

export function requestCodexThreadProxy(socketPath: string, route: string, body?: object): Promise<any> {
  return new Promise((resolve, reject) => {
    const req = request({ socketPath, path: route, method: body ? 'POST' : 'GET',
      headers: { 'Content-Type': 'application/json' }, timeout: 6000 }, res => {
      const chunks: Buffer[] = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('error', reject);
      res.on('end', () => {
        try {
          const result = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          if (res.statusCode !== 200) reject(new Error(result.error || `Proxy HTTP ${res.statusCode}`));
          else resolve(result);
        } catch (error) { reject(error); }
      });
    });
    req.once('error', reject);
    req.once('timeout', () => req.destroy(new Error('Codex process proxy timed out')));
    req.end(body ? JSON.stringify(body) : undefined);
  });
}
