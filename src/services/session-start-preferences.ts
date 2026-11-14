import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { atomicWriteFileSync } from '../utils/atomic-write.js';
import type { ModelSelection } from './session-model-store.js';

export interface SessionStartPreferences {
  selection: ModelSelection;
  workingDir: string;
  updatedAt: string;
}
const filename = (dir: string, appId: string) => join(dir, 'session-start-preferences', createHash('sha256').update(appId).digest('hex') + '.json');
export function readSessionStartPreferences(dir: string, appId: string): SessionStartPreferences | undefined {
  try {
    const path = filename(dir, appId);
    if (!existsSync(path)) return;
    const value = JSON.parse(readFileSync(path, 'utf8'));
    if (value.appId !== appId || typeof value.workingDir !== 'string' || typeof value.selection?.model !== 'string' || typeof value.selection?.effort !== 'string') return;
    return value;
  } catch { return; }
}
/** Update only after explicit confirmation, scoped to this bot and durable across daemon restarts. */
export function rememberSessionStartPreferences(dir: string, appId: string, selection: ModelSelection, workingDir: string): void {
  const path = filename(dir, appId);
  mkdirSync(join(dir, 'session-start-preferences'), { recursive: true, mode: 0o700 });
  const { model, effort, serviceTier, executor, hookTrust, routingMode } = selection;
  const saved = { model, effort, serviceTier, executor, hookTrust, routingMode };
  atomicWriteFileSync(path, JSON.stringify({ appId, selection: saved, workingDir, updatedAt: new Date().toISOString() }, null, 2), { mode: 0o600 });
}
