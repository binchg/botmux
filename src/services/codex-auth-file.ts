import { statSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export interface CodexAuthFileStamp {
  ino: number;
  mtimeMs: number;
  size: number;
}

export function codexAuthFilePath(env: NodeJS.ProcessEnv = process.env, home: string = homedir()): string {
  return join(env.CODEX_HOME?.trim() || join(home, '.codex'), 'auth.json');
}

export function readCodexAuthFileStamp(path: string = codexAuthFilePath()): CodexAuthFileStamp | undefined {
  try {
    const stat = statSync(path);
    return { ino: stat.ino, mtimeMs: stat.mtimeMs, size: stat.size };
  } catch {
    return undefined;
  }
}

export function sameCodexAuthFileStamp(
  left: CodexAuthFileStamp | undefined,
  right: CodexAuthFileStamp | undefined,
): boolean {
  if (!left || !right) return left === right;
  return left.ino === right.ino && left.mtimeMs === right.mtimeMs && left.size === right.size;
}

/** Read only the JWT expiry metadata; token material is never returned or logged. */
export function readCodexAccessTokenExpiryMs(path: string = codexAuthFilePath()): number | undefined {
  try {
    const auth = JSON.parse(readFileSync(path, 'utf8')) as { tokens?: { access_token?: unknown } };
    const token = auth.tokens?.access_token;
    if (typeof token !== 'string') return undefined;
    const payloadPart = token.split('.')[1];
    if (!payloadPart) return undefined;
    const payload = JSON.parse(Buffer.from(payloadPart, 'base64url').toString('utf8')) as { exp?: unknown };
    return typeof payload.exp === 'number' && Number.isFinite(payload.exp) ? payload.exp * 1_000 : undefined;
  } catch {
    return undefined;
  }
}
