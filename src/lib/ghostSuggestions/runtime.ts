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
}

/**
 * Binds ghost tracker callbacks with debounce + stale result protection.
 * Returns an unbind function that clears timers and detaches callbacks.
 */
export function bindGhostTrackerRuntime({
  tracker,
  debounceMs = 30,
  resolveInlineSuggestion,
  onSuggestion,
  onAccept,
  onHistoryCommit,
  onClearUI,
}: GhostTrackerRuntimeParams): () => void {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let requestSeq = 0;
  let active = true;

  const clearTimer = () => {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
  };

  const clearState = () => {
    requestSeq += 1;
    clearTimer();
    tracker.clearSuggestion();
    onClearUI();
  };

  tracker.updateOptions({
    onLineChange: (line) => {
      tracker.clearSuggestion();
      onSuggestion('', line);
      onClearUI();
      if (tracker.isSecretInputMode()) {
        ghostDebug('runtime', { phase: 'skip-fetch', reason: 'secret-input', line });
        requestSeq += 1;
        clearTimer();
        return;
      }
      if (tracker.isDesynced()) {
        ghostDebug('runtime', { phase: 'skip-fetch', reason: 'desynced', line });
        requestSeq += 1;
        clearTimer();
        return;
      }

      requestSeq += 1;
      const seq = requestSeq;
      clearTimer();

      timer = setTimeout(async () => {
        timer = null;
        if (!active || seq !== requestSeq || tracker.getLineBuffer() !== line) return;
        if (tracker.isDesynced()) return;

        const suffix = await resolveInlineSuggestion(line);
        if (!active || seq !== requestSeq || tracker.getLineBuffer() !== line) return;
        if (tracker.isDesynced()) return;

        tracker.setSuggestion(suffix);
        onSuggestion(suffix, line);
      }, debounceMs);
    },
    onAccept: (suffix, lineAfterAccept) => {
      clearState();
      onAccept(suffix, lineAfterAccept);
    },
    onDismiss: () => {
      clearState();
    },
    onHistoryCommit: (command) => {
      onHistoryCommit(command);
    },
  });

  return () => {
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
export function handleGhostInputEvent(
  data: string,
  tracker?: InputTracker,
): boolean {
  if (!tracker) return false;
  const { consumed } = tracker.feed(data);
  return consumed;
}