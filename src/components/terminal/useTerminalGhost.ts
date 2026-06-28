import { useCallback, useEffect, useRef, useState, type RefObject } from 'react';
import { useAppStore } from '../../store/useAppStore';
import { InputTracker } from '../../lib/ghostSuggestions/inputTracker';
import {
  acceptGhostCommand,
  commitGhostCommand,
  resolveInlineSuggestion,
  resolvePopupCandidates,
  resolveTabCompletionOutcome,
  shouldPreferPathSuggestion,
} from '../../lib/ghostSuggestions/client';
import type { GhostTabState } from '../../lib/ghostSuggestions/types';
import { createInitialGhostTabState, resetGhostTabState } from '../../lib/ghostSuggestions/tabState';
import { bindGhostTrackerRuntime, handleGhostInputEvent } from '../../lib/ghostSuggestions/runtime';
import { useGhostPopupState } from '../../lib/ghostSuggestions/uiState';
import type { AppSettings } from '../../store/settingsSlice';
import {
  clearTerminalPendingInput,
  enqueueTerminalInputTask,
  queueTerminalInput,
  isTerminalIdleSuspended,
  spawnTerminalFromStoreContext,
  terminalCache,
} from '../../lib/terminal';
import type { TerminalMountContext } from './useTerminalLifecycle';

export interface UseTerminalGhostOptions {
  sessionId: string;
  terminalKey: string;
  spawnConnectionId: string;
  ghostScope: string;
  ghostSettings: AppSettings['ghostSuggestions'];
  isVisibleRef: RefObject<boolean>;
  isConnectedRef: RefObject<boolean>;
}

export function useTerminalGhost({
  sessionId,
  terminalKey,
  spawnConnectionId,
  ghostScope,
  ghostSettings,
  isVisibleRef,
  isConnectedRef,
}: UseTerminalGhostOptions) {
  const [ghostSuggestion, setGhostSuggestion] = useState('');
  const {
    ghostPopup,
    ghostPopupRef,
    closeGhostPopup,
    openGhostPopup,
    moveGhostPopupSelection,
  } = useGhostPopupState();
  const ghostTabStateRef = useRef<GhostTabState>(createInitialGhostTabState());
  const ghostTrackerRef = useRef<InputTracker | null>(null);
  const ghostSettingsRef = useRef(ghostSettings);

  useEffect(() => {
    ghostSettingsRef.current = ghostSettings;
    if (!ghostSettings.inlineEnabled) {
      setGhostSuggestion('');
      ghostTrackerRef.current?.clearSuggestion();
    }
    if (!ghostSettings.popupEnabled) {
      closeGhostPopup();
      ghostTabStateRef.current = resetGhostTabState();
    }
  }, [ghostSettings, closeGhostPopup]);

  const acceptGhostSuffix = useCallback((suffix: string) => {
    if (!suffix) return;
    const cached = terminalCache.get(sessionId);
    cached?.ghostTracker?.appendToLineBuffer(suffix);
    cached?.ghostTracker?.clearSuggestion();
    queueTerminalInput(sessionId, suffix);
    acceptGhostCommand(cached?.ghostTracker?.getLineBuffer() ?? '', ghostScope).catch(() => {});
    closeGhostPopup();
    setGhostSuggestion('');
    ghostTabStateRef.current = resetGhostTabState();
  }, [sessionId, ghostScope, closeGhostPopup]);

  const truncateLabel = useCallback((label: string, max = 60) => {
    if (label.length <= max) return label;
    return `${label.slice(0, Math.max(0, max - 1))}…`;
  }, []);

  const resetGhostUi = useCallback(() => {
    setGhostSuggestion('');
    closeGhostPopup();
    ghostTabStateRef.current = resetGhostTabState();
  }, [closeGhostPopup]);

  const initGhostTracker = useCallback((termSessionId: string) => {
    const ghostTracker = new InputTracker({
      onLineChange: () => {},
      onAccept: () => {},
      onDismiss: () => {},
      onHistoryCommit: () => {},
    });
    terminalCache.get(termSessionId)!.ghostTracker = ghostTracker;
  }, []);

  const onBindMount = useCallback(({ term, sessionId: mountSessionId }: TerminalMountContext) => {
    const cachedGhostTracker = terminalCache.get(mountSessionId)?.ghostTracker;
    ghostTrackerRef.current = cachedGhostTracker ?? null;
    if (!ghostSettingsRef.current.inlineEnabled) {
      ghostTrackerRef.current?.clearSuggestion();
    }

    const unbindGhostTracker = cachedGhostTracker
      ? bindGhostTrackerRuntime({
        tracker: cachedGhostTracker,
        debounceMs: 30,
        resolveInlineSuggestion: async (line) => {
          if (!ghostSettingsRef.current.inlineEnabled) return '';
          if (!isVisibleRef.current) return '';
          const termState = useAppStore.getState().terminals[terminalKey]?.find((t) => t.id === mountSessionId);
          const cwd = termState?.lastKnownCwd ?? termState?.initialPath;
          return resolveInlineSuggestion({
            line,
            cwd,
            scope: ghostScope,
            providers: ghostSettingsRef.current.providers,
          });
        },
        onSuggestion: (suffix, line) => {
          if (ghostSettingsRef.current.inlineEnabled) {
            setGhostSuggestion(suffix);
          } else {
            setGhostSuggestion('');
          }

          closeGhostPopup();

          if (!ghostSettingsRef.current.popupEnabled || line.trim().length < 2) {
            return;
          }

          const termState = useAppStore.getState().terminals[terminalKey]?.find((t) => t.id === mountSessionId);
          const cwd = termState?.lastKnownCwd ?? termState?.initialPath;
          const preferPath = shouldPreferPathSuggestion(line);
          if (!isVisibleRef.current) return;
          void resolvePopupCandidates({
            line,
            cwd,
            scope: ghostScope,
            preferPath,
            limit: 10,
            providers: ghostSettingsRef.current.providers,
          }).then((items) => {
            if (!cachedGhostTracker || cachedGhostTracker.getLineBuffer() !== line) return;
            if (!ghostSettingsRef.current.popupEnabled) return;
            if (items.length > 1) openGhostPopup(items, line);
            else closeGhostPopup();
          }).catch(() => {
            closeGhostPopup();
          });
        },
        onAccept: (suffix, lineAfterAccept) => {
          queueTerminalInput(mountSessionId, suffix);
          acceptGhostCommand(lineAfterAccept, ghostScope).catch(() => {});
        },
        onHistoryCommit: (cmd) => {
          commitGhostCommand(cmd, ghostScope).catch(() => {});
        },
        onClearUI: () => {
          setGhostSuggestion('');
          closeGhostPopup();
          ghostTabStateRef.current = resetGhostTabState();
        },
      })
      : () => {};

    const triggerGhostPopup = async (tracker: InputTracker) => {
      try {
        const line = tracker.getLineBuffer();
        if (!ghostSettingsRef.current.popupEnabled) {
          queueTerminalInput(mountSessionId, '\t');
          return;
        }
        const termState = useAppStore.getState().terminals[terminalKey]?.find((t) => t.id === mountSessionId);
        const cwd = termState?.lastKnownCwd ?? termState?.initialPath;
        if (!isVisibleRef.current) return;
        const outcome = await resolveTabCompletionOutcome({
          line,
          cwd,
          scope: ghostScope,
          previousTabState: ghostTabStateRef.current,
          now: Date.now(),
          limit: 24,
          providers: ghostSettingsRef.current.providers,
        });

        if (tracker.getLineBuffer() !== line) {
          ghostTabStateRef.current = resetGhostTabState();
          closeGhostPopup();
          return;
        }

        if (outcome.kind === 'accept') {
          ghostTabStateRef.current = outcome.nextState;
          acceptGhostSuffix(outcome.suffix);
          return;
        }
        if (outcome.kind === 'show_list') {
          if (!ghostSettingsRef.current.popupEnabled) {
            ghostTabStateRef.current = resetGhostTabState();
            closeGhostPopup();
            queueTerminalInput(mountSessionId, '\t');
            return;
          }
          ghostTabStateRef.current = outcome.nextState;
          openGhostPopup(outcome.items, line);
          return;
        }

        closeGhostPopup();
        ghostTabStateRef.current = resetGhostTabState();
        queueTerminalInput(mountSessionId, '\t');
      } catch (error) {
        console.warn('[Ghost] Tab popup resolution failed:', error);
        ghostTabStateRef.current = resetGhostTabState();
        closeGhostPopup();
        queueTerminalInput(mountSessionId, '\t');
      }
    };

    const cachedForInput = terminalCache.get(mountSessionId);
    if (cachedForInput?.onDataDisposable) {
      cachedForInput.onDataDisposable.dispose();
      cachedForInput.onDataDisposable = undefined;
    }

    if (cachedForInput) {
      cachedForInput.onDataDisposable = term.onData((data) => {
        enqueueTerminalInputTask(mountSessionId, async () => {
          const cached = terminalCache.get(mountSessionId);

          if (cached && !cached.spawned) {
            const isRestartKey = data === '\r' || data === '\n';
            if (!isRestartKey) {
              return;
            }
            if (!isVisibleRef.current || !isConnectedRef.current || cached.spawnBlocked) {
              return;
            }
            const idleSuspended = isTerminalIdleSuspended(mountSessionId);
            console.log(
              idleSuspended
                ? '[Terminal] Idle-suspended shell, resuming on Enter'
                : '[Terminal] Session ended, restarting on Enter',
            );
            clearTerminalPendingInput(mountSessionId);
            cached.lastResize = null;
            cached.spawnBlocked = false;
            const store = useAppStore.getState();
            spawnTerminalFromStoreContext({
              sessionId: mountSessionId,
              connectionId: spawnConnectionId,
              terminalKey,
              term,
              clearBuffer: !idleSuspended,
              terminals: store.terminals,
              windowsShell: store.settings.localTerm?.windowsShell,
              remoteReady: true,
            });
            cached.ghostTracker?.reset();
            setGhostSuggestion('');
            closeGhostPopup();
            ghostTabStateRef.current = resetGhostTabState();
            return;
          }

          if (isVisibleRef.current) {
            const handledByGhost = await handleGhostInputEvent({
              data,
              popup: ghostPopupRef.current,
              tracker: cached?.ghostTracker,
              allowTabPopup: ghostSettingsRef.current.popupEnabled,
              onMovePopupSelection: moveGhostPopupSelection,
              onAcceptPopupSelection: () => {
                const popup = ghostPopupRef.current;
                const suffix = popup.items[popup.selectedIndex] ?? '';
                acceptGhostSuffix(suffix);
              },
              onDismissPopup: closeGhostPopup,
              onTriggerTabPopup: triggerGhostPopup,
            });
            if (handledByGhost) return;
          }

          queueTerminalInput(mountSessionId, data);
        });
      });
    }

    return unbindGhostTracker;
  }, [
    terminalKey,
    ghostScope,
    spawnConnectionId,
    acceptGhostSuffix,
    closeGhostPopup,
    openGhostPopup,
    moveGhostPopupSelection,
    isVisibleRef,
    isConnectedRef,
    ghostPopupRef,
  ]);

  return {
    ghostSuggestion,
    ghostPopup,
    ghostPopupRef,
    acceptGhostSuffix,
    truncateLabel,
    resetGhostUi,
    initGhostTracker,
    onBindMount,
  };
}