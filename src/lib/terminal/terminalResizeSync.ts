import type { Terminal as XTerm } from '@xterm/xterm';

import { type TerminalCache, type TerminalResizeWrite, terminalCache } from './terminalCache.js';
import { safeFitTerminal } from './terminalFit.js';

export type TerminalSize = { rows: number; cols: number };

/** Compares cell geometry without treating unknown sizes as acknowledged. */
function sizesEqual(
    a: TerminalSize | null | undefined,
    b: TerminalSize | null | undefined,
): boolean {
    return Boolean(a && b && a.rows === b.rows && a.cols === b.cols);
}

/** Ready gating retains geometry until a PTY can accept it. */
function isPtyLive(cached: TerminalCache): boolean {
    return Boolean(cached.spawned && !cached.starting);
}

/** Late resize acknowledgments may only update their exact cached PTY/channel owner. */
function ownsResize(termId: string, cached: TerminalCache, state: TerminalResizeWrite): boolean {
    return (
        terminalCache.get(termId) === cached &&
        cached.resizeWrite === state &&
        cached.generation === state.generation &&
        cached.outputChannel === state.outputChannel
    );
}

/** Sends one geometry at a time and follows it only with the latest coalesced request. */
async function drainResize(
    termId: string,
    cached: TerminalCache,
    state: TerminalResizeWrite,
): Promise<void> {
    state.running = true;
    try {
        while (ownsResize(termId, cached, state) && isPtyLive(cached)) {
            const size = cached.desiredResize;
            if (!size || sizesEqual(cached.lastResize, size)) {
                return;
            }
            const revision = state.revision;
            try {
                await window.ipcRenderer.invoke('terminal:resize', {
                    termId,
                    ...size,
                    ...(state.outputChannel
                        ? { generation: state.generation, channelId: state.outputChannel.id }
                        : {}),
                });
            } catch {
                if (!ownsResize(termId, cached, state)) {
                    return;
                }
                // Keep the desired geometry eligible for a later fit/ready retry.
                cached.lastResize = null;
                state.failed = true;
                console.warn('[terminal] resize was not acknowledged');
                if (state.revision === revision) {
                    return;
                }
                continue;
            }
            if (!ownsResize(termId, cached, state)) {
                return;
            }
            cached.lastResize = size;
            state.failed = false;
        }
    } finally {
        state.running = false;
    }
}

/** Starts delivery without another queue of intermediate window sizes or retry timers. */
function requestResize(termId: string, cached: TerminalCache): boolean {
    if (!isPtyLive(cached)) {
        return false;
    }
    let state = cached.resizeWrite;
    if (
        state &&
        (state.generation !== cached.generation || state.outputChannel !== cached.outputChannel)
    ) {
        cached.lastResize = null;
        state = undefined;
    }
    state ??= {
        generation: cached.generation,
        outputChannel: cached.outputChannel,
        running: false,
        revision: 0,
    };
    cached.resizeWrite = state;
    state.revision++;
    if (state.running || sizesEqual(cached.lastResize, cached.desiredResize)) {
        return false;
    }
    state.pending = drainResize(termId, cached, state);
    return true;
}

/** Orders input behind requested geometry without delaying typing at an already acknowledged size. */
export async function waitForTerminalResize(
    termId: string,
    cached: TerminalCache,
): Promise<boolean> {
    const state = cached.resizeWrite;
    if (!state) {
        return true;
    }
    while (ownsResize(termId, cached, state) && state.running && state.pending) {
        await state.pending;
    }
    return !ownsResize(termId, cached, state) || !state.failed;
}

/** Records the latest UI size; ready/live PTYs receive acknowledged, latest-only geometry. */
export function syncTerminalResize(termId: string | null | undefined, term: XTerm): void {
    if (!termId) {
        return;
    }
    const cached = terminalCache.get(termId);
    if (!cached || cached.term !== term) {
        return;
    }
    cached.desiredResize = { rows: term.rows, cols: term.cols };
    requestResize(termId, cached);
}

/** Fits the current live terminal and returns whether a resize invocation started immediately. */
export function flushTerminalResize(termId: string | null | undefined): boolean {
    if (!termId) {
        return false;
    }
    const cached = terminalCache.get(termId);
    if (!cached || !isPtyLive(cached)) {
        return false;
    }
    safeFitTerminal(cached.fitAddon, cached.term);
    cached.desiredResize = { rows: cached.term.rows, cols: cached.term.cols };
    return requestResize(termId, cached);
}

/** Clears desired/acknowledged sizes and invalidates pending callbacks on reconnect/suspend/exit. */
export function clearTerminalResizeState(termId: string | null | undefined): void {
    if (!termId) {
        return;
    }
    const cached = terminalCache.get(termId);
    if (!cached) {
        return;
    }
    cached.resizeWrite = undefined;
    cached.desiredResize = null;
    cached.lastResize = null;
}
