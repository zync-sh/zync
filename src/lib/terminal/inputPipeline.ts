import { useAppStore } from '../../store/useAppStore.js';
import { clearPromptCwdSniffer } from '../ghostSuggestions/promptCwdSniffer.js';
import { scheduleZshAutosuggestProbe } from '../ghostSuggestions/zshAutosuggestDetect.js';
import { isWin32Platform, resolveLocalWindowsShellId } from './spawnContext.js';
import { touchTerminalActivity } from './terminalActivity.js';
import {
    invalidateTerminalGhostCwd,
    type TerminalCache,
    type TerminalInputWrite,
    terminalCache,
} from './terminalCache.js';
import { clearIdleHostSuspendNotice } from './terminalIdleSuspendNotice.js';
import {
    flushTerminalResize,
    syncTerminalResize,
    waitForTerminalResize,
} from './terminalResizeSync.js';

const INPUT_BATCH_MS = 4;
const INPUT_FLUSH_THRESHOLD = 64;
export const TERMINAL_INPUT_CHUNK_BYTES = 16 * 1024;
const inputEncoder = new TextEncoder();
// A terminal packet is raw input: a leading U+FEFF is content, not a file BOM.
const inputDecoder = new TextDecoder('utf-8', { ignoreBOM: true });
const IMMEDIATE_INPUT_PATTERN = /[\r\n\x03\x04\x1b]/;

/** Counts UTF-8 bytes without allocating an encoded copy of an entire paste. */
function inputBytes(text: string): number {
    let bytes = 0;
    for (let index = 0; index < text.length; index++) {
        const code = text.charCodeAt(index);
        if (code < 0x80) {
            bytes++;
        } else if (code < 0x800) {
            bytes += 2;
        } else if (
            code >= 0xd800 &&
            code <= 0xdbff &&
            text.charCodeAt(index + 1) >= 0xdc00 &&
            text.charCodeAt(index + 1) <= 0xdfff
        ) {
            bytes += 4;
            index++;
        } else {
            bytes += 3;
        }
    }
    return bytes;
}

/** Selects one UTF-8-bounded string packet without splitting a surrogate pair. */
export function terminalInputChunk(
    text: string,
    start: number,
): { data: string; bytes: number; end: number } {
    let end = start;
    let bytes = 0;
    while (end < text.length) {
        const code = text.charCodeAt(end);
        const pair =
            code >= 0xd800 &&
            code <= 0xdbff &&
            text.charCodeAt(end + 1) >= 0xdc00 &&
            text.charCodeAt(end + 1) <= 0xdfff;
        const width = code < 0x80 ? 1 : code < 0x800 ? 2 : pair ? 4 : 3;
        if (bytes + width > TERMINAL_INPUT_CHUNK_BYTES) {
            break;
        }
        bytes += width;
        end += pair ? 2 : 1;
    }
    // Detach a bounded copy: a substring held by blocked IPC must not retain a discarded paste.
    return { data: inputDecoder.decode(inputEncoder.encode(text.slice(start, end))), bytes, end };
}

/** Reports uncertain delivery without exposing input text or automatically replaying commands. */
function reportInputInterruption(): void {
    useAppStore
        .getState()
        .showToast(
            'error',
            'Terminal input was interrupted. Some queued input may not have been sent; restart the shell before retrying.',
        );
}

/** Binds queued source strings to their PTY, permitting initial ready gating but never old-session replay. */
function inputWriter(cached: TerminalCache): TerminalInputWrite {
    const previous = cached.inputWrite;
    if (
        previous &&
        (previous.generation !== cached.generation ||
            previous.outputChannel !== cached.outputChannel)
    ) {
        if (!previous.started) {
            previous.generation = cached.generation;
            previous.outputChannel = cached.outputChannel;
        } else {
            if (cached.pendingInputBytes > 0) {
                previous.onDiscard();
            }
            previous.sources.length = 0;
            cached.pendingInput = '';
            cached.pendingInputBytes = 0;
            cached.inputWrite = undefined;
        }
    }
    return (cached.inputWrite ??= {
        generation: cached.generation,
        outputChannel: cached.outputChannel,
        sources: [],
        head: 0,
        offset: 0,
        running: false,
        inFlightBytes: 0,
        started: false,
        failed: false,
        onDiscard: reportInputInterruption,
    });
}

/** True only while this queue still belongs to the live cached session and native output channel. */
function ownsInput(termId: string, cached: TerminalCache, state: TerminalInputWrite): boolean {
    return (
        terminalCache.get(termId) === cached &&
        cached.inputWrite === state &&
        cached.generation === state.generation &&
        cached.outputChannel === state.outputChannel
    );
}

/** Delivers one IPC packet at a time, retaining source text until the native writer acknowledges it. */
async function drainInput(
    termId: string,
    cached: TerminalCache,
    state: TerminalInputWrite,
): Promise<void> {
    state.running = true;
    try {
        while (
            ownsInput(termId, cached, state) &&
            cached.spawned &&
            !cached.starting &&
            state.head < state.sources.length
        ) {
            const acknowledgedSize = cached.lastResize;
            if (
                !acknowledgedSize ||
                acknowledgedSize.cols !== cached.term.cols ||
                acknowledgedSize.rows !== cached.term.rows
            ) {
                // Input is a synchronization boundary even during a UI-only divider drag.
                syncTerminalResize(termId, cached.term);
            }
            if (cached.resizeWrite?.running) {
                const acknowledged = await waitForTerminalResize(termId, cached);
                if (!ownsInput(termId, cached, state) || !cached.spawned || cached.starting) {
                    return;
                }
                // Another resize can start between the two promise continuations.
                if (acknowledged || cached.resizeWrite?.running) {
                    continue;
                }
                // Resize is advisory: an error must not discard text that has not been written.
            }
            const sourceLength = state.sources[state.head]!.length;
            const packet = terminalInputChunk(state.sources[state.head]!, state.offset);
            if (/[\r\n]/.test(packet.data)) {
                cached.ghostCommandEpoch = (cached.ghostCommandEpoch ?? 0) + 1;
                invalidateTerminalGhostCwd(termId);
                clearPromptCwdSniffer(termId);
            }
            state.started = true;
            state.inFlightBytes = packet.bytes;
            await window.ipcRenderer.invoke('terminal:write', {
                termId,
                data: packet.data,
                ...(state.outputChannel
                    ? { generation: state.generation, channelId: state.outputChannel.id }
                    : {}),
            });
            if (!ownsInput(termId, cached, state)) {
                return;
            }
            touchTerminalActivity(termId);
            cached.pendingInputBytes = Math.max(0, cached.pendingInputBytes - packet.bytes);
            state.inFlightBytes = 0;
            state.offset = packet.end;
            if (state.offset === sourceLength) {
                state.sources[state.head++] = undefined;
                state.offset = 0;
            }
            if (state.head === state.sources.length) {
                state.sources.length = 0;
                state.head = 0;
            } else if (state.head >= 64 && state.head * 2 >= state.sources.length) {
                state.sources.splice(0, state.head);
                state.head = 0;
            }
        }
    } catch {
        if (!ownsInput(termId, cached, state)) {
            return;
        }
        state.failed = true;
        state.sources.length = 0;
        cached.pendingInput = '';
        cached.pendingInputBytes = 0;
        state.onDiscard();
    } finally {
        state.running = false;
    }
}

/** Moves the small typing batch into the source queue without copying previously queued paste text. */
function stageInput(cached: TerminalCache, state: TerminalInputWrite): void {
    if (cached.pendingInput) {
        state.sources.push(cached.pendingInput);
    }
    cached.pendingInput = '';
}

/** Indicates whether a live PTY can currently accept input. */
export function canSendTerminalInput(termId: string | null | undefined): boolean {
    if (!termId) {
        return false;
    }
    const cached = terminalCache.get(termId);
    return Boolean(cached && cached.spawned && !cached.starting);
}

/**
 * Starts ordered acknowledged delivery of queued input in bounded IPC packets.
 * Held while `starting` until `handleTerminalReady` flushes the buffer.
 */
export function flushPendingInput(termId: string | null | undefined): void {
    if (!termId) {
        return;
    }

    const cached = terminalCache.get(termId);
    if (!cached || cached.starting || !cached.spawned) {
        return;
    }

    if (cached.inputFlushTimer !== null) {
        window.clearTimeout(cached.inputFlushTimer);
        cached.inputFlushTimer = null;
    }

    const state = inputWriter(cached);
    if (state.failed) {
        return;
    }
    stageInput(cached, state);
    if (!state.running && state.sources.length) {
        void drainInput(termId, cached, state);
    }
}

/**
 * Queues terminal input for a short batching window while still flushing
 * immediately for control-sensitive keys and larger chunks.
 * Buffers without IPC while the PTY session is still starting.
 */
export function queueTerminalInput(termId: string | null | undefined, data: string): void {
    if (!termId) {
        return;
    }

    const cached = terminalCache.get(termId);
    if (!cached) {
        return;
    }

    if (!data) {
        return;
    }
    const state = inputWriter(cached);
    if (state.failed) {
        return;
    }
    cached.pendingInputBytes = (cached.pendingInputBytes || 0) + inputBytes(data);
    if (data.length >= INPUT_FLUSH_THRESHOLD) {
        stageInput(cached, state);
        state.sources.push(data);
    } else {
        cached.pendingInput += data;
    }
    touchTerminalActivity(termId);

    if (!cached.spawned || cached.starting) {
        return;
    }

    const bufferedBytes = cached.pendingInputBytes;
    const shouldFlushImmediately =
        bufferedBytes >= INPUT_FLUSH_THRESHOLD || IMMEDIATE_INPUT_PATTERN.test(data);

    if (shouldFlushImmediately) {
        flushPendingInput(termId);
        return;
    }

    if (cached.inputFlushTimer === null) {
        cached.inputFlushTimer = window.setTimeout(() => {
            if (terminalCache.get(termId) === cached && cached.generation === state.generation) {
                flushPendingInput(termId);
            }
        }, INPUT_BATCH_MS);
    }
}

/** Called when `terminal-ready` arrives for the active generation. */
export function handleTerminalReady(termId: string, generation: number): boolean {
    const cached = terminalCache.get(termId);
    if (!cached || cached.generation !== generation) {
        return false;
    }

    cached.starting = false;
    cached.spawned = true;
    cached.spawnBlocked = false;
    cached.suspendedByIdle = false;
    if (cached.connectionId) {
        const store = useAppStore.getState();
        const pendingSpawnShell = cached.pendingSpawnShell;
        cached.pendingSpawnShell = undefined;
        const termTab = store.terminals[cached.connectionId]?.find((t) => t.id === termId);
        if (pendingSpawnShell && !termTab?.shellOverride) {
            // Stamp shell at spawn so tab icons stay fixed. PowerShell expand is Windows-only.
            let stamped: string | undefined = pendingSpawnShell;
            if (cached.connectionId === 'local') {
                if (isWin32Platform()) {
                    stamped = resolveLocalWindowsShellId(pendingSpawnShell);
                } else {
                    const trimmed = pendingSpawnShell.trim();
                    stamped = !trimmed || trimmed === 'default' ? undefined : trimmed;
                }
            }
            if (stamped) {
                store.setTerminalShellOverride(cached.connectionId, termId, stamped);
            }
        }
        const shellId =
            termTab?.shellOverride ??
            pendingSpawnShell ??
            (cached.connectionId === 'local' ? store.settings.localTerm?.windowsShell : undefined);
        scheduleZshAutosuggestProbe(termId, cached.connectionId, shellId);
        // SFTP cwd and `wsl.exe pwd` describe separate processes, not this PTY.
        // Await prompt/OSC 7 evidence instead of letting delayed probes overwrite it.
    }
    clearIdleHostSuspendNotice(termId);
    // Confirm the current cell geometry before ready-gated text reaches the shell.
    flushTerminalResize(termId);
    flushPendingInput(termId);
    return true;
}
