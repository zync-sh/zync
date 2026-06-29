import { LOCAL_TERMINAL_CONNECTION_ID } from './connectionIds.js';
import { getLatestTerminalActivityAt, isTerminalBusyForIdleSuspend } from './terminalActivity.js';
import { isTerminalSessionProcessBusy } from './terminalProcessActivity.js';
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

export type ProcessBusyChecker = (termId: string) => Promise<boolean>;

interface IdlePtySuspendJob {
  timer: ReturnType<typeof setTimeout>;
  tabs: Array<{ id: string }>;
  onSuspend: (tabs: Array<{ id: string }>) => void;
  /** Quiet baseline — activity after this defers suspend until delayMs elapses. */
  backgroundedAt: number;
  delayMs: number;
  isProcessBusy: ProcessBusyChecker;
}

const idleSuspendJobs = new Map<string, IdlePtySuspendJob>();

export interface IdlePtySuspendOptions {
  delayMs?: number;
  onSuspend?: (tabs: Array<{ id: string }>) => void;
  /** Override for tests — when the host was backgrounded. */
  backgroundedAt?: number;
  /** Override for tests — process busy probe. */
  isProcessBusy?: ProcessBusyChecker;
}

/** True when idle-host PTY suspend applies to this connection (local shells are excluded). */
export function shouldIdleSuspendConnection(connectionId: string): boolean {
  return connectionId !== LOCAL_TERMINAL_CONNECTION_ID;
}

/** Split background host tabs: inactive vs last-active (timer scheduling helper). */
export function partitionBackgroundHostTabs(
  tabs: Array<{ id: string }> | undefined,
  lastActiveTabId: string | null | undefined,
): { immediateTabs: Array<{ id: string }>; delayedTabs: Array<{ id: string }> } {
  const list = tabs ?? [];
  if (list.length <= 1 || !lastActiveTabId) {
    return { immediateTabs: [], delayedTabs: list };
  }

  const immediateTabs = list.filter((tab) => tab.id !== lastActiveTabId);
  const delayedTabs = list.filter((tab) => tab.id === lastActiveTabId);
  if (delayedTabs.length === 0) {
    return { immediateTabs: [], delayedTabs: list };
  }

  return { immediateTabs, delayedTabs };
}

async function isTabBusyForIdleSuspend(
  tabId: string,
  backgroundedAt: number,
  isProcessBusy: ProcessBusyChecker,
): Promise<boolean> {
  if (isTerminalBusyForIdleSuspend(tabId, backgroundedAt)) {
    return true;
  }
  return isProcessBusy(tabId);
}

async function partitionTabsForIdleSuspend(
  tabs: Array<{ id: string }>,
  backgroundedAt: number,
  isProcessBusy: ProcessBusyChecker,
): Promise<{ idleTabs: Array<{ id: string }>; busyTabs: Array<{ id: string }> }> {
  const idleTabs: Array<{ id: string }> = [];
  const busyTabs: Array<{ id: string }> = [];

  for (const tab of tabs) {
    if (await isTabBusyForIdleSuspend(tab.id, backgroundedAt, isProcessBusy)) {
      busyTabs.push(tab);
    } else {
      idleTabs.push(tab);
    }
  }

  return { idleTabs, busyTabs };
}

function scheduleNextIdleSuspendAttempt(
  connectionId: string,
  tabs: Array<{ id: string }>,
  baselineMs: number,
  delayMs: number,
): void {
  const latestActivity = getLatestTerminalActivityAt(tabs, baselineMs);
  const waitMs = Math.max(0, latestActivity + delayMs - Date.now());
  const job = idleSuspendJobs.get(connectionId);
  if (!job) {
    return;
  }

  job.timer = setTimeout(() => {
    void runIdleSuspendAttempt(connectionId);
  }, waitMs);
}

async function runIdleSuspendAttempt(connectionId: string): Promise<void> {
  const job = idleSuspendJobs.get(connectionId);
  if (!job) {
    return;
  }

  const { idleTabs, busyTabs } = await partitionTabsForIdleSuspend(
    job.tabs,
    job.backgroundedAt,
    job.isProcessBusy,
  );

  if (idleTabs.length > 0) {
    job.onSuspend(idleTabs);
  }

  if (busyTabs.length > 0) {
    job.tabs = busyTabs;
    job.backgroundedAt = getLatestTerminalActivityAt(busyTabs, job.backgroundedAt);
    scheduleNextIdleSuspendAttempt(connectionId, busyTabs, job.backgroundedAt, job.delayMs);
    return;
  }

  idleSuspendJobs.delete(connectionId);
}

/**
 * Schedule PTY suspend for shell tabs on a background workspace host.
 * Tabs with recent output, buffered input, or running child processes are deferred.
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
  const onSuspend = options.onSuspend ?? ((tabList) => {
    suspendAllTerminalsForConnection(tabList, { idleHost: true });
  });
  const tabSnapshot = tabs.map((tab) => ({ id: tab.id }));
  const backgroundedAt = options.backgroundedAt ?? Date.now();
  const isProcessBusy = options.isProcessBusy ?? isTerminalSessionProcessBusy;

  const timer = setTimeout(() => {
    void runIdleSuspendAttempt(connectionId);
  }, delayMs);

  idleSuspendJobs.set(connectionId, {
    timer,
    tabs: tabSnapshot,
    onSuspend,
    backgroundedAt,
    delayMs,
    isProcessBusy,
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
export async function flushIdlePtySuspend(connectionId: string): Promise<void> {
  const job = idleSuspendJobs.get(connectionId);
  if (!job) {
    return;
  }
  clearTimeout(job.timer);
  await runIdleSuspendAttempt(connectionId);
}