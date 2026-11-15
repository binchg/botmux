/** Dedicated read-only history listener, bound only to the configured Tailnet IP. */
import { createServer } from 'node:http';
import { handleConversationHistoryRequest } from './services/conversation-history-http.js';
import { isTailAddress } from './services/conversation-history-network.js';

const host = process.env.BOTMUX_HISTORY_HOST ?? '';
const port = Number(process.env.BOTMUX_HISTORY_PORT ?? 7891);
if (!isTailAddress(host) || !Number.isInteger(port) || port < 1 || port > 65535) {
  throw new Error('History server requires an explicit Tailscale IP and valid port');
}
const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url ?? '/', `http://${host.includes(':') ? `[${host}]` : host}:${port}`);
    if (url.pathname === '/') url.pathname = '/conversation';
    if (await handleConversationHistoryRequest(req, res, url)) return;
    res.writeHead(404, { 'cache-control': 'no-store' }); res.end('Not found');
  } catch {
    res.writeHead(503, { 'cache-control': 'no-store' }); res.end('History unavailable');
  }
});
server.listen(port, host, () => console.log(`Read-only history listening on ${host}:${port}`));
for (const signal of ['SIGTERM', 'SIGINT'] as const) process.on(signal, () => server.close(() => process.exit(0)));
