import { destroyTerminalInstance, getTerminalRecentLines } from './instanceApi.js';
import { suspendAllTerminalsForConnection } from './suspendAllTerminals.js';
import type { SuspendTerminalPtyOptions } from './ptyLifecycle.js';

/**
 * Store- and layout-facing terminal API. Keeps Zustand slices decoupled from
 * scattered `lib/terminal` imports as the module surface grows.
 */
export const terminalService = {
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