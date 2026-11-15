import type { IncomingMessage } from 'node:http';
import { isIP } from 'node:net';

const normalize = (address = '') => address.replace(/^::ffff:/, '').toLowerCase();
export function isTailAddress(address: string): boolean {
  address = normalize(address);
  if (isIP(address) === 4) {
    const [first, second] = address.split('.').map(Number);
    return first === 100 && second >= 64 && second <= 127;
  }
  return isIP(address) === 6 && address.startsWith('fd7a:115c:a1e0:');
}
const loopback = (address: string) => ['127.0.0.1', '::1'].includes(normalize(address));

/** Trust socket endpoints, never forwarded headers or a caller-supplied IP. */
export function historyNetworkAllowed(req: IncomingMessage): boolean {
  if (req.headers?.forwarded || req.headers?.['x-forwarded-for'] || req.headers?.['x-forwarded-host']) return false;
  const remote = normalize(req.socket.remoteAddress), local = normalize(req.socket.localAddress);
  try {
    const host = new URL(`http://${req.headers?.host ?? ''}`).hostname.replace(/^\[|\]$/g, '');
    if (loopback(remote) && loopback(local)) return host === 'localhost' || loopback(host);
    return isTailAddress(remote) && isTailAddress(local) && host === local;
  } catch { return false; }
}
