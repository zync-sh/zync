import type { Terminal as XTerm } from '@xterm/xterm';
import { clearTerminalPendingInput, terminalCache } from './terminalCache.js';
import { spawnTerminalFromStoreContext } from './terminalSpawn.js';
import type { TerminalSpawnTabState } from './spawnContext.js';

export const TERMINAL_CONNECTION_WAKEUP_EVENT = 'connection-wakeup';

/** Notifies visible terminal tabs to spawn PTYs after a successful SSH reconnect. */
export function dispatchTerminalConnectionWakeup(termIds: string[]): void {
  for (const termId of termIds) {
    window.dispatchEvent(new CustomEvent(TERMINAL_CONNECTION_WAKEUP_EVENT, { detail: termId }));
  }
}

export interface ConnectionWakeupContext {
  sessionId: string;
  connectionId: string;
  terminalKey: string;
  term: XTerm;
  isVisible: boolean;
  terminals: Record<string, TerminalSpawnTabState[] | undefined>;
  windowsShell?: string;
  remoteReady?: boolean;
}

/**
 * Spawns a fresh PTY when a reconnect event targets a visible tab that has no live backend.
 * Clears scrollback (clearBuffer) so restored SSH sessions start clean after reconnect.
 */
export function tryWakeTerminalOnReconnect(ctx: ConnectionWakeupContext): boolean {
  if (!ctx.isVisible) {
    return false;
  }

  const cached = terminalCache.get(ctx.sessionId);
  if (!cached || cached.spawned) {
    return false;
  }

  clearTerminalPendingInput(ctx.sessionId);
  cached.lastResize = null;
  return spawnTerminalFromStoreContext({
    sessionId: ctx.sessionId,
    connectionId: ctx.connectionId,
    terminalKey: ctx.terminalKey,
    term: ctx.term,
    clearBuffer: true,
    terminals: ctx.terminals,
    windowsShell: ctx.windowsShell,
    remoteReady: ctx.remoteReady ?? true,
  });
}