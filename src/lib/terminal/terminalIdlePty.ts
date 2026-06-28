import { getLatestTerminalActivityAt, isTerminalBusyForIdleSuspend } from './terminalActivity.js';
import { suspendAllTerminalsForConnection } from './suspendAllTerminals.js';

/** Default delay before suspending PTYs on a background workspace host. */
export const DEFAULT_IDLE_PTY_SUSPEND_MS = 120_000;
export const DEFAULT_SUSPEND_IDLE_HOST_PTYS = false;
export const DEFAULT_IDLE_HOST_PTY_SUSPEND_MINUTES = 2;
export const MIN_IDLE_HOST_PTY_SUSPEND_MINUTES = 1;
export const MAX_IDLE_HOST_PTY_SUSPEND_MINUTES = 60;

export function normalizeIdleHostPtySuspendMinutes(minutes: number | undefined): number {
  if (minutes == null || !Number.isFinite(minutes)) {
    return DEFAULT_IDLE_HOST_PTY_SUSPEND_MINUTES;
  }
  return Math.max(
    MIN_IDLE_HOST_PTY_SUSPEND_MINUTES,
    Math.min(MAX_IDLE_HOST_PTY_SUSPEND_MINUTES, Math.round(minutes)),
  );
}

export function resolveIdleHostPtySuspendDelayMs(
  enabled: boolean,
  minutes: number | undefined,
): number | null {
  if (!enabled) {
    return null;
  }
  const resolvedMinutes = normalizeIdleHostPtySuspendMinutes(minutes);
  return resolvedMinutes * 60_000;
}

interface IdlePtySuspendJob {
  timer: ReturnType<typeof setTimeout>;
  tabs: Array<{ id: string }>;
  onSuspend: (tabs: Array<{ id: string }>) => void;
  /** When the host was backgrounded — activity after this skips suspend. */
  backgroundedAt: number;
  delayMs: number;
}

const idleSuspendJobs = new Map<string, IdlePtySuspendJob>();

export interface IdlePtySuspendOptions {
  delayMs?: number;
  onSuspend?: (tabs: Array<{ id: string }>) => void;
  /** Override for tests — when the host was backgrounded. */
  backgroundedAt?: number;
}

function partitionTabsForIdleSuspend(
  tabs: Array<{ id: string }>,
  backgroundedAt: number,
): { idleTabs: Array<{ id: string }>; busyTabs: Array<{ id: string }> } {
  const idleTabs: Array<{ id: string }> = [];
  const busyTabs: Array<{ id: string }> = [];

  for (const tab of tabs) {
    if (isTerminalBusyForIdleSuspend(tab.id, backgroundedAt)) {
      busyTabs.push(tab);
    } else {
      idleTabs.push(tab);
    }
  }

  return { idleTabs, busyTabs };
}

function scheduleNextIdleSuspendAttempt(connectionId: string, tabs: Array<{ id: string }>, baselineMs: number, delayMs: number): void {
  const latestActivity = getLatestTerminalActivityAt(tabs, baselineMs);
  const waitMs = Math.max(0, latestActivity + delayMs - Date.now());
  const job = idleSuspendJobs.get(connectionId);
  if (!job) {
    return;
  }

  job.timer = setTimeout(() => {
    runIdleSuspendAttempt(connectionId);
  }, waitMs);
}

function runIdleSuspendAttempt(connectionId: string): void {
  const job = idleSuspendJobs.get(connectionId);
  if (!job) {
    return;
  }

  const { idleTabs, busyTabs } = partitionTabsForIdleSuspend(job.tabs, job.backgroundedAt);

  if (idleTabs.length > 0) {
    job.onSuspend(idleTabs);
  }

  if (busyTabs.length > 0) {
    job.tabs = busyTabs;
    scheduleNextIdleSuspendAttempt(connectionId, busyTabs, job.backgroundedAt, job.delayMs);
    return;
  }

  idleSuspendJobs.delete(connectionId);
}

/**
 * Schedule PTY suspend for all shell tabs on a connection after the workspace
 * host goes idle (another sidebar host selected).
 *
 * Tabs with shell output or buffered input since the host was backgrounded are
 * skipped and rechecked until quiet.
 */
export function scheduleIdlePtySuspend(
  connectionId: string,
  tabs: Array<{ id: string }> | undefined,
  options: IdlePtySuspendOptions = {},
): void {
  cancelIdlePtySuspend(connectionId);

  if (!connectionId || !tabs?.length) {
    return;
  }

  const delayMs = options.delayMs ?? DEFAULT_IDLE_PTY_SUSPEND_MS;
  const onSuspend = options.onSuspend ?? ((tabs) => {
    suspendAllTerminalsForConnection(tabs, { idleHost: true });
  });
  const tabSnapshot = tabs.map((tab) => ({ id: tab.id }));
  const backgroundedAt = options.backgroundedAt ?? Date.now();

  const timer = setTimeout(() => {
    runIdleSuspendAttempt(connectionId);
  }, delayMs);

  idleSuspendJobs.set(connectionId, {
    timer,
    tabs: tabSnapshot,
    onSuspend,
    backgroundedAt,
    delayMs,
  });
}

export function cancelIdlePtySuspend(connectionId: string): void {
  const job = idleSuspendJobs.get(connectionId);
  if (!job) {
    return;
  }
  clearTimeout(job.timer);
  idleSuspendJobs.delete(connectionId);
}

export function cancelAllIdlePtySuspends(): void {
  for (const job of idleSuspendJobs.values()) {
    clearTimeout(job.timer);
  }
  idleSuspendJobs.clear();
}

/** Test helper — run any pending idle suspend immediately. */
export function flushIdlePtySuspend(connectionId: string): void {
  const job = idleSuspendJobs.get(connectionId);
  if (!job) {
    return;
  }
  clearTimeout(job.timer);
  runIdleSuspendAttempt(connectionId);
}