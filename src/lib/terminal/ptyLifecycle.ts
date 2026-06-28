import type { Terminal as XTerm } from '@xterm/xterm';
import { isConnectionBackendLive } from './connectionBackend.js';
import { clearTerminalInputQueue } from './inputQueue.js';
import { clearTerminalPendingInput, terminalCache } from './terminalCache.js';
import {
  formatTerminalSpawnError,
  isTerminalSpawnConnectionNotReadyError,
} from './terminalSpawnErrors.js';
import { clearIdleHostSuspendNotice, writeIdleHostSuspendNotice } from './terminalIdleSuspendNotice.js';

export interface SpawnTerminalSessionOptions {
  termId: string;
  connectionId: string;
  term: XTerm;
  /** Clear xterm scrollback — use for fresh tabs and explicit restarts, not tab switches. */
  clearBuffer?: boolean;
  cwd?: string;
  shell?: string;
  /** When false, remote (non-local) spawns are skipped until SSH connect completes. */
  remoteReady?: boolean;
}

/**
 * Starts a backend PTY for an existing cached xterm instance.
 * Returns false when spawn is already in flight or the session is live.
 */
export function spawnTerminalSession(options: SpawnTerminalSessionOptions): boolean {
  const { termId, connectionId, term, clearBuffer = false, cwd, shell, remoteReady = true } = options;
  const cached = terminalCache.get(termId);
  if (!cached || cached.spawned || cached.starting || cached.spawnBlocked) {
    return false;
  }

  if (connectionId !== 'local' && (!remoteReady || !isConnectionBackendLive(connectionId))) {
    return false;
  }

  const generation = cached.generation + 1;
  cached.generation = generation;
  cached.spawned = true;
  cached.starting = true;
  cached.suspendedByPanel = false;

  if (clearBuffer) {
    term.clear();
    term.reset();
  }

  window.ipcRenderer
    .invoke('terminal:create', {
      termId,
      connectionId,
      rows: term.rows,
      cols: term.cols,
      shell,
      cwd,
      generation,
    })
    .catch((err) => {
      console.error('Failed to create terminal:', err);
      const message = formatTerminalSpawnError(err);
      term.write(`\r\n\x1b[31mFailed to start terminal session: ${message}\x1b[0m\r\n`);
      if (cached.generation === generation) {
        cached.starting = false;
        cached.spawned = false;
        if (
          connectionId !== 'local'
          && isTerminalSpawnConnectionNotReadyError(err, connectionId)
        ) {
          cached.spawnBlocked = true;
        }
      }
    });

  return true;
}

export interface SuspendTerminalPtyOptions {
  /**
   * When true, suppresses the "session ended" message on the next matching exit event.
   * Only set for Files/Dashboard view transitions — not tab or host switches.
   */
  panelHide?: boolean;
  /**
   * When true, marks the session idle-suspended — scrollback preserved, no auto-respawn
   * until the user presses Enter.
   */
  idleHost?: boolean;
}

/** Whether auto-spawn paths should skip this session (idle-host suspend awaiting Enter). */
export function isTerminalIdleSuspended(termId: string): boolean {
  return Boolean(terminalCache.get(termId)?.suspendedByIdle);
}

/**
 * Clears stale backend/session state after SSH reconnect while keeping xterm scrollback.
 * Use before spawning a fresh PTY on an existing tab id.
 */
export function resetTerminalPtyForReconnect(termId: string): void {
  const cached = terminalCache.get(termId);
  if (!cached) {
    return;
  }

  if (cached.spawned) {
    window.ipcRenderer.send('terminal:kill', { termId });
  }

  clearTerminalPendingInput(termId);
  clearTerminalInputQueue(termId);
  cached.generation += 1;
  cached.spawned = false;
  cached.starting = false;
  cached.suspendedByPanel = false;
  cached.suspendedByIdle = false;
  clearIdleHostSuspendNotice(termId);
  cached.spawnBlocked = false;
  cached.lastResize = null;
}

/** Closes the backend PTY while preserving the cached xterm instance and scrollback. */
export function suspendTerminalPty(termId: string, options?: SuspendTerminalPtyOptions): void {
  const cached = terminalCache.get(termId);
  if (!cached?.spawned) {
    return;
  }

  clearTerminalPendingInput(termId);
  clearTerminalInputQueue(termId);
  if (options?.idleHost) {
    cached.suspendedByIdle = true;
    writeIdleHostSuspendNotice(termId);
  }
  window.ipcRenderer.send('terminal:kill', { termId });
  cached.generation += 1;
  cached.spawned = false;
  cached.starting = false;
  cached.suspendedByPanel = options?.panelHide ?? false;
  cached.lastResize = null;
}