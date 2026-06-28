import type { Terminal as XTerm } from '@xterm/xterm';
import { listen } from '@tauri-apps/api/event';
import { clearTerminalInputQueue } from './inputQueue.js';
import { handleTerminalReady } from './inputPipeline.js';
import { clearTerminalPendingInput, terminalCache } from './terminalCache.js';
import { touchTerminalActivity } from './terminalActivity.js';
import { writeIdleHostSuspendNotice } from './terminalIdleSuspendNotice.js';
import { decodeTerminalOutputData, type TerminalOutputData } from './terminalOutputPayload.js';

export { IDLE_HOST_SUSPEND_MESSAGE } from './terminalIdleSuspendNotice.js';

export function terminalExitGenerationMatches(entry: NonNullable<ReturnType<typeof terminalCache.get>>, exitGeneration: number): boolean {
  if (exitGeneration === entry.generation) {
    return true;
  }
  // suspendTerminalPty bumps generation before the async exit event arrives.
  return Boolean(entry.suspendedByIdle && exitGeneration === entry.generation - 1);
}

export interface TerminalLifecycleEvent {
  generation: number;
  exit_code?: number;
}

export interface TerminalOutputEvent extends TerminalLifecycleEvent {
  data: TerminalOutputData;
}

/** Attaches generation-gated output, ready, and exit listeners once per cached terminal. */
export function attachTerminalLifecycleListeners(sessionId: string, term: XTerm): void {
  const cached = terminalCache.get(sessionId);
  if (!cached || cached.listenerAttached) {
    return;
  }

  if (!cached.unlisten) {
    cached.unlisten = [];
  }

  // Set early to prevent concurrent attach attempts; catches below handle registration failures without unhandled rejections.
  cached.listenerAttached = true;

  listen<TerminalOutputEvent>(`terminal-output-${sessionId}`, (event) => {
    const entry = terminalCache.get(sessionId);
    if (!entry || event.payload.generation !== entry.generation) {
      return;
    }
    touchTerminalActivity(sessionId);
    term.write(decodeTerminalOutputData(event.payload.data));
  }).then((unlistenFn) => {
    if (terminalCache.has(sessionId)) {
      terminalCache.get(sessionId)?.unlisten?.push(unlistenFn);
    }
  }).catch((e) => console.warn(`[terminal] output listener attach failed for ${sessionId}`, e));

  listen<TerminalLifecycleEvent>(`terminal-ready-${sessionId}`, (event) => {
    handleTerminalReady(sessionId, event.payload.generation);
  }).then((unlistenFn) => {
    if (terminalCache.has(sessionId)) {
      terminalCache.get(sessionId)?.unlisten?.push(unlistenFn);
    }
  }).catch((e) => console.warn(`[terminal] ready listener attach failed for ${sessionId}`, e));

  listen<TerminalLifecycleEvent>(`terminal-exit-${sessionId}`, (event) => {
    const entry = terminalCache.get(sessionId);
    if (!entry) {
      return;
    }

    if (!terminalExitGenerationMatches(entry, event.payload.generation)) {
      return;
    }

    const suspendedForPanel = entry.suspendedByPanel;
    const suspendedForIdle = entry.suspendedByIdle;
    entry.suspendedByPanel = false;
    entry.starting = false;
    entry.spawned = false;
    clearTerminalPendingInput(sessionId);
    clearTerminalInputQueue(sessionId);
    entry.lastResize = null;

    if (suspendedForIdle) {
      writeIdleHostSuspendNotice(sessionId);
    } else if (!suspendedForPanel) {
      term.write('\r\n\x1b[33m[Terminal session ended. Press Enter to restart.]\x1b[0m\r\n');
    }
  }).then((unlistenFn) => {
    if (terminalCache.has(sessionId)) {
      terminalCache.get(sessionId)?.unlisten?.push(unlistenFn);
    }
  }).catch((e) => console.warn(`[terminal] exit listener attach failed for ${sessionId}`, e));

  // listenerAttached was already set before the async registrations to guard against concurrent calls
}