import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { AppServerClient } from './app-runner-client.js';
import { codexAuthFilePath, readCodexAccessTokenExpiryMs } from './codex-auth-file.js';
import { anyDaemonBusy } from '../core/daemon-heartbeat.js';
import { withFileLock } from '../utils/file-lock.js';
import { logger } from '../utils/logger.js';

export const CODEX_AUTH_WINDOW_START_HOUR = 4;
export const CODEX_AUTH_WINDOW_END_HOUR = 7;
export const CODEX_AUTH_MAINTENANCE_TICK_MS = 5 * 60_000;
export const CODEX_AUTH_RETRY_MS = 15 * 60_000;
const PRC_OFFSET_MS = 8 * 60 * 60_000;

export interface CodexAuthMaintenanceState {
  lastSuccessDate?: string;
  lastAttemptAt?: string;
  lastResult?: 'refreshed' | 'failed';
  lastError?: string;
}

export type CodexAuthMaintenanceDecision =
  | 'outside_window'
  | 'already_refreshed'
  | 'not_due'
  | 'not_logged_in'
  | 'busy'
  | 'retry_later'
  | 'refreshed'
  | 'failed';

export interface CodexAuthMaintenanceDeps {
  now: () => number;
  readExpiryMs: () => number | undefined;
  anyBusy: () => boolean;
  readState: () => CodexAuthMaintenanceState;
  writeState: (state: CodexAuthMaintenanceState) => void;
  refresh: () => Promise<void>;
  withLock: <T>(fn: () => Promise<T>) => Promise<T>;
}

interface PrcWindow {
  date: string;
  inWindow: boolean;
  nextWindowEndMs: number;
}

export function codexAuthPrcWindow(nowMs: number): PrcWindow {
  const shifted = new Date(nowMs + PRC_OFFSET_MS);
  const year = shifted.getUTCFullYear();
  const month = shifted.getUTCMonth();
  const day = shifted.getUTCDate();
  const hour = shifted.getUTCHours();
  const date = `${year}-${String(month + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
  return {
    date,
    inWindow: hour >= CODEX_AUTH_WINDOW_START_HOUR && hour < CODEX_AUTH_WINDOW_END_HOUR,
    // At any point in today's window, tomorrow 07:00 is the last safe point at
    // which the next maintenance window could refresh without daytime work.
    nextWindowEndMs: Date.UTC(year, month, day + 1, CODEX_AUTH_WINDOW_END_HOUR - 8),
  };
}

export async function runCodexAuthMaintenanceTick(
  deps: CodexAuthMaintenanceDeps,
): Promise<CodexAuthMaintenanceDecision> {
  const firstWindow = codexAuthPrcWindow(deps.now());
  if (!firstWindow.inWindow) return 'outside_window';

  return deps.withLock(async () => {
    const now = deps.now();
    const window = codexAuthPrcWindow(now);
    if (!window.inWindow) return 'outside_window';

    const state = deps.readState();
    if (state.lastSuccessDate === window.date) return 'already_refreshed';

    const expiryMs = deps.readExpiryMs();
    if (expiryMs === undefined) return 'not_logged_in';
    if (expiryMs > window.nextWindowEndMs) return 'not_due';
    if (deps.anyBusy()) return 'busy';

    const lastAttemptMs = state.lastAttemptAt ? Date.parse(state.lastAttemptAt) : NaN;
    if (state.lastResult === 'failed' && Number.isFinite(lastAttemptMs) && now - lastAttemptMs < CODEX_AUTH_RETRY_MS) {
      return 'retry_later';
    }

    const attempted: CodexAuthMaintenanceState = {
      ...state,
      lastAttemptAt: new Date(now).toISOString(),
      lastResult: 'failed',
      lastError: 'refresh_in_progress',
    };
    deps.writeState(attempted);
    try {
      await deps.refresh();
      deps.writeState({
        lastSuccessDate: window.date,
        lastAttemptAt: attempted.lastAttemptAt,
        lastResult: 'refreshed',
      });
      return 'refreshed';
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const errorCode = /already used/i.test(message)
        ? 'refresh_token_already_used'
        : /sign-?in|login/i.test(message)
          ? 'sign_in_required'
          : /timed out/i.test(message)
            ? 'refresh_timeout'
            : 'refresh_failed';
      deps.writeState({
        ...attempted,
        // Persist only a bounded classification. App-server errors are not
        // expected to echo credentials, but maintenance state must never risk it.
        lastError: errorCode,
      });
      return 'failed';
    }
  });
}

function maintenanceDir(): string {
  return join(homedir(), '.botmux', 'codex-auth-maintenance');
}

function statePath(): string {
  return join(maintenanceDir(), 'state.json');
}

function readState(): CodexAuthMaintenanceState {
  try {
    const value = JSON.parse(readFileSync(statePath(), 'utf8'));
    return value && typeof value === 'object' ? value as CodexAuthMaintenanceState : {};
  } catch {
    return {};
  }
}

function writeState(state: CodexAuthMaintenanceState): void {
  const path = statePath();
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(state, null, 2) + '\n', { mode: 0o600 });
  renameSync(tmp, path);
}

async function bounded<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs);
        timer.unref?.();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** Uses Codex's official proactive refresh request. No thread or model turn is created. */
export async function refreshCodexAccount(codexBin: string, cwd: string, authPath = codexAuthFilePath()): Promise<void> {
  const before = readCodexAccessTokenExpiryMs(authPath);
  const client = new AppServerClient(codexBin, cwd);
  try {
    await bounded(client.initialize(), 15_000, 'Codex app-server initialize');
    const result = await bounded(client.request('account/read', { refreshToken: true }), 30_000, 'Codex account refresh');
    if (result?.requiresOpenaiAuth || !result?.account) throw new Error('Codex account requires sign-in');
    const after = readCodexAccessTokenExpiryMs(authPath);
    if (after === undefined || before !== undefined && after <= before) {
      throw new Error('Codex proactive refresh did not persist a newer access token');
    }
  } finally {
    client.close();
  }
}

let interval: ReturnType<typeof setInterval> | undefined;
let initial: ReturnType<typeof setTimeout> | undefined;

export function startCodexAuthMaintenance(codexBin: string, cwd: string): void {
  if (interval || process.env.BOTMUX_CODEX_AUTH_MAINTENANCE === '0') return;
  mkdirSync(maintenanceDir(), { recursive: true });
  const tick = async () => {
    const decision = await runCodexAuthMaintenanceTick({
      now: Date.now,
      readExpiryMs: () => readCodexAccessTokenExpiryMs(),
      anyBusy: anyDaemonBusy,
      readState,
      writeState,
      refresh: () => refreshCodexAccount(codexBin, cwd),
      withLock: fn => withFileLock(join(maintenanceDir(), 'refresh'), fn, { maxWaitMs: 45_000 }),
    }).catch(error => {
      logger.warn(`[codex-auth-maintenance] tick failed: ${error instanceof Error ? error.message : String(error)}`);
      return 'failed' as const;
    });
    if (decision === 'refreshed') logger.info('[codex-auth-maintenance] proactive refresh completed in 04:00-07:00 window');
    else if (decision === 'failed') logger.warn('[codex-auth-maintenance] proactive refresh failed; will retry within the maintenance window');
  };
  initial = setTimeout(() => { void tick(); }, 5_000);
  initial.unref?.();
  interval = setInterval(() => { void tick(); }, CODEX_AUTH_MAINTENANCE_TICK_MS);
  interval.unref?.();
}

export function stopCodexAuthMaintenance(): void {
  if (initial) clearTimeout(initial);
  if (interval) clearInterval(interval);
  initial = undefined;
  interval = undefined;
}
