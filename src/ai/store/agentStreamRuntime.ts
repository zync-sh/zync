/** Presentation cadence; terminal and structural events always flush immediately. */
export const AGENT_STREAM_FLUSH_MS = 50;
/** A delayed/background timer cannot retain more than this many queued characters. */
export const MAX_PENDING_STREAM_CHARS = 64 * 1024;

export type StreamSchedule = (callback: () => void, delayMs: number) => () => void;

interface StreamTarget {
    isCurrent: () => boolean;
    appendThinking: (text: string) => void;
    appendToolOutput: (toolCallId: string, text: string) => void;
}

interface PendingChunk {
    toolCallId: string | undefined;
    parts: string[];
}

/** Uses a cancellable timeout so hidden panes do not depend on animation frames. */
function scheduleFlush(callback: () => void, delayMs: number): () => void {
    const timer = setTimeout(callback, delayMs);
    return () => clearTimeout(timer);
}

/** Batches adjacent stream fragments while retaining scope ownership and event ordering. */
export function createAgentStreamBuffer(
    target: StreamTarget,
    schedule: StreamSchedule = scheduleFlush,
) {
    let pending: PendingChunk[] = [];
    let pendingChars = 0;
    let cancelTimer: (() => void) | null = null;
    let timerGeneration = 0;
    let disposed = false;

    /** Cancels the one pending wake-up before a structural flush or disposal. */
    function cancelPendingTimer(): void {
        timerGeneration++;
        cancelTimer?.();
        cancelTimer = null;
    }

    /** Discards obsolete chunks without writing them back into a cleared or replaced run. */
    function clear(): void {
        cancelPendingTimer();
        pending = [];
        pendingChars = 0;
    }

    /** Publishes each adjacent group once, joining its fragments only at the presentation boundary. */
    function flush(): void {
        cancelPendingTimer();
        const chunks = pending;
        pending = [];
        pendingChars = 0;
        if (disposed || !target.isCurrent()) {
            return;
        }
        for (const chunk of chunks) {
            if (!target.isCurrent()) {
                return;
            }
            const text = chunk.parts.join('');
            if (chunk.toolCallId === undefined) {
                target.appendThinking(text);
            } else {
                target.appendToolOutput(chunk.toolCallId, text);
            }
        }
    }

    /** Queues one fragment, forcing a bounded flush if a background timer has been delayed. */
    function queue(toolCallId: string | undefined, text: string): void {
        if (disposed || !text) {
            return;
        }
        if (!target.isCurrent()) {
            clear();
            return;
        }
        const last = pending[pending.length - 1];
        if (last && last.toolCallId === toolCallId) {
            last.parts.push(text);
        } else {
            pending.push({ toolCallId, parts: [text] });
        }
        pendingChars += text.length;
        if (pendingChars >= MAX_PENDING_STREAM_CHARS) {
            flush();
        } else if (!cancelTimer) {
            const generation = ++timerGeneration;
            cancelTimer = schedule(() => {
                if (disposed || generation !== timerGeneration) {
                    return;
                }
                cancelTimer = null;
                flush();
            }, AGENT_STREAM_FLUSH_MS);
        }
    }

    /** Flushes a still-owned run on unmount and permanently drops any later callbacks. */
    function dispose(): void {
        if (disposed) {
            return;
        }
        try {
            flush();
        } finally {
            disposed = true;
            clear();
        }
    }

    return {
        /** Adds a reasoning fragment without immediately notifying the store. */
        appendThinking(text: string): void {
            queue(undefined, text);
        },
        /** Adds a tool fragment while preserving its position relative to reasoning chunks. */
        appendToolOutput(toolCallId: string, text: string): void {
            queue(toolCallId, text);
        },
        flush,
        dispose,
    };
}

type Unlisten = () => void | Promise<void>;

/** Owns listener registrations incrementally, including promises that resolve after disposal. */
export function createAgentEventScope(runId: string, ownsRun: () => boolean) {
    const unlisteners: Unlisten[] = [];
    let disposed = false;

    /** Reports native cleanup failures without allowing them to reject an unobserved promise. */
    function reportCleanupError(error: unknown): void {
        console.error('[AI] Failed to release an agent event listener:', error);
    }

    /** Starts every cleanup immediately and observes both synchronous and native async failures. */
    function release(unlisten: Unlisten): void {
        try {
            void Promise.resolve(unlisten()).catch(reportCleanupError);
        } catch (error) {
            reportCleanupError(error);
        }
    }

    /** Releases only this effect's listeners, without touching a replacement run's subscriptions. */
    function dispose(): void {
        if (disposed) {
            return;
        }
        disposed = true;
        for (const unlisten of unlisteners.splice(0)) {
            release(unlisten);
        }
    }

    /** Installs independent events immediately and rejects stale run callbacks before store access. */
    async function register<T extends { runId: string }>(
        install: (forward: (payload: T) => void) => Promise<Unlisten>,
        handle: (payload: T) => void,
    ): Promise<void> {
        if (disposed || !ownsRun()) {
            return;
        }
        try {
            const unlisten = await install((payload) => {
                if (disposed || payload.runId !== runId) {
                    return;
                }
                if (!ownsRun()) {
                    dispose();
                    return;
                }
                handle(payload);
            });
            if (!ownsRun()) {
                dispose();
            }
            if (disposed) {
                release(unlisten);
            } else {
                unlisteners.push(unlisten);
            }
        } catch (error) {
            dispose();
            throw error;
        }
    }

    return { register, dispose };
}
