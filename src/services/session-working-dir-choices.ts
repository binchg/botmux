import { accessSync, constants, realpathSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { expandHome } from '../core/working-dir.js';
import type { Session } from '../types.js';

export interface WorkingDirChoices { recent: string[]; configured: string[] }

/** Bot-scoped, newest first; historical aliases and missing paths never crowd out usable choices. */
export function sessionWorkingDirChoices(
  sessions: Session[], appId: string, presets: string[] = [], limit = 5,
): WorkingDirChoices {
  const seen = new Set<string>();
  const usable = (input: string): string | undefined => {
    try {
      const path = resolve(expandHome(input));
      if (!statSync(path).isDirectory()) return;
      accessSync(path, constants.R_OK | constants.X_OK);
      const canonical = realpathSync(path);
      if (seen.has(canonical)) return;
      seen.add(canonical);
      return path;
    } catch { return; }
  };
  const recent: string[] = [];
  const usedAt = (s: Session) => Date.parse(s.workingDirLastUsedAt ?? s.lastMessageAt ?? s.createdAt) || 0;
  for (const session of sessions.filter(s => s.larkAppId === appId && s.workingDir && !s.pendingRepoSelection).sort((a, b) => usedAt(b) - usedAt(a))) {
    const path = usable(session.workingDir!);
    if (path) recent.push(path);
    if (recent.length >= limit) break;
  }
  // Keep configured directories visible even when also present in Recents.
  seen.clear();
  const configured = presets.map(usable).filter((p): p is string => !!p).slice(0, 20);
  return { recent, configured };
}
