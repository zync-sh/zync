import type { Terminal as XTerm } from '@xterm/xterm';
import { type RefObject, useCallback, useEffect, useRef, useState } from 'react';

import {
    acceptGhostCommand,
    commitGhostCommand,
    resolveInlineSuggestion,
} from '../../lib/ghostSuggestions/client';
import type { GhostLayoutHint, GhostLineOrigin } from '../../lib/ghostSuggestions/cursorPosition';
import { stringDisplayWidth } from '../../lib/ghostSuggestions/displayWidth';
import { ghostDebug } from '../../lib/ghostSuggestions/ghostDebug';
import { MAX_GHOST_COMMAND_BYTES } from '../../lib/ghostSuggestions/inputBudget';
import { InputTracker } from '../../lib/ghostSuggestions/inputTracker';
import { clearPromptCwdSniffer } from '../../lib/ghostSuggestions/promptCwdSniffer';
import { extractRecentCommands } from '../../lib/ghostSuggestions/recentCommands';
import { bindGhostTrackerRuntime, handleGhostInputEvent } from '../../lib/ghostSuggestions/runtime';
import { clearSecretInputSniffer } from '../../lib/ghostSuggestions/secretInputDetect';
import { shouldSuppressGhostForNativeShell } from '../../lib/ghostSuggestions/shellSuppression';
import {
    cwdForWslPathCompletion,
    resolveWslShellIdForPathCompletion,
} from '../../lib/ghostSuggestions/wslShell';
import {
    getZshAutosuggestEnabled,
    scheduleZshAutosuggestProbe,
} from '../../lib/ghostSuggestions/zshAutosuggestDetect';
import {
    clearTerminalPendingInput,
    clearTerminalResizeState,
    enqueueTerminalInputTask,
    getTerminalRecentLines,
    isTerminalIdleSuspended,
    spawnTerminalFromStoreContext,
    terminalCache,
} from '../../lib/terminal';
import { queueTerminalInput } from '../../lib/terminal/inputPipeline';
import { isWin32Platform } from '../../lib/terminal/spawnContext';
import { getTerminalGhostCwd, invalidateTerminalGhostCwd } from '../../lib/terminal/terminalCache';
import {
    canTrackTerminalShell,
    observeTerminalShellContext,
} from '../../lib/terminal/terminalShellContext';
import type { AppSettings } from '../../store/settingsSlice';
import { useAppStore } from '../../store/useAppStore';
import type { TerminalMountContext } from './useTerminalLifecycle';

/** Prefer the tab's shell override, falling back to the configured local Windows shell. */
function getEffectiveShellId(
    terminalKey: string,
    shellOverride?: string,
    windowsShell?: string,
): string | undefined {
    return shellOverride ?? (terminalKey === 'local' ? windowsShell : undefined);
}

export interface UseTerminalGhostOptions {
    sessionId: string;
    terminalKey: string;
    spawnConnectionId: string;
    ghostScope: string;
    ghostSettings: AppSettings['ghostSuggestions'];
    isVisible: boolean;
    isVisibleRef: RefObject<boolean>;
    isConnectedRef: RefObject<boolean>;
}

/** Binds inference to the current shell while forwarding unconsumed input without alteration. */
export function useTerminalGhost({
    sessionId,
    terminalKey,
    spawnConnectionId,
    ghostScope,
    ghostSettings,
    isVisible,
    isVisibleRef,
    isConnectedRef,
}: UseTerminalGhostOptions) {
    const [ghostSuggestion, setGhostSuggestion] = useState('');
    const [ghostLayout, setGhostLayout] = useState<GhostLayoutHint>({
        typedCellCount: 0,
        origin: null,
    });
    const ghostTrackerRef = useRef<InputTracker | null>(null);
    const ghostSettingsRef = useRef(ghostSettings);
    /** First-cell screen position for the current typed line (pre-echo). */
    const lineOriginRef = useRef<GhostLineOrigin | null>(null);
    const termRefForLayout = useRef<XTerm | null>(null);
    const measuredLineRef = useRef({ line: '', cells: 0 });

    /** Measure a bounded line once across input, dismissal and delayed suggestion callbacks. */
    const syncGhostLayout = useCallback(
        (tracker: InputTracker | null | undefined, term?: XTerm | null) => {
            const activeTerm = term ?? termRefForLayout.current;
            if (!tracker || tracker.isDesynced() || tracker.isSecretInputMode()) {
                lineOriginRef.current = null;
                measuredLineRef.current = { line: '', cells: 0 };
                setGhostLayout({ typedCellCount: 0, origin: null });
                return;
            }
            const line = tracker.getLineBuffer();
            if (!line) {
                lineOriginRef.current = null;
                measuredLineRef.current = { line: '', cells: 0 };
                setGhostLayout({ typedCellCount: 0, origin: null });
                return;
            }
            // Capture origin on the first keystroke of a line, while the caret is still
            // at the prompt — before remote echo advances cursorX.
            if (!lineOriginRef.current && activeTerm) {
                const buf = activeTerm.buffer.active;
                lineOriginRef.current = { col: buf.cursorX, row: buf.cursorY };
            }
            if (measuredLineRef.current.line !== line) {
                measuredLineRef.current = { line, cells: stringDisplayWidth(line) };
            }
            setGhostLayout({
                // Terminal columns (wide CJK/emoji = 2, combining marks = 0), not JS code points.
                typedCellCount: measuredLineRef.current.cells,
                origin: lineOriginRef.current,
            });
        },
        [],
    );

    useEffect(() => {
        ghostSettingsRef.current = ghostSettings;
        if (!ghostSettings.inlineEnabled) {
            setGhostSuggestion('');
            ghostTrackerRef.current?.suspend();
            lineOriginRef.current = null;
            setGhostLayout({ typedCellCount: 0, origin: null });
        }
    }, [ghostSettings]);

    useEffect(() => {
        if (!isVisible) {
            ghostTrackerRef.current?.suspend();
        }
    }, [isVisible]);

    const acceptGhostSuffix = useCallback(
        (suffix: string) => {
            if (!suffix) {
                return;
            }
            const cached = terminalCache.get(sessionId);
            if (
                !cached ||
                !cached.spawned ||
                !isVisibleRef.current ||
                !ghostSettingsRef.current.inlineEnabled ||
                !canTrackTerminalShell(cached.term, cached.ghostPaused) ||
                shouldSuppressGhostForNativeShell(
                    ghostSettingsRef.current.nativeShellPolicy,
                    cached.spawnShell,
                    getZshAutosuggestEnabled(sessionId),
                ) ||
                cached.ghostTracker?.isDesynced() ||
                cached.ghostTracker?.isSecretInputMode() ||
                cached.ghostTracker?.getSuggestion() !== suffix
            ) {
                return;
            }
            cached?.ghostTracker?.appendToLineBuffer(suffix);
            cached?.ghostTracker?.clearSuggestion();
            queueTerminalInput(sessionId, suffix);
            acceptGhostCommand(cached?.ghostTracker?.getLineBuffer() ?? '', ghostScope).catch(
                () => {},
            );
            setGhostSuggestion('');
            syncGhostLayout(cached?.ghostTracker ?? null);
        },
        [sessionId, ghostScope, syncGhostLayout, isVisibleRef],
    );

    const truncateLabel = useCallback((label: string, max = 60) => {
        if (label.length <= max) {
            return label;
        }
        return `${label.slice(0, Math.max(0, max - 1))}…`;
    }, []);

    const resetGhostUi = useCallback(() => {
        setGhostSuggestion('');
        lineOriginRef.current = null;
        setGhostLayout({ typedCellCount: 0, origin: null });
    }, []);

    const initGhostTracker = useCallback((termSessionId: string) => {
        const ghostTracker = new InputTracker({
            onLineChange: () => {},
            onAccept: () => {},
            onDismiss: () => {},
            onHistoryCommit: () => {},
        });
        terminalCache.get(termSessionId)!.ghostTracker = ghostTracker;
    }, []);

    /** Capture input ownership and wire one Ghost runtime to the cached terminal. */
    const onBindMount = useCallback(
        ({ term, sessionId: mountSessionId }: TerminalMountContext) => {
            termRefForLayout.current = term;
            const cachedGhostTracker = terminalCache.get(mountSessionId)?.ghostTracker;
            ghostTrackerRef.current = cachedGhostTracker ?? null;
            if (!ghostSettingsRef.current.inlineEnabled) {
                ghostTrackerRef.current?.suspend();
            }

            const mountEntry = terminalCache.get(mountSessionId);
            if (mountEntry) {
                mountEntry.ghostContextActive = true;
            }
            /** Reject a replacement terminal or a non-shell input context. */
            const safeContext = () =>
                terminalCache.get(mountSessionId) === mountEntry &&
                canTrackTerminalShell(term, mountEntry?.ghostPaused);
            const context = observeTerminalShellContext(term, {
                isPaused: () => Boolean(mountEntry?.ghostPaused),
                generation: () => mountEntry?.generation ?? 0,
                /** Revoke delayed suggestions and passive prompt fragments on context changes. */
                invalidate: () => {
                    if (mountEntry) {
                        mountEntry.ghostContextEpoch = (mountEntry.ghostContextEpoch ?? 0) + 1;
                    }
                    invalidateTerminalGhostCwd(mountSessionId);
                    clearPromptCwdSniffer(mountSessionId);
                    clearSecretInputSniffer(mountSessionId);
                    cachedGhostTracker?.suspend();
                },
            });

            const storeOnBind = useAppStore.getState();
            const termStateOnBind = storeOnBind.terminals[terminalKey]?.find(
                (t) => t.id === mountSessionId,
            );
            const shellIdOnBind = getEffectiveShellId(
                terminalKey,
                termStateOnBind?.shellOverride,
                storeOnBind.settings.localTerm?.windowsShell,
            );
            scheduleZshAutosuggestProbe(mountSessionId, terminalKey, shellIdOnBind);

            /** Defer to the user's native-shell coexistence policy. */
            const nativeShellSuppressed = () =>
                shouldSuppressGhostForNativeShell(
                    ghostSettingsRef.current.nativeShellPolicy,
                    mountEntry?.spawnShell ?? shellIdOnBind,
                    getZshAutosuggestEnabled(mountSessionId),
                );
            /** Admit inference only for a visible, enabled, current shell. */
            const canTrackGhostInput = () =>
                safeContext() &&
                isVisibleRef.current &&
                ghostSettingsRef.current.inlineEnabled &&
                !nativeShellSuppressed();

            const unbindGhostTracker = cachedGhostTracker
                ? bindGhostTrackerRuntime({
                      tracker: cachedGhostTracker,
                      debounceMs: 30,
                      isEnabled: canTrackGhostInput,
                      /** Fence pending work by PTY, shell context and observed CWD. */
                      getContextVersion: () =>
                          `${mountEntry?.generation}:${mountEntry?.ghostContextEpoch ?? 0}:${mountEntry?.ghostCwdRevision ?? 0}`,
                      /** Resolve a bounded tracked line with current backend and ranking evidence. */
                      resolveInlineSuggestion: async (line) => {
                          if (!ghostSettingsRef.current.inlineEnabled) {
                              return '';
                          }
                          if (!isVisibleRef.current) {
                              return '';
                          }
                          if (cachedGhostTracker?.isSecretInputMode()) {
                              return '';
                          }
                          const store = useAppStore.getState();
                          const termState = store.terminals[terminalKey]?.find(
                              (t) => t.id === mountSessionId,
                          );
                          const shellId = getEffectiveShellId(
                              terminalKey,
                              termState?.shellOverride,
                              store.settings.localTerm?.windowsShell,
                          );
                          const suppressed = nativeShellSuppressed();
                          const rawCwd = getTerminalGhostCwd(mountSessionId);
                          const wslShellId =
                              terminalKey === 'local'
                                  ? resolveWslShellIdForPathCompletion(
                                        mountEntry?.spawnShell,
                                        isWin32Platform(),
                                    )
                                  : undefined;
                          const cwd = wslShellId ? cwdForWslPathCompletion(rawCwd) : rawCwd;
                          ghostDebug('terminal', {
                              terminalKey,
                              termId: mountSessionId,
                              line,
                              shellId: shellId ?? null,
                              rawCwd: rawCwd ?? null,
                              cwd: cwd ?? null,
                              wslShellId: wslShellId ?? null,
                              suppressed,
                              desynced: cachedGhostTracker?.isDesynced() ?? false,
                          });
                          if (suppressed) {
                              ghostDebug('terminal', {
                                  phase: 'suppressed',
                                  shellId: shellId ?? null,
                              });
                              return '';
                          }
                          // Normal-screen full-screen apps may leave text in scrollback. Once
                          // context was invalidated, rank by tracked history rather than that text.
                          const recentCommands = mountEntry?.ghostContextEpoch
                              ? []
                              : extractRecentCommands(getTerminalRecentLines(mountSessionId, 24));
                          return resolveInlineSuggestion({
                              line,
                              cwd,
                              scope: ghostScope,
                              fsConnectionId: terminalKey,
                              wslShellId,
                              recentCommands,
                              providers: ghostSettingsRef.current.providers,
                          });
                      },
                      /** Publish only within the still-admitted shell context. */
                      onSuggestion: (suffix, line) => {
                          syncGhostLayout(cachedGhostTracker, term);
                          if (canTrackGhostInput()) {
                              setGhostSuggestion(suffix);
                          } else {
                              setGhostSuggestion('');
                          }
                          ghostDebug('layout', {
                              phase: 'suggestion',
                              lineLen: line.length,
                              origin: lineOriginRef.current,
                              suffix: suffix || null,
                          });
                      },
                      /** Send the accepted text and record its bounded command in Ghost history. */
                      onAccept: (suffix, lineAfterAccept) => {
                          if (!canTrackGhostInput()) {
                              return;
                          }
                          queueTerminalInput(mountSessionId, suffix);
                          acceptGhostCommand(lineAfterAccept, ghostScope).catch(() => {});
                          syncGhostLayout(cachedGhostTracker, term);
                      },
                      /** Record submitted inference only while this shell remains eligible. */
                      onHistoryCommit: (cmd) => {
                          if (!canTrackGhostInput()) {
                              return;
                          }
                          commitGhostCommand(cmd, ghostScope).catch(() => {});
                      },
                      /** Clear stale overlays and release measurements for discarded lines. */
                      onClearUI: () => {
                          setGhostSuggestion('');
                          // Keep origin while the line still has local typed text (suggestion
                          // cleared mid-debounce); drop it when the line buffer is empty/desynced.
                          syncGhostLayout(cachedGhostTracker, term);
                      },
                  })
                : () => {};

            const cachedForInput = terminalCache.get(mountSessionId);
            if (cachedForInput?.onDataDisposable) {
                cachedForInput.onDataDisposable.dispose();
                cachedForInput.onDataDisposable = undefined;
            }

            if (cachedForInput) {
                cachedForInput.onDataDisposable = term.onData((data) => {
                    context.sync();
                    const inputGeneration = mountEntry?.generation;
                    const inputContext = mountEntry?.ghostContextEpoch;
                    const shellAtInput = canTrackGhostInput();
                    enqueueTerminalInputTask(mountSessionId, async () => {
                        const cached = terminalCache.get(mountSessionId);
                        if (cached !== mountEntry || cached?.generation !== inputGeneration) {
                            return;
                        }
                        context.sync();

                        if (cached && !cached.spawned) {
                            const isRestartKey = data === '\r' || data === '\n';
                            if (!isRestartKey) {
                                return;
                            }
                            if (
                                !isVisibleRef.current ||
                                !isConnectedRef.current ||
                                cached.spawnBlocked
                            ) {
                                return;
                            }
                            const idleSuspended = isTerminalIdleSuspended(mountSessionId);
                            console.log(
                                idleSuspended
                                    ? '[Terminal] Idle-suspended shell, resuming on Enter'
                                    : '[Terminal] Session ended, restarting on Enter',
                            );
                            clearTerminalPendingInput(mountSessionId);
                            clearTerminalResizeState(mountSessionId);
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
                            const storeAfterSpawn = useAppStore.getState();
                            const termAfterSpawn = storeAfterSpawn.terminals[terminalKey]?.find(
                                (t) => t.id === mountSessionId,
                            );
                            const shellAfterSpawn = getEffectiveShellId(
                                terminalKey,
                                termAfterSpawn?.shellOverride,
                                storeAfterSpawn.settings.localTerm?.windowsShell,
                            );
                            scheduleZshAutosuggestProbe(
                                mountSessionId,
                                terminalKey,
                                shellAfterSpawn,
                            );
                            setGhostSuggestion('');
                            lineOriginRef.current = null;
                            setGhostLayout({ typedCellCount: 0, origin: null });
                            return;
                        }

                        if (
                            shellAtInput &&
                            canTrackGhostInput() &&
                            cached?.ghostContextEpoch === inputContext
                        ) {
                            // Capture line origin *before* feed when the buffer is empty so we
                            // pin to the prompt caret even if local echo is extremely fast.
                            const tracker = cached?.ghostTracker;
                            const wasEmpty = !tracker?.getLineBuffer();
                            if (
                                wasEmpty &&
                                tracker &&
                                !tracker.isDesynced() &&
                                !tracker.isSecretInputMode()
                            ) {
                                const buf = term.buffer.active;
                                // Only seed origin for printable input; feed() decides if it sticks.
                                const hasPrintable =
                                    data.length <= MAX_GHOST_COMMAND_BYTES &&
                                    /[^\x00-\x1f\x7f]/.test(data);
                                if (hasPrintable) {
                                    lineOriginRef.current = { col: buf.cursorX, row: buf.cursorY };
                                }
                            }

                            const handledByGhost = handleGhostInputEvent(data, tracker);
                            syncGhostLayout(tracker, term);
                            if (handledByGhost) {
                                return;
                            }
                        } else {
                            cached?.ghostTracker?.suspend();
                        }

                        queueTerminalInput(mountSessionId, data);
                    });
                });
            }

            const boundInput = cachedForInput?.onDataDisposable;
            return () => {
                context.dispose();
                if (mountEntry && terminalCache.get(mountSessionId) === mountEntry) {
                    mountEntry.ghostContextActive = false;
                    if (mountEntry.onDataDisposable === boundInput) {
                        boundInput?.dispose();
                        mountEntry.onDataDisposable = undefined;
                    }
                }
                termRefForLayout.current = null;
                unbindGhostTracker();
            };
        },
        [terminalKey, ghostScope, spawnConnectionId, isVisibleRef, isConnectedRef, syncGhostLayout],
    );

    return {
        ghostSuggestion,
        ghostLayout,
        acceptGhostSuffix,
        truncateLabel,
        resetGhostUi,
        initGhostTracker,
        onBindMount,
    };
}
