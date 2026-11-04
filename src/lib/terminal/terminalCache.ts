import type { Channel } from '@tauri-apps/api/core';
import type { UnlistenFn } from '@tauri-apps/api/event';
import type { FitAddon } from '@xterm/addon-fit';
import type { SearchAddon } from '@xterm/addon-search';
import type { ITerminalAddon, Terminal } from '@xterm/xterm';

import type { InputTracker } from '../ghostSuggestions/inputTracker.js';

/** Original unsent text and one acknowledged delivery owned by a single PTY incarnation. */
export interface TerminalInputWrite {
    generation: number;
    outputChannel?: Channel;
    sources: Array<string | undefined>;
    head: number;
    offset: number;
    running: boolean;
    inFlightBytes: number;
    started: boolean;
    failed: boolean;
    onDiscard(): void;
}

/** One resize acknowledgment and the revision of the latest requested geometry for a PTY owner. */
export interface TerminalResizeWrite {
    generation: number;
    outputChannel?: Channel;
    running: boolean;
    revision: number;
    pending?: Promise<void>;
    failed?: boolean;
}

/** Module-level xterm instances preserved across component remounts. */
export interface TerminalCache {
    term: Terminal;
    fitAddon: FitAddon;
    searchAddon: SearchAddon;
    /** Sixel / iTerm IIP overlay; absent if ImageAddon failed to load. */
    imageAddon?: ITerminalAddon;
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
    inputWrite?: TerminalInputWrite;
    inputFlushTimer: ReturnType<Window['setTimeout']> | null;
    /** Latest fitted size from the UI (retained while PTY is starting). */
    desiredResize: { rows: number; cols: number } | null;
    /** Last size acknowledged by the matching backend PTY owner. */
    lastResize: { rows: number; cols: number } | null;
    resizeWrite?: TerminalResizeWrite;
    unlisten?: UnlistenFn[];
    /** Streaming PTY output channel passed to terminal:create. */
    outputChannel?: Channel;
    /** Owning workspace connection — used to close the tab on natural shell exit. */
    connectionId?: string;
    ghostTracker?: InputTracker;
    /** User pause lasts for this cached terminal, never changes remote configuration. */
    ghostPaused?: boolean;
    /** Invalidates suggestion/output inference across terminal mode transitions. */
    ghostContextEpoch?: number;
    /** False while no mounted input/context observer owns this cache entry. */
    ghostContextActive?: boolean;
    /** Observed PTY CWD only; saved tab paths are not evidence of this shell's CWD. */
    ghostCwd?: { path: string; generation: number };
    /** Invalidates asynchronous suggestions when the observed CWD changes or becomes unknown. */
    ghostCwdRevision?: number;
    /** Parsed by xterm; promoted only by that output frame's generation-checked callback. */
    pendingOsc7Cwd?: string;
    /** Reject output queued before a newer command was actually sent to the PTY. */
    ghostCommandEpoch?: number;
    onDataDisposable?: { dispose: () => void };
    ligaturesAddon?: { dispose: () => void };
    ligaturesEnabled: boolean;
    ligaturesDesiredEnabled?: boolean;
    ligaturesLoadPromise?: Promise<void> | null;
    /** Set after terminal:create fails for a dead SSH backend; cleared on reconnect/ready. */
    spawnBlocked?: boolean;
    /** Shell id/path used for the in-flight PTY spawn — persisted on terminal-ready. */
    pendingSpawnShell?: string;
    /** Shell actually requested for this PTY generation, independent of later settings changes. */
    spawnShell?: string;
    /** Probed from zsh init files when shell is zsh (undefined = not yet known). */
    zshAutosuggestEnabled?: boolean;
    zshAutosuggestProbe?: Promise<boolean>;
    /** Last PTY output or user input timestamp — used to skip idle-host suspend while busy. */
    lastActivityAt?: number;
    /** Idle-suspend banner already written for the current suspend cycle. */
    idleSuspendNoticeShown?: boolean;
}

export const terminalCache = new Map<string, TerminalCache>();

/** Record fresh prompt/OSC 7 evidence without promoting saved or speculative paths. */
export function confirmTerminalGhostCwd(termId: string, path: string, generation: number): boolean {
    const cached = terminalCache.get(termId);
    if (!cached?.spawned || cached.generation !== generation || !path) {
        return false;
    }
    if (cached.ghostCwd?.generation !== generation || cached.ghostCwd.path !== path) {
        cached.ghostCwdRevision = (cached.ghostCwdRevision ?? 0) + 1;
        cached.ghostCwd = { path, generation };
        cached.ghostTracker?.dismissSuggestion();
    }
    return true;
}

/** Relative path completion requires evidence from the current, live PTY. */
export function getTerminalGhostCwd(termId: string): string | undefined {
    const cached = terminalCache.get(termId);
    return cached?.spawned && cached.ghostCwd?.generation === cached.generation
        ? cached.ghostCwd.path
        : undefined;
}

/** Executing input or leaving shell context makes the previous prompt's CWD uncertain. */
export function invalidateTerminalGhostCwd(termId: string): void {
    const cached = terminalCache.get(termId);
    if (!cached) {
        return;
    }
    cached.ghostCwd = undefined;
    cached.ghostCwdRevision = (cached.ghostCwdRevision ?? 0) + 1;
    cached.ghostTracker?.dismissSuggestion();
}

/** Discards queued input and its timer; optionally reports an unsent tail beyond the submitted packet. */
export function clearTerminalPendingInput(
    termId: string | null | undefined,
    notifyDiscard = false,
): void {
    if (!termId) {
        return;
    }

    const cached = terminalCache.get(termId);
    if (!cached) {
        return;
    }

    if (cached.inputFlushTimer !== null) {
        window.clearTimeout(cached.inputFlushTimer);
        cached.inputFlushTimer = null;
    }

    if (notifyDiscard && cached.pendingInputBytes > (cached.inputWrite?.inFlightBytes ?? 0)) {
        cached.inputWrite?.onDiscard();
    }
    if (cached.inputWrite) {
        cached.inputWrite.sources.length = 0;
    }
    cached.inputWrite = undefined;
    cached.pendingInput = '';
    cached.pendingInputBytes = 0;
}
