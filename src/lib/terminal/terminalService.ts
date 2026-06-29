import { destroyTerminalInstance, getTerminalRecentLines } from './instanceApi.js';
import { suspendAllTerminalsForConnection } from './suspendAllTerminals.js';
import type { SuspendTerminalPtyOptions } from './ptyLifecycle.js';
import { terminalCache } from './terminalCache.js';

type CloseTerminalTabHandler = (connectionId: string, termId: string) => void;

let closeTerminalTabHandler: CloseTerminalTabHandler | null = null;

/**
 * Store- and layout-facing terminal API. Keeps Zustand slices decoupled from
 * scattered `lib/terminal` imports as the module surface grows.
 */
export const terminalService = {
  /** Wired from the app shell so terminal modules can close tabs without importing the store. */
  setCloseTabHandler(handler: CloseTerminalTabHandler | null): void {
    closeTerminalTabHandler = handler;
  },

  closeTabOnShellExit(termId: string): void {
    const connectionId = terminalCache.get(termId)?.connectionId;
    if (!connectionId || !closeTerminalTabHandler) {
      return;
    }
    closeTerminalTabHandler(connectionId, termId);
  },

  destroy(sessionId: string): void {
    destroyTerminalInstance(sessionId);
  },

  getRecentLines(sessionId: string, lineCount = 20): string | null {
    return getTerminalRecentLines(sessionId, lineCount);
  },

  suspendAllForConnection(
    tabs: Array<{ id: string }> | undefined,
    options?: SuspendTerminalPtyOptions,
  ): void {
    suspendAllTerminalsForConnection(tabs, options);
  },
} as const;