import { suspendTerminalPty, type SuspendTerminalPtyOptions } from './ptyLifecycle.js';

/** Kills live PTYs for a connection while preserving xterm instances and tab metadata. */
export function suspendAllTerminalsForConnection(
  tabs: Array<{ id: string }> | undefined,
  options?: SuspendTerminalPtyOptions,
): void {
  for (const tab of tabs ?? []) {
    suspendTerminalPty(tab.id, options);
  }
}