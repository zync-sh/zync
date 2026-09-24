import type { UsageSessionPayload } from './types.js';

const MAX_OPEN_SECONDS = 24 * 60 * 60;

export interface UsageSession {
  id: string;
  openedAt: string;
  timezone?: string;
  utcOffsetMinutes: number;
}

export function utcOffsetMinutes(now: Date): number {
  return -now.getTimezoneOffset();
}

export function localTimezone(): string | undefined {
  try {
    const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    return zone || undefined;
  } catch {
    return undefined;
  }
}

export function createUsageSession(now = new Date(), id = newSessionId()): UsageSession {
  return {
    id,
    openedAt: now.toISOString(),
    timezone: localTimezone(),
    utcOffsetMinutes: utcOffsetMinutes(now),
  };
}

/** Seconds the app was open on this UTC day, capped at that day and at 24 hours. */
export function dayOpenSeconds(session: UsageSession, day: string, now: Date): number {
  const opened = new Date(session.openedAt).getTime();
  const dayStart = new Date(`${day}T00:00:00.000Z`).getTime();
  const dayEnd = dayStart + MAX_OPEN_SECONDS * 1000;
  const start = Math.max(opened, dayStart);
  const stop = Math.min(now.getTime(), dayEnd);
  return clampSeconds(stop - start);
}

export function sessionPayload(session: UsageSession, day: string, now: Date): UsageSessionPayload {
  const dayStart = new Date(`${day}T00:00:00.000Z`).getTime();
  const dayEnd = dayStart + MAX_OPEN_SECONDS * 1000;
  const opened = Math.max(new Date(session.openedAt).getTime(), dayStart);
  const closed = Math.min(Math.max(now.getTime(), opened), dayEnd);
  return {
    id: session.id,
    openedAt: new Date(opened).toISOString(),
    closedAt: new Date(closed).toISOString(),
    openSeconds: clampSeconds(closed - opened),
    timezone: session.timezone,
    utcOffsetMinutes: session.utcOffsetMinutes,
  };
}

let liveSession: UsageSession | null = null;

export function currentUsageSession(): UsageSession | null {
  return liveSession;
}

export function ensureUsageSession(now = new Date()): UsageSession {
  if (!liveSession) liveSession = createUsageSession(now);
  return liveSession;
}

export function clearUsageSession(): void {
  liveSession = null;
}

function clampSeconds(ms: number): number {
  const seconds = Math.floor(ms / 1000);
  if (!Number.isFinite(seconds) || seconds <= 0) return 0;
  return Math.min(MAX_OPEN_SECONDS, seconds);
}

function newSessionId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return '00000000-0000-4000-8000-000000000000';
}
