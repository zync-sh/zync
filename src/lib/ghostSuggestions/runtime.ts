import { ghostDebug } from './ghostDebug.js';
import { InputTracker } from './inputTracker.js';

interface GhostTrackerRuntimeParams {
    tracker: InputTracker;
    debounceMs?: number;
    resolveInlineSuggestion: (line: string) => Promise<string>;
    onSuggestion: (suffix: string, line: string) => void;
    onAccept: (suffix: string, lineAfterAccept: string) => void;
    onHistoryCommit: (command: string) => void;
    onClearUI: () => void;
    /** Dynamic context gates also apply after an asynchronous provider resolves. */
    isEnabled?: () => boolean;
    getContextVersion?: () => unknown;
}

interface PendingSuggestion {
    line: string;
    sequence: number;
    contextVersion: unknown;
}

/**
 * Runs one resolver per binding and retains only the latest fully debounced request.
 * Disposal drops pending work and fences replies; it cannot cancel an existing native IPC call.
 */
export function bindGhostTrackerRuntime({
    tracker,
    debounceMs = 30,
    resolveInlineSuggestion,
    onSuggestion,
    onAccept,
    onHistoryCommit,
    onClearUI,
    isEnabled = () => true,
    getContextVersion = () => 0,
}: GhostTrackerRuntimeParams): () => void {
    let timer: ReturnType<typeof setTimeout> | null = null;
    let requestSeq = 0;
    let active = true;
    let resolving = false;
    let pending: PendingSuggestion | null = null;

    /** Removes the typing debounce without affecting an already-running native request. */
    const clearTimer = () => {
        if (timer !== null) {
            clearTimeout(timer);
            timer = null;
        }
    };

    /** Invalidates both displayed-result ownership and the one queued computation. */
    const invalidateRequests = () => {
        requestSeq += 1;
        pending = null;
        clearTimer();
    };

    /** Applies the same shell/line/context gates before native work and before publishing its reply. */
    const isCurrent = (request: PendingSuggestion) =>
        active &&
        request.sequence === requestSeq &&
        tracker.getLineBuffer() === request.line &&
        isEnabled() &&
        getContextVersion() === request.contextVersion &&
        !tracker.isDesynced() &&
        !tracker.isSecretInputMode();

    /** Starts only a matured request and always releases admission before draining its latest successor. */
    const drain = async (): Promise<void> => {
        if (resolving || !pending) {
            return;
        }
        const request = pending;
        pending = null;
        if (!isCurrent(request)) {
            return;
        }
        resolving = true;
        try {
            const suffix = await resolveInlineSuggestion(request.line);
            if (!isCurrent(request)) {
                return;
            }
            tracker.setSuggestion(suffix);
            onSuggestion(suffix, request.line);
        } catch {
            // A rejected provider or publication callback cannot strand the next request.
        } finally {
            resolving = false;
            void drain();
        }
    };

    /** Clears UI and pending work immediately after acceptance, dismissal or context invalidation. */
    const clearState = () => {
        invalidateRequests();
        tracker.clearSuggestion();
        onClearUI();
    };

    tracker.updateOptions({
        /** Clears stale UI immediately, then admits only the newest debounced line. */
        onLineChange: (line) => {
            if (!isEnabled()) {
                clearState();
                return;
            }
            tracker.clearSuggestion();
            onSuggestion('', line);
            onClearUI();
            if (tracker.isSecretInputMode()) {
                ghostDebug('runtime', { phase: 'skip-fetch', reason: 'secret-input', line });
                invalidateRequests();
                return;
            }
            if (tracker.isDesynced()) {
                ghostDebug('runtime', { phase: 'skip-fetch', reason: 'desynced', line });
                invalidateRequests();
                return;
            }

            invalidateRequests();
            const request: PendingSuggestion = {
                line,
                sequence: requestSeq,
                contextVersion: getContextVersion(),
            };

            timer = setTimeout(() => {
                timer = null;
                if (!isCurrent(request)) {
                    return;
                }
                pending = request;
                void drain();
            }, debounceMs);
        },
        /** Invalidates queued work before forwarding an accepted suffix to the shell owner. */
        onAccept: (suffix, lineAfterAccept) => {
            clearState();
            onAccept(suffix, lineAfterAccept);
        },
        /** Dismissal, reset and hidden-input transitions revoke pending and visible suggestions. */
        onDismiss: () => {
            clearState();
        },
        /** History delivery remains synchronous and independent of provider admission. */
        onHistoryCommit: (command) => {
            onHistoryCommit(command);
        },
    });

    return () => {
        if (!active) {
            return;
        }
        active = false;
        clearState();
        tracker.updateOptions({
            onLineChange: () => {},
            onAccept: () => {},
            onDismiss: () => {},
            onHistoryCommit: () => {},
        });
    };
}

/**
 * Handles inline ghost input routing (accept/dismiss keys).
 * Returns true when the event was fully handled and should NOT continue to PTY write.
 */
export function handleGhostInputEvent(data: string, tracker?: InputTracker): boolean {
    if (!tracker) {
        return false;
    }
    const { consumed } = tracker.feed(data);
    return consumed;
}
