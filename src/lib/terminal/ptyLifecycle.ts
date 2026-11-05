import type { Terminal as XTerm } from '@xterm/xterm';

import { isConnectionBackendLive } from './connectionBackend.js';
import { clearTerminalInputQueue } from './inputQueue.js';
import {
    clearTerminalPendingInput,
    invalidateTerminalGhostCwd,
    terminalCache,
} from './terminalCache.js';
import {
    clearIdleHostSuspendNotice,
    writeIdleHostSuspendNotice,
} from './terminalIdleSuspendNotice.js';
import { attachTerminalOutputChannel } from './terminalOutputStream.js';
import { clearTerminalResizeState } from './terminalResizeSync.js';
import {
    formatTerminalSpawnError,
    isTerminalSpawnConnectionNotReadyError,
} from './terminalSpawnErrors.js';

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
 * Creation failures may update only the same cache, xterm, generation and channel owner.
 */
export function spawnTerminalSession(options: SpawnTerminalSessionOptions): boolean {
    const {
        termId,
        connectionId,
        term,
        clearBuffer = false,
        cwd,
        shell,
        remoteReady = true,
    } = options;
    const cached = terminalCache.get(termId);
    if (!cached || cached.spawned || cached.starting || cached.spawnBlocked) {
        return false;
    }

    if (connectionId !== 'local' && (!remoteReady || !isConnectionBackendLive(connectionId))) {
        return false;
    }

    const generation = cached.generation + 1;
    cached.generation = generation;
    cached.connectionId = connectionId;
    cached.pendingSpawnShell = shell;
    cached.spawnShell = shell;
    cached.zshAutosuggestEnabled = undefined;
    cached.zshAutosuggestProbe = undefined;
    invalidateTerminalGhostCwd(termId);
    cached.spawned = true;
    cached.starting = true;
    cached.suspendedByPanel = false;
    cached.desiredResize = { rows: term.rows, cols: term.cols };
    // Create tells the backend this size; lastResize stays null until ready flush
    // or a live sync confirms the backend has caught up to desiredResize.

    if (clearBuffer) {
        term.clear();
        term.reset();
    }

    const outputChannel = attachTerminalOutputChannel(termId, term);

    window.ipcRenderer
        .invoke('terminal:create', {
            termId,
            connectionId,
            rows: term.rows,
            cols: term.cols,
            shell,
            cwd,
            generation,
            outputChannel,
        })
        .catch((err) => {
            // Reset/dispose may replace an in-flight create, including reusing its
            // generation after reload. Obsolete rejection is not the new shell's error.
            if (
                terminalCache.get(termId) !== cached ||
                cached.term !== term ||
                cached.generation !== generation ||
                cached.outputChannel !== outputChannel
            ) {
                return;
            }
            console.error('Failed to create terminal:', err);
            const message = formatTerminalSpawnError(err);
            term.write(`\r\n\x1b[31mFailed to start terminal session: ${message}\x1b[0m\r\n`);
            cached.starting = false;
            cached.spawned = false;
            if (
                connectionId !== 'local' &&
                isTerminalSpawnConnectionNotReadyError(err, connectionId)
            ) {
                cached.spawnBlocked = true;
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

    clearTerminalPendingInput(termId, true);
    clearTerminalInputQueue(termId);
    cached.generation += 1;
    cached.spawned = false;
    cached.starting = false;
    cached.suspendedByPanel = false;
    cached.suspendedByIdle = false;
    clearIdleHostSuspendNotice(termId);
    cached.spawnBlocked = false;
    clearTerminalResizeState(termId);
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
    clearTerminalResizeState(termId);
}
