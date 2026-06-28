import { terminalCache } from './terminalCache.js';

/** Marks a terminal session as having recent shell or user activity. */
export function touchTerminalActivity(termId: string, atMs: number = Date.now()): void {
  const cached = terminalCache.get(termId);
  if (!cached) {
    return;
  }
  cached.lastActivityAt = atMs;
}

/**
 * True when the shell should stay alive for idle-host suspend — recent output/input
 * or buffered keystrokes since the host was backgrounded.
 */
export function isTerminalBusyForIdleSuspend(termId: string, sinceMs: number): boolean {
  const cached = terminalCache.get(termId);
  if (!cached?.spawned) {
    return false;
  }

  if (cached.pendingInput || (cached.pendingInputBytes ?? 0) > 0) {
    return true;
  }

  const lastActivityAt = cached.lastActivityAt ?? 0;
  return lastActivityAt >= sinceMs;
}

/** Latest shell activity across tabs, floored at the background baseline. */
export function getLatestTerminalActivityAt(
  tabs: Array<{ id: string }>,
  baselineMs: number,
): number {
  let latest = baselineMs;
  for (const tab of tabs) {
    const lastActivityAt = terminalCache.get(tab.id)?.lastActivityAt ?? 0;
    latest = Math.max(latest, lastActivityAt);
  }
  return latest;
}