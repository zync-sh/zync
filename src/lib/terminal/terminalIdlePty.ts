import { suspendAllTerminalsForConnection } from './suspendAllTerminals.js';

/** Default delay before suspending PTYs on a background workspace host. */
export const DEFAULT_IDLE_PTY_SUSPEND_MS = 120_000;

interface IdlePtySuspendJob {
  timer: ReturnType<typeof setTimeout>;
  tabs: Array<{ id: string }>;
  onSuspend: (tabs: Array<{ id: string }>) => void;
}

const idleSuspendJobs = new Map<string, IdlePtySuspendJob>();

export interface IdlePtySuspendOptions {
  delayMs?: number;
  onSuspend?: (tabs: Array<{ id: string }>) => void;
}

/**
 * Schedule PTY suspend for all shell tabs on a connection after the workspace
 * host goes idle (another sidebar host selected).
 *
 * Not wired in the app — remote SSH respawn injects a fresh `Last login` banner
 * and feels like a cleared terminal. Re-enable only behind an opt-in setting
 * with manual respawn (Enter) after idle kill.
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
  const onSuspend = options.onSuspend ?? suspendAllTerminalsForConnection;
  const tabSnapshot = tabs.map((tab) => ({ id: tab.id }));

  const timer = setTimeout(() => {
    idleSuspendJobs.delete(connectionId);
    onSuspend(tabSnapshot);
  }, delayMs);

  idleSuspendJobs.set(connectionId, { timer, tabs: tabSnapshot, onSuspend });
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
  idleSuspendJobs.delete(connectionId);
  job.onSuspend(job.tabs);
}