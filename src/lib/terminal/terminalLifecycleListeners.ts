import { listen } from '@tauri-apps/api/event';
import type { Terminal as XTerm } from '@xterm/xterm';

import { handleTerminalReady } from './inputPipeline.js';
import { clearTerminalInputQueue } from './inputQueue.js';
import { clearTerminalPendingInput, terminalCache } from './terminalCache.js';
import { writeIdleHostSuspendNotice } from './terminalIdleSuspendNotice.js';
import { clearTerminalResizeState } from './terminalResizeSync.js';
import { terminalService } from './terminalService.js';

export { IDLE_HOST_SUSPEND_MESSAGE } from './terminalIdleSuspendNotice.js';

/** Idle suspend accepts its preceding generation; unrelated shell exits remain stale. */
export function terminalExitGenerationMatches(
    entry: NonNullable<ReturnType<typeof terminalCache.get>>,
    exitGeneration: number,
): boolean {
    if (exitGeneration === entry.generation) {
        return true;
    }
    // suspendTerminalPty bumps generation before the async exit event arrives.
    return Boolean(entry.suspendedByIdle && exitGeneration === entry.generation - 1);
}

export interface TerminalLifecycleEvent {
    generation: number;
    /** Native channel identity also fences generation reuse after webview reload. */
    channel_id?: number;
    exit_code?: number;
}

/** Native events bind to the live channel; omitted IDs preserve legacy browser fixtures only. */
export function terminalLifecycleChannelMatches(
    entry: NonNullable<ReturnType<typeof terminalCache.get>>,
    event: TerminalLifecycleEvent,
): boolean {
    return event.channel_id === undefined || entry.outputChannel?.id === event.channel_id;
}

/** Attaches generation-gated ready and exit listeners once per cached terminal. */
export function attachTerminalLifecycleListeners(sessionId: string, _term: XTerm): void {
    const cached = terminalCache.get(sessionId);
    if (!cached || cached.listenerAttached) {
        return;
    }

    if (!cached.unlisten) {
        cached.unlisten = [];
    }

    // Set early to prevent concurrent attach attempts; catches below handle registration failures without unhandled rejections.
    cached.listenerAttached = true;

    listen<TerminalLifecycleEvent>(`terminal-ready-${sessionId}`, (event) => {
        const entry = terminalCache.get(sessionId);
        if (!entry || !terminalLifecycleChannelMatches(entry, event.payload)) {
            return;
        }
        handleTerminalReady(sessionId, event.payload.generation);
    })
        .then((unlistenFn) => {
            if (terminalCache.has(sessionId)) {
                terminalCache.get(sessionId)?.unlisten?.push(unlistenFn);
            }
        })
        .catch((e) => console.warn(`[terminal] ready listener attach failed for ${sessionId}`, e));

    listen<TerminalLifecycleEvent>(`terminal-exit-${sessionId}`, (event) => {
        const entry = terminalCache.get(sessionId);
        if (!entry) {
            return;
        }

        if (
            !terminalLifecycleChannelMatches(entry, event.payload) ||
            !terminalExitGenerationMatches(entry, event.payload.generation)
        ) {
            return;
        }

        const suspendedForPanel = entry.suspendedByPanel;
        const suspendedForIdle = entry.suspendedByIdle;
        entry.suspendedByPanel = false;
        entry.starting = false;
        entry.spawned = false;
        clearTerminalPendingInput(sessionId, !suspendedForPanel && !suspendedForIdle);
        clearTerminalInputQueue(sessionId);
        clearTerminalResizeState(sessionId);

        if (suspendedForIdle) {
            writeIdleHostSuspendNotice(sessionId);
        } else if (!suspendedForPanel) {
            terminalService.closeTabOnShellExit(sessionId);
        }
    })
        .then((unlistenFn) => {
            if (terminalCache.has(sessionId)) {
                terminalCache.get(sessionId)?.unlisten?.push(unlistenFn);
            }
        })
        .catch((e) => console.warn(`[terminal] exit listener attach failed for ${sessionId}`, e));

    // listenerAttached was already set before the async registrations to guard against concurrent calls
}
