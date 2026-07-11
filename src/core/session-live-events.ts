import type { DaemonSession, SessionLiveEvent } from './types.js';

const MAX_LIVE_EVENTS = 80;
const MAX_LIVE_EVENT_CHARS = 4_000;

let liveEventSeq = 0;

function compactLiveEventContent(content: string, maxChars = MAX_LIVE_EVENT_CHARS): string {
  const text = String(content ?? '').trim();
  if (!text) return '';
  if (text.length <= maxChars) return text;
  return `${text.slice(0, maxChars).trimEnd()}\n...`;
}

export function appendSessionLiveEvent(
  ds: DaemonSession,
  input: Omit<SessionLiveEvent, 'id' | 'content'> & { id?: string; content: string },
): SessionLiveEvent[] {
  const content = compactLiveEventContent(input.content);
  if (!content) return ds.liveEvents ?? [];
  const event: SessionLiveEvent = {
    id: input.id ?? `${input.kind}:${input.turnId ?? 'turn'}:${input.at}:${++liveEventSeq}`,
    kind: input.kind,
    turnId: input.turnId,
    content,
    at: input.at,
  };
  const events = ds.liveEvents ? [...ds.liveEvents] : [];
  const existing = events.findIndex(item => item.id === event.id);
  if (existing >= 0) events[existing] = event;
  else events.push(event);
  ds.liveEvents = events.slice(-MAX_LIVE_EVENTS);
  return ds.liveEvents;
}

export function sessionLivePatch(ds: DaemonSession): Record<string, unknown> {
  return {
    liveEvents: ds.liveEvents ?? [],
    lastUserPrompt: ds.lastUserPrompt,
    currentTurnTitle: ds.currentTurnTitle,
  };
}
