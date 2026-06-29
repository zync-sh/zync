import type { Terminal } from '@xterm/xterm';
import type { FitAddon } from '@xterm/addon-fit';
import type { SearchAddon } from '@xterm/addon-search';
import type { Channel } from '@tauri-apps/api/core';
import type { UnlistenFn } from '@tauri-apps/api/event';
import type { InputTracker } from '../ghostSuggestions/inputTracker.js';

/** Module-level xterm instances preserved across component remounts. */
export interface TerminalCache {
  term: Terminal;
  fitAddon: FitAddon;
  searchAddon: SearchAddon;
  generation: number;
  spawned: boolean;
  starting: boolean;
  /** Set when the PTY was closed because the terminal panel was hidden (not tab switch). */
  suspendedByPanel?: boolean;
  /** Set when the PTY was closed by idle-host suspend — blocks auto-respawn until Enter. */
  suspendedByIdle?: boolean;
  listenerAttached: boolean;
  pendingInput: string;
  pendingInputBytes: number;
  inputFlushTimer: ReturnType<typeof window.setTimeout> | null;
  lastResize: { rows: number; cols: number } | null;
  unlisten?: UnlistenFn[];
  /** Streaming PTY output channel passed to terminal:create. */
  outputChannel?: Channel;
  /** Owning workspace connection — used to close the tab on natural shell exit. */
  connectionId?: string;
  ghostTracker?: InputTracker;
  onDataDisposable?: { dispose: () => void };
  ligaturesAddon?: { dispose: () => void };
  ligaturesEnabled: boolean;
  ligaturesDesiredEnabled?: boolean;
  ligaturesLoadPromise?: Promise<void> | null;
  /** Set after terminal:create fails for a dead SSH backend; cleared on reconnect/ready. */
  spawnBlocked?: boolean;
  /** Last PTY output or user input timestamp — used to skip idle-host suspend while busy. */
  lastActivityAt?: number;
  /** Idle-suspend banner already written for the current suspend cycle. */
  idleSuspendNoticeShown?: boolean;
}

export const terminalCache = new Map<string, TerminalCache>();

export function clearTerminalPendingInput(termId: string | null | undefined): void {
  if (!termId) return;

  const cached = terminalCache.get(termId);
  if (!cached) return;

  if (cached.inputFlushTimer !== null) {
    window.clearTimeout(cached.inputFlushTimer);
    cached.inputFlushTimer = null;
  }

  cached.pendingInput = '';
  cached.pendingInputBytes = 0;
}