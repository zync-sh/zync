import { useCallback, useEffect, useMemo, useRef, useState, type RefObject } from 'react';
import { Terminal as XTerm, type ITheme } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { SearchAddon } from '@xterm/addon-search';
import { WebLinksAddon } from '@xterm/addon-web-links';
import { useAppStore } from '../../store/useAppStore';
import {
  activateDomRenderer,
  applyTerminalRendererAndLigatures,
  attachTerminalLifecycleListeners,
  buildEffectiveRendererSettings,
  needsTerminalRendererSetup,
  clearTerminalPendingInput,
  createResizeScheduler,
  flushPendingInput,
  getTerminalRendererState,
  isTerminalDomMeasurable,
  resolveLazyPtyAction,
  restoreTerminalDisplay,
  safeFitTerminal,
  spawnTerminalFromStoreContext,
  suspendTerminalPty,
  syncTerminalResize,
  TERMINAL_CONNECTION_WAKEUP_EVENT,
  terminalCache,
  tryWakeTerminalOnReconnect,
  buildXtermOptions,
  isTerminalIdleSuspended,
  shouldUseWindowsLocalPtyOptions,
  writeIdleHostSuspendNotice,
} from '../../lib/terminal';
import type { TerminalSettingsSlice } from './useTerminalTheme';

/** Run heavy renderer work after the next paint so tab/UI clicks feel instant. */
function deferAfterPaint(task: () => void): void {
  requestAnimationFrame(() => {
    requestAnimationFrame(task);
  });
}

export interface TerminalMountContext {
  term: XTerm;
  sessionId: string;
  isNewTerminal: boolean;
}

export interface UseTerminalLifecycleOptions {
  containerRef: RefObject<HTMLDivElement | null>;
  termRef: RefObject<XTerm | null>;
  fitAddonRef: RefObject<FitAddon | null>;
  searchAddonRef: RefObject<SearchAddon | null>;
  activeConnectionId: string | null | undefined;
  sessionId: string;
  terminalKey: string;
  spawnConnectionId: string;
  isConnected: boolean;
  isVisible?: boolean;
  isWorkspaceActive?: boolean;
  isTerminalView?: boolean;
  isActiveTab?: boolean;
  remoteReady: boolean;
  terminalSettings: TerminalSettingsSlice & {
    padding?: number;
    gpuAcceleration: boolean;
    fontLigatures: boolean;
  };
  resolveInitialTheme: () => ITheme;
  onCreateTerminal?: (term: XTerm) => void;
  onBindMount?: (ctx: TerminalMountContext) => () => void;
}

export function useTerminalLifecycle({
  containerRef,
  termRef,
  fitAddonRef,
  searchAddonRef,
  activeConnectionId,
  sessionId,
  terminalKey,
  spawnConnectionId,
  isConnected,
  isVisible = true,
  isWorkspaceActive = true,
  isTerminalView = true,
  isActiveTab = true,
  remoteReady,
  terminalSettings,
  resolveInitialTheme,
  onCreateTerminal,
  onBindMount,
}: UseTerminalLifecycleOptions) {
  const onCreateTerminalRef = useRef(onCreateTerminal);
  const onBindMountRef = useRef(onBindMount);
  const resolveInitialThemeRef = useRef(resolveInitialTheme);
  const terminalSettingsRef = useRef(terminalSettings);

  useEffect(() => {
    onCreateTerminalRef.current = onCreateTerminal;
  }, [onCreateTerminal]);

  useEffect(() => {
    onBindMountRef.current = onBindMount;
  }, [onBindMount]);

  useEffect(() => {
    resolveInitialThemeRef.current = resolveInitialTheme;
  }, [resolveInitialTheme]);

  const syncTerminalTheme = useCallback((term: XTerm) => {
    term.options.theme = resolveInitialThemeRef.current();
    try {
      const lastRow = Math.max(0, term.rows - 1);
      term.refresh(0, lastRow);
    } catch {
      // Ignore refresh failures during renderer transitions.
    }
  }, []);

  useEffect(() => {
    terminalSettingsRef.current = terminalSettings;
  }, [terminalSettings]);

  const resizeSchedulerRef = useRef<ReturnType<typeof createResizeScheduler> | null>(null);
  const isLayoutTransitioning = useRef(false);
  const layoutTransitionSafetyTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [layoutTransitioning, setLayoutTransitioning] = useState(false);
  const isVisibleRef = useRef(isVisible);
  const isWorkspaceActiveRef = useRef(isWorkspaceActive);
  const isTerminalViewRef = useRef(isTerminalView);
  const isActiveTabRef = useRef(isActiveTab);
  const isConnectedRef = useRef(isConnected);
  const sessionIdRef = useRef(sessionId);
  const lastAppliedRendererSettingsBySessionRef = useRef(new Map<string, string>());

  useEffect(() => {
    isVisibleRef.current = isVisible;
  }, [isVisible]);

  useEffect(() => {
    isWorkspaceActiveRef.current = isWorkspaceActive;
  }, [isWorkspaceActive]);

  useEffect(() => {
    isTerminalViewRef.current = isTerminalView;
  }, [isTerminalView]);

  useEffect(() => {
    isActiveTabRef.current = isActiveTab;
  }, [isActiveTab]);

  useEffect(() => {
    isConnectedRef.current = isConnected;
  }, [isConnected]);

  useEffect(() => {
    sessionIdRef.current = sessionId;
  }, [sessionId]);

  const clearLayoutWidthPin = useCallback(() => {
    if (!containerRef.current) return;
    containerRef.current.style.width = '';
    containerRef.current.style.flexShrink = '';
    containerRef.current.style.height = '';
    containerRef.current.style.maxHeight = '';
  }, [containerRef]);

  const refreshTerminalScreen = useCallback((term: XTerm) => {
    try {
      const bufferLength = term.buffer?.active?.length ?? 0;
      const lastRow = Math.max(0, Math.max(term.rows - 1, bufferLength - 1));
      term.refresh(0, lastRow);
    } catch {
      // Ignore refresh failures; geometry is still updated by fit().
    }
  }, []);

  const refitTerminal = useCallback((options?: { forceSync?: boolean; syncBackend?: boolean }) => {
    if (!isVisibleRef.current || !isConnectedRef.current) return;

    const fit = fitAddonRef.current;
    const term = termRef.current;
    const container = containerRef.current;
    if (!fit || !term || !container) return;

    clearLayoutWidthPin();

    const nextWidth = container.clientWidth;
    const nextHeight = container.clientHeight;
    if (nextWidth <= 0 || nextHeight <= 0) return;

    if (!safeFitTerminal(fit, term)) {
      return;
    }

    try {
      refreshTerminalScreen(term);
      const shouldSyncBackend = options?.syncBackend ?? true;
      if (shouldSyncBackend) {
        if (options?.forceSync) {
          const cached = terminalCache.get(sessionIdRef.current);
          if (cached) cached.lastResize = null;
        }
        syncTerminalResize(sessionIdRef.current, term);
      }
    } catch (e) {
      console.warn('Terminal refit failed', e);
    }
  }, [clearLayoutWidthPin, refreshTerminalScreen, containerRef, fitAddonRef, termRef]);

  useEffect(() => {
    resizeSchedulerRef.current = createResizeScheduler(refitTerminal);
    return () => {
      resizeSchedulerRef.current?.cancel();
      resizeSchedulerRef.current = null;
    };
  }, [refitTerminal]);

  const finishLayoutTransition = useCallback(() => {
    if (layoutTransitionSafetyTimerRef.current) {
      clearTimeout(layoutTransitionSafetyTimerRef.current);
      layoutTransitionSafetyTimerRef.current = null;
    }

    isLayoutTransitioning.current = false;
    setLayoutTransitioning(false);
    clearLayoutWidthPin();

    resizeSchedulerRef.current?.schedule({ forceSync: true, immediate: true });
  }, [clearLayoutWidthPin]);

  const terminalGpuAllowed = Boolean(isVisible && isWorkspaceActive && isTerminalView);
  const terminalRendererSettingsKey = useMemo(
    () => [
      terminalSettings.gpuAcceleration,
      terminalSettings.fontLigatures,
      terminalSettings.fontFamily,
      terminalSettings.fontSize,
      terminalSettings.lineHeight,
      terminalSettings.cursorStyle,
    ].join('|'),
    [
      terminalSettings.gpuAcceleration,
      terminalSettings.fontLigatures,
      terminalSettings.fontFamily,
      terminalSettings.fontSize,
      terminalSettings.lineHeight,
      terminalSettings.cursorStyle,
    ],
  );

  useEffect(() => {
    const term = termRef.current ?? terminalCache.get(sessionId)?.term ?? null;
    if (!isConnected || !term) {
      return;
    }

    const rendererState = getTerminalRendererState(sessionId);

    // Inactive shell tabs: release WebGL so we do not exhaust browser context limits.
    // Keep GPU when Files/Dashboard is open (isTerminalView=false) — scrollback fix.
    if (isTerminalView && !isVisible) {
      if (rendererState.webglAddon) {
        deferAfterPaint(() => {
          void activateDomRenderer(term, rendererState);
        });
      }
      return;
    }

    if (!isVisible || !terminalGpuAllowed) {
      return;
    }

    const effectiveSettings = buildEffectiveRendererSettings(terminalSettings, terminalGpuAllowed);
    const gpuDesired = Boolean(effectiveSettings.gpuAcceleration);
    const lastAppliedKey = lastAppliedRendererSettingsBySessionRef.current.get(sessionId);
    const settingsChanged = lastAppliedKey !== terminalRendererSettingsKey;
    const needsSetup = needsTerminalRendererSetup(rendererState, gpuDesired);

    if (!needsSetup && !settingsChanged) {
      if (rendererState.webglContextLossBlocked && rendererState.kind !== 'dom') {
        void activateDomRenderer(term, rendererState).then(() => {
          restoreTerminalDisplay(term, fitAddonRef.current);
        });
      } else {
        restoreTerminalDisplay(term, fitAddonRef.current);
      }
      return;
    }

    deferAfterPaint(() => {
      void applyTerminalRendererAndLigatures(
        sessionId,
        term,
        effectiveSettings,
        fitAddonRef.current,
        syncTerminalResize,
      ).then(() => {
        lastAppliedRendererSettingsBySessionRef.current.set(sessionId, terminalRendererSettingsKey);
        safeFitTerminal(fitAddonRef.current, term);
        syncTerminalTheme(term);
      });

      safeFitTerminal(fitAddonRef.current, term);
    });
  }, [sessionId, terminalRendererSettingsKey, terminalGpuAllowed, isConnected, isVisible, isTerminalView, termRef, fitAddonRef, terminalSettings, syncTerminalTheme]);

  const prevIsVisibleRef = useRef(isVisible);
  const prevIsTerminalViewRef = useRef(isTerminalView);

  useEffect(() => {
    if (!isVisible || !isConnected || !isTerminalView) {
      prevIsVisibleRef.current = isVisible;
      prevIsTerminalViewRef.current = isTerminalView;
      return;
    }

    const shellTabSwitch = prevIsTerminalViewRef.current && prevIsVisibleRef.current !== isVisible;
    const returningFromFeatureView = !prevIsTerminalViewRef.current && isTerminalView;
    prevIsVisibleRef.current = isVisible;
    prevIsTerminalViewRef.current = isTerminalView;

    if (shellTabSwitch && !returningFromFeatureView) {
      let cancelled = false;
      const frame = requestAnimationFrame(() => {
        if (cancelled) return;
        try {
          resizeSchedulerRef.current?.schedule({ forceSync: true, immediate: true });
          const term = termRef.current;
          if (term) {
            refreshTerminalScreen(term);
          }
          term?.focus();
        } catch (e) {
          console.warn('Fit/Focus failed on shell tab switch', e);
        }
      });

      return () => {
        cancelled = true;
        cancelAnimationFrame(frame);
      };
    }

    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;
    let frame2 = 0;

    const frame1 = requestAnimationFrame(() => {
      frame2 = requestAnimationFrame(() => {
        if (cancelled) return;
        timer = setTimeout(() => {
          if (cancelled) return;
          try {
            resizeSchedulerRef.current?.schedule({ forceSync: true, immediate: true });
            const term = termRef.current;
            if (term) {
              refreshTerminalScreen(term);
            }
            term?.focus();
          } catch (e) {
            console.warn('Fit/Focus failed on visibility change', e);
          }
        }, 100);
      });
    });

    return () => {
      cancelled = true;
      cancelAnimationFrame(frame1);
      if (frame2) cancelAnimationFrame(frame2);
      if (timer) clearTimeout(timer);
    };
  }, [isVisible, isConnected, isTerminalView, refitTerminal, refreshTerminalScreen, termRef]);

  useEffect(() => {
    if (!isTerminalView || !isConnected || !isVisible) return;

    let cancelled = false;
    let frame2 = 0;
    const frame1 = requestAnimationFrame(() => {
      frame2 = requestAnimationFrame(() => {
        if (cancelled) return;
        restoreTerminalDisplay(termRef.current, fitAddonRef.current);
      });
    });

    return () => {
      cancelled = true;
      cancelAnimationFrame(frame1);
      if (frame2) cancelAnimationFrame(frame2);
    };
  }, [isTerminalView, isConnected, sessionId, isVisible, termRef, fitAddonRef]);

  useEffect(() => {
    if (!isConnected || !sessionId || !termRef.current) return;

    const cached = terminalCache.get(sessionId);
    const action = resolveLazyPtyAction(
      { isWorkspaceActive, isTerminalView, isActiveTab },
      Boolean(cached?.spawned),
    );

    if (action === 'suspend_panel') {
      suspendTerminalPty(sessionId, { panelHide: true });
      return;
    }

    if (action === 'spawn' && cached && !isTerminalIdleSuspended(sessionId)) {
      const store = useAppStore.getState();
      let frame = 0;
      let attempts = 0;
      const trySpawn = () => {
        const term = termRef.current;
        if (!term || !terminalCache.get(sessionId)) {
          return;
        }
        if (!isTerminalDomMeasurable(term)) {
          attempts += 1;
          if (attempts < 30) {
            frame = requestAnimationFrame(trySpawn);
          }
          return;
        }
        spawnTerminalFromStoreContext({
          sessionId,
          connectionId: spawnConnectionId,
          terminalKey,
          term,
          clearBuffer: false,
          terminals: store.terminals,
          windowsShell: store.settings.localTerm?.windowsShell,
          remoteReady,
        });
      };
      trySpawn();
      return () => {
        if (frame) cancelAnimationFrame(frame);
      };
    }
  }, [isWorkspaceActive, isTerminalView, isActiveTab, isConnected, sessionId, terminalKey, spawnConnectionId, remoteReady, termRef]);

  useEffect(() => {
    const handleStart = () => {
      isLayoutTransitioning.current = true;
      setLayoutTransitioning(true);
      clearLayoutWidthPin();

      if (layoutTransitionSafetyTimerRef.current) {
        clearTimeout(layoutTransitionSafetyTimerRef.current);
      }
      layoutTransitionSafetyTimerRef.current = setTimeout(() => {
        layoutTransitionSafetyTimerRef.current = null;
        if (isLayoutTransitioning.current) {
          console.warn('[Terminal] Layout transition safety timeout — forcing refit');
          finishLayoutTransition();
        }
      }, 500);
    };
    const handleEnd = () => {
      finishLayoutTransition();
    };

    window.addEventListener('zync:layout-transition-start', handleStart);
    window.addEventListener('zync:layout-transition-end', handleEnd);
    return () => {
      window.removeEventListener('zync:layout-transition-start', handleStart);
      window.removeEventListener('zync:layout-transition-end', handleEnd);
      if (layoutTransitionSafetyTimerRef.current) {
        clearTimeout(layoutTransitionSafetyTimerRef.current);
        layoutTransitionSafetyTimerRef.current = null;
      }
    };
  }, [clearLayoutWidthPin, finishLayoutTransition]);

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout>;
    const handleWindowResize = () => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        if (isLayoutTransitioning.current) {
          finishLayoutTransition();
        } else {
          resizeSchedulerRef.current?.schedule({ forceSync: true });
        }
      }, 100);
    };

    window.addEventListener('resize', handleWindowResize);
    return () => {
      window.removeEventListener('resize', handleWindowResize);
      clearTimeout(timer);
    };
  }, [finishLayoutTransition]);

  useEffect(() => {
    if (!containerRef.current || !activeConnectionId || !sessionId || !isConnected) return;

    let term: XTerm;
    let fitAddon: FitAddon;
    let searchAddon: SearchAddon;
    let isNewTerminal = false;
    let focusTimer: ReturnType<typeof setTimeout> | undefined;

    const cached = terminalCache.get(sessionId);
    if (cached) {
      term = cached.term;
      fitAddon = cached.fitAddon;
      searchAddon = cached.searchAddon;
      if (containerRef.current) {
        if (term.element) {
          if (!containerRef.current.contains(term.element)) {
            containerRef.current.appendChild(term.element);
          }
        } else {
          term.open(containerRef.current);
        }
        if (isVisibleRef.current) {
          focusTimer = setTimeout(() => term.focus(), 50);
        }
      }
    } else {
      isNewTerminal = true;

      const settings = terminalSettingsRef.current;
      const initialTheme = resolveInitialThemeRef.current();

      term = new XTerm(buildXtermOptions({
        settings,
        theme: initialTheme,
        windowsLocalPty: shouldUseWindowsLocalPtyOptions(terminalKey),
      }));

      fitAddon = new FitAddon();
      const webLinksAddon = new WebLinksAddon();
      searchAddon = new SearchAddon();

      term.loadAddon(fitAddon);
      term.loadAddon(webLinksAddon);
      term.loadAddon(searchAddon);

      term.parser.registerOscHandler(7, (data) => {
        try {
          let path = data;
          if (path.startsWith('file://')) {
            path = path.replace(/^file:\/\/[^/]*/, '');
          }
          path = decodeURIComponent(path);
          if (/^\/[a-zA-Z]:/.test(path)) {
            path = path.slice(1);
          }
          if (path) {
            useAppStore.getState().setTerminalCwd(terminalKey, sessionId, path);
          }
        } catch { /* ignore malformed OSC 7 */ }
        return true;
      });

      term.open(containerRef.current);

      terminalCache.set(sessionId, {
        term,
        fitAddon,
        searchAddon,
        generation: 0,
        spawned: false,
        starting: false,
        listenerAttached: false,
        pendingInput: '',
        pendingInputBytes: 0,
        inputFlushTimer: null,
        lastResize: null,
        ligaturesAddon: undefined,
        ligaturesEnabled: false,
      });

      onCreateTerminalRef.current?.(term);

      if (isVisibleRef.current) {
        focusTimer = setTimeout(() => term.focus(), 100);
      }
    }

    const unbindMount = onBindMountRef.current?.({ term, sessionId, isNewTerminal }) ?? (() => {});

    fitAddonRef.current = fitAddon;
    searchAddonRef.current = searchAddon;
    termRef.current = term;
    syncTerminalTheme(term);

    attachTerminalLifecycleListeners(sessionId, term);

    if (terminalCache.get(sessionId)?.suspendedByIdle) {
      writeIdleHostSuspendNotice(sessionId);
    }

    const rendererState = getTerminalRendererState(sessionId);
    const gpuAllowed = Boolean(
      isVisibleRef.current
      && isWorkspaceActiveRef.current
      && isTerminalViewRef.current,
    );
    const effectiveSettings = buildEffectiveRendererSettings(
      terminalSettingsRef.current,
      gpuAllowed,
    );
    const gpuDesired = Boolean(effectiveSettings.gpuAcceleration);

    if (needsTerminalRendererSetup(rendererState, gpuDesired)) {
      void applyTerminalRendererAndLigatures(
        sessionId,
        term,
        effectiveSettings,
        fitAddon,
        syncTerminalResize,
      ).then(() => {
        lastAppliedRendererSettingsBySessionRef.current.set(sessionId, terminalRendererSettingsKey);
        safeFitTerminal(fitAddon, term);
        syncTerminalTheme(term);
      });
    } else {
      lastAppliedRendererSettingsBySessionRef.current.set(sessionId, terminalRendererSettingsKey);
      safeFitTerminal(fitAddon, term);
      restoreTerminalDisplay(term, fitAddon);
    }

    const cachedEntry = terminalCache.get(sessionId);
    if (
      cachedEntry
      && !cachedEntry.spawned
      && !cachedEntry.suspendedByIdle
      && isWorkspaceActiveRef.current
      && isTerminalViewRef.current
      && isActiveTabRef.current
    ) {
      const store = useAppStore.getState();
      spawnTerminalFromStoreContext({
        sessionId,
        connectionId: spawnConnectionId,
        terminalKey,
        term,
        clearBuffer: isNewTerminal,
        terminals: store.terminals,
        windowsShell: store.settings.localTerm?.windowsShell,
        remoteReady,
      });
    }

    const resizeObserver = new ResizeObserver(() => {
      try {
        if (!isVisibleRef.current || !term.element || !containerRef.current) return;

        const nextWidth = containerRef.current.clientWidth;
        const nextHeight = containerRef.current.clientHeight;
        if (nextWidth <= 0 || nextHeight <= 0) return;

        if (isLayoutTransitioning.current) return;

        resizeSchedulerRef.current?.schedule();
      } catch (e) {
        console.warn('Xterm fit resize failed', e);
      }
    });

    if (containerRef.current) {
      resizeObserver.observe(containerRef.current);
    }

    return () => {
      if (focusTimer !== undefined) {
        clearTimeout(focusTimer);
      }
      resizeObserver.disconnect();
      resizeSchedulerRef.current?.cancel();

      const cachedForCleanup = terminalCache.get(sessionId);
      if (cachedForCleanup?.onDataDisposable) {
        cachedForCleanup.onDataDisposable.dispose();
        cachedForCleanup.onDataDisposable = undefined;
      }
      if (cachedForCleanup?.spawned) {
        flushPendingInput(sessionId);
      } else {
        clearTerminalPendingInput(sessionId);
      }
      unbindMount();

      const term = cachedForCleanup?.term;
      if (term?.element?.parentElement) {
        term.element.parentElement.removeChild(term.element);
      }

      termRef.current = null;
      fitAddonRef.current = null;
      searchAddonRef.current = null;
    };
  }, [
    activeConnectionId,
    sessionId,
    isConnected,
    containerRef,
    termRef,
    fitAddonRef,
    searchAddonRef,
    terminalKey,
    spawnConnectionId,
    remoteReady,
    syncTerminalTheme,
    terminalRendererSettingsKey,
  ]);

  useEffect(() => {
    const handleWakeup = (e: Event) => {
      if (!sessionId || !termRef.current) return;
      if ((e as CustomEvent).detail !== sessionId) return;

      const store = useAppStore.getState();
      tryWakeTerminalOnReconnect({
        sessionId,
        connectionId: spawnConnectionId,
        terminalKey,
        term: termRef.current,
        isVisible: Boolean(isVisibleRef.current),
        terminals: store.terminals,
        windowsShell: store.settings.localTerm?.windowsShell,
        remoteReady: true,
      });
    };

    window.addEventListener(TERMINAL_CONNECTION_WAKEUP_EVENT, handleWakeup);
    return () => window.removeEventListener(TERMINAL_CONNECTION_WAKEUP_EVENT, handleWakeup);
  }, [sessionId, spawnConnectionId, terminalKey, termRef]);

  return {
    layoutTransitioning,
    isVisibleRef,
    isConnectedRef,
    sessionIdRef,
  };
}