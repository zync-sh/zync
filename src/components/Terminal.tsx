import { useEffect, useRef, useState, useCallback } from 'react';
import { Terminal as XTerm } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { SearchAddon } from '@xterm/addon-search';
import { WebLinksAddon } from '@xterm/addon-web-links';
import '@xterm/xterm/css/xterm.css';
import { useAppStore, Connection } from '../store/useAppStore';
import { Search, ArrowUp, ArrowDown, X, Copy, Clipboard as ClipboardIcon, Trash2, Scissors } from 'lucide-react';
import { cn } from '../lib/utils';
import { ContextMenu } from './ui/ContextMenu';
import { Button } from './ui/Button';
import { Terminal } from 'lucide-react';
import { listen, UnlistenFn } from '@tauri-apps/api/event';
import { InputTracker } from '../lib/ghostSuggestions/inputTracker';
import {
  acceptGhostCommand,
  commitGhostCommand,
  resolveInlineSuggestion,
  resolvePopupCandidates,
  resolveTabCompletionOutcome,
  shouldPreferPathSuggestion,
} from '../lib/ghostSuggestions/client';
import type { GhostTabState } from '../lib/ghostSuggestions/types';
import { createInitialGhostTabState, resetGhostTabState } from '../lib/ghostSuggestions/tabState';
import { bindGhostTrackerRuntime } from '../lib/ghostSuggestions/runtime';
import { handleGhostInputEvent } from '../lib/ghostSuggestions/runtime';
import { useGhostPopupState } from '../lib/ghostSuggestions/uiState';
import { GhostSuggestionOverlay } from './terminal/GhostSuggestionOverlay';
import { GhostSuggestionListOverlay } from './terminal/GhostSuggestionListOverlay';

// Module-level cache to preserve xterm instances across component remounts
// This ensures terminal history is maintained during tab reordering
interface TerminalCache {
  term: XTerm;
  fitAddon: FitAddon;
  searchAddon: SearchAddon;
  generation: number;
  spawned: boolean;
  starting: boolean;
  listenerAttached: boolean;
  pendingInput: string;
  inputFlushTimer: ReturnType<typeof window.setTimeout> | null;
  lastResize: { rows: number; cols: number } | null;
  unlisten?: UnlistenFn[];
  ghostTracker?: InputTracker;
  onDataDisposable?: { dispose: () => void };
  ligaturesAddon?: { dispose: () => void };
  ligaturesEnabled: boolean;
  ligaturesDesiredEnabled?: boolean;
  ligaturesLoadPromise?: Promise<void> | null;
}
const terminalCache = new Map<string, TerminalCache>();
let ligaturesAddonImport: Promise<typeof import('@xterm/addon-ligatures')> | null = null;

const INPUT_BATCH_MS = 4;
const INPUT_FLUSH_THRESHOLD = 64;
const inputByteEncoder = new TextEncoder();
const IMMEDIATE_INPUT_PATTERN = /[\r\n\x03\x04\x1b]/;
const THEME_PRESETS: Record<string, Record<string, string>> = {
  red: { background: '#1a0b0b', cursor: '#ef4444', selectionBackground: 'rgba(239, 68, 68, 0.3)' },
  blue: { background: '#0b101a', cursor: '#3b82f6', selectionBackground: 'rgba(59, 130, 246, 0.3)' },
  green: { background: '#0b1a10', cursor: '#10b981', selectionBackground: 'rgba(16, 185, 129, 0.3)' },
  orange: { background: '#1a120b', cursor: '#f97316', selectionBackground: 'rgba(249, 115, 22, 0.3)' },
  purple: { background: '#160b1a', cursor: '#d946ef', selectionBackground: 'rgba(217, 70, 239, 0.3)' },
};

async function setTerminalLigatures(sessionId: string, term: XTerm, enabled: boolean) {
  const cached = terminalCache.get(sessionId);
  if (!cached) return;
  cached.ligaturesDesiredEnabled = enabled;

  if (enabled) {
    if (cached.ligaturesAddon) {
      cached.ligaturesEnabled = true;
      return;
    }
    if (!cached.ligaturesLoadPromise) {
      cached.ligaturesLoadPromise = (async () => {
        try {
          if (!ligaturesAddonImport) {
            ligaturesAddonImport = import('@xterm/addon-ligatures');
          }
          const { LigaturesAddon } = await ligaturesAddonImport;
          const latest = terminalCache.get(sessionId);
          if (!latest || latest.ligaturesDesiredEnabled !== true || latest.ligaturesAddon) return;
          const addon = new LigaturesAddon();
          term.loadAddon(addon);
          latest.ligaturesAddon = addon;
        } catch (error) {
          console.warn('[terminal] Failed to load ligatures addon', error);
        } finally {
          const latest = terminalCache.get(sessionId);
          if (latest) latest.ligaturesLoadPromise = null;
        }
      })();
    }
    await cached.ligaturesLoadPromise;
    cached.ligaturesEnabled = true;
    return;
  }

  if (cached.ligaturesAddon) {
    try {
      cached.ligaturesAddon.dispose();
    } catch (error) {
      console.warn('[terminal] Failed to dispose ligatures addon', error);
    }
    cached.ligaturesAddon = undefined;
  }
  cached.ligaturesEnabled = false;
}
// Export recent terminal buffer lines for AI context
export function getTerminalRecentLines(termId: string, lineCount = 20): string | null {
  if (!termId) {
    return null;
  }

  const cached = terminalCache.get(termId);
  if (!cached?.term?.buffer?.active) return null;
  const buf = cached.term.buffer.active;
  const lines: string[] = [];
  const start = Math.max(0, buf.length - lineCount);
  for (let i = start; i < buf.length; i++) {
    const line = buf.getLine(i);
    if (line) lines.push(line.translateToString(true));
  }
  return lines.join('\n').trim() || null;
}

// Export for cleanup from terminalSlice when terminal is explicitly closed
export function destroyTerminalInstance(termId: string) {
  if (!termId) {
    return;
  }

  const cached = terminalCache.get(termId);
  if (cached) {
    clearPendingInput(termId);
    cached.ghostTracker?.destroy();
    if (cached.ligaturesAddon) {
      try {
        cached.ligaturesAddon.dispose();
      } catch (error) {
        console.warn('[terminal] Failed to dispose ligatures addon on destroy', error);
      }
      cached.ligaturesAddon = undefined;
    }
    // Remove all Tauri event listeners if they exist
    if (cached.unlisten && cached.unlisten.length > 0) {
      cached.unlisten.forEach(fn => fn());
      cached.unlisten = [];
    }
    cached.term.dispose();
    terminalCache.delete(termId);
  }
}

/** Returns true when the active app theme has a light background */
function isLightTheme(): boolean {
  const classes = document.body.classList;
  if (classes.contains('light') || classes.contains('light-warm')) return true;
  // For system theme: check media query
  const dataTheme = document.body.getAttribute('data-theme') ?? '';
  if (dataTheme === 'light') return true;
  return false;
}

type TerminalTransparencySettings = {
  enableVibrancy?: boolean;
  windowOpacity?: number;
};

/**
 * Maps the legacy appearance keys onto the terminal-only transparency behavior.
 * The persisted setting names stay the same for compatibility, but only the
 * terminal viewport consumes them now.
 */
function resolveTerminalTransparency(settings: TerminalTransparencySettings) {
  const opacity = Math.max(0, Math.min(1, settings.windowOpacity ?? 1));
  return {
    enabled: Boolean(settings.enableVibrancy) && opacity < 1,
    opacity: Boolean(settings.enableVibrancy) ? opacity : 1,
  };
}

/**
 * Converts a theme color into an RGBA string so xterm can render with a real
 * alpha background while leaving the rest of the app fully opaque.
 */
function withAlpha(color: string, alpha: number): string {
  const clampedAlpha = Math.max(0, Math.min(1, alpha));
  if (clampedAlpha <= 0) return 'rgba(0, 0, 0, 0)';
  if (!color) return `rgba(15, 17, 26, ${clampedAlpha})`;

  const normalized = color.trim();
  const hexMatch = normalized.match(/^#([0-9a-f]{3}|[0-9a-f]{6})$/i);
  if (hexMatch) {
    const hex = hexMatch[1].length === 3
      ? hexMatch[1].split('').map(ch => ch + ch).join('')
      : hexMatch[1];
    const r = parseInt(hex.slice(0, 2), 16);
    const g = parseInt(hex.slice(2, 4), 16);
    const b = parseInt(hex.slice(4, 6), 16);
    return `rgba(${r}, ${g}, ${b}, ${clampedAlpha})`;
  }

  const rgbMatch = normalized.match(/^rgba?\(([^)]+)\)$/i);
  if (rgbMatch) {
    const channels = rgbMatch[1].split(',').map(part => part.trim());
    if (channels.length >= 3) {
      return `rgba(${channels[0]}, ${channels[1]}, ${channels[2]}, ${clampedAlpha})`;
    }
  }

  return clampedAlpha >= 1 ? normalized : `rgba(15, 17, 26, ${clampedAlpha})`;
}
/**
 * Builds the background for the outer terminal host. Applying the slider here
 * keeps the opacity behavior consistent across xterm renderer modes.
 */
function buildTerminalHostBackground(opacity: number): string {
  const clampedPercent = Math.max(0, Math.min(100, Math.round(opacity * 100)));
  return `color-mix(in srgb, var(--color-app-bg) ${clampedPercent}%, transparent)`;
}

/**
 * Resolves the xterm theme background color. When terminal transparency is
 * active the host element owns the translucent fill, so xterm itself stays
 * transparent and does not double-apply the opacity.
 */
function buildTerminalBackground(appBg: string, opacity: number, useHostBackground = false): string {
  if (useHostBackground) {
    return 'rgba(0, 0, 0, 0)';
  }

  const light = isLightTheme();
  const fallback = light ? '#f8fafc' : '#0f111a';
  return withAlpha(appBg || fallback, opacity);
}

/**
 * Merges an optional connection theme preset without reintroducing an opaque
 * background when terminal transparency is active.
 */
function mergeTerminalThemePreset<T extends Record<string, string>>(
  theme: T,
  preset: Record<string, string>,
  transparencyEnabled: boolean,
  opacity: number,
): T {
  if (!transparencyEnabled) {
    return { ...theme, ...preset } as T;
  }

  // When transparency is enabled, we apply the current opacity to the preset's background
  // instead of stripping it entirely.
  const themeWithAlpha = { ...theme, ...preset } as any;
  if (preset.background) {
    themeWithAlpha.background = withAlpha(preset.background, opacity);
  }

  return themeWithAlpha as T;
}

/**
 * Computes a blended color value directly for compatibility.
 * Blends the given hex color with white based on the provided ratio.
 */
function blendWithWhite(hexColor: string, ratio: number): string {
  let hex = hexColor.replace('#', '');
  if (hex.length === 3) {
    hex = hex.split('').map(c => c + c).join('');
  }
  const r = parseInt(hex.slice(0, 2), 16);
  const g = parseInt(hex.slice(2, 4), 16);
  const b = parseInt(hex.slice(4, 6), 16);
  const blendR = Math.round(r * ratio + 255 * (1 - ratio));
  const blendG = Math.round(g * ratio + 255 * (1 - ratio));
  const blendB = Math.round(b * ratio + 255 * (1 - ratio));
  return `#${blendR.toString(16).padStart(2, '0')}${blendG.toString(16).padStart(2, '0')}${blendB.toString(16).padStart(2, '0')}`;
}

/**
 * Build an xterm theme object from current CSS variables.
 * In light mode the ANSI "white" colors are swapped to dark so they remain
 * visible against the light background.
 */
function buildXtermTheme(appBg: string, appText: string, appAccent: string, backgroundOpacity = 1, useHostBackground = false) {
  const light = isLightTheme();
  return {
    background: buildTerminalBackground(appBg, backgroundOpacity, useHostBackground),
    foreground: appText || (light ? '#18181b' : '#e2e8f0'),
    cursor: appAccent || '#6366f1',
    selectionBackground: appAccent ? `${appAccent}33` : 'rgba(99, 102, 241, 0.3)',
    black: light ? '#3f3f46' : '#000000',
    red: '#ef4444',
    green: '#10b981',
    yellow: appAccent || '#d97706',
    blue: '#3b82f6',
    magenta: '#d946ef',
    cyan: '#0891b2',
    white: light ? '#18181b' : '#ffffff',
    brightBlack: light ? '#71717a' : '#64748b',
    brightRed: '#fca5a5',
    brightGreen: '#86efac',
    brightYellow: appAccent ? blendWithWhite(appAccent, 0.8) : '#fcd34d',
    brightBlue: '#93c5fd',
    brightMagenta: '#f0abfc',
    brightCyan: '#67e8f9',
    brightWhite: light ? '#09090b' : '#f8fafc',
  };
}


/**
 * Clears any buffered terminal input and cancels a scheduled flush.
 */
function clearPendingInput(termId: string | null | undefined): void {
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

  cached.pendingInput = '';
}

/**
 * Sends queued terminal input to the backend as a single IPC write.
 */
function flushPendingInput(termId: string | null | undefined): void {
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

  if (!cached.pendingInput) {
    return;
  }

  const data = cached.pendingInput;
  cached.pendingInput = '';
  window.ipcRenderer.send('terminal:write', { termId, data });
}

interface TerminalLifecycleEvent {
  generation: number;
}

interface TerminalOutputEvent extends TerminalLifecycleEvent {
  data: number[];
}

/**
 * Queues terminal input for a short batching window while still flushing
 * immediately for control-sensitive keys and larger chunks.
 */
function queueTerminalInput(termId: string | null | undefined, data: string): void {
  if (!termId) {
    return;
  }

  const cached = terminalCache.get(termId);
  if (!cached) {
    window.ipcRenderer.send('terminal:write', { termId, data });
    return;
  }

  cached.pendingInput += data;
  const bufferedBytes = inputByteEncoder.encode(cached.pendingInput).length;
  const shouldFlushImmediately = IMMEDIATE_INPUT_PATTERN.test(data) || bufferedBytes >= INPUT_FLUSH_THRESHOLD;

  if (shouldFlushImmediately) {
    flushPendingInput(termId);
    return;
  }

  if (cached.inputFlushTimer === null) {
    cached.inputFlushTimer = window.setTimeout(() => {
      flushPendingInput(termId);
    }, INPUT_BATCH_MS);
  }
}

/**
 * Sends a terminal resize only when the row or column count actually changed.
 */
function syncTerminalResize(termId: string | null | undefined, term: XTerm): void {
  const nextSize = { rows: term.rows, cols: term.cols };
  if (!termId) {
    return;
  }

  const cached = terminalCache.get(termId);

  if (!cached) {
    window.ipcRenderer.send('terminal:resize', { termId, ...nextSize });
    return;
  }

  if (cached.lastResize?.rows === nextSize.rows && cached.lastResize?.cols === nextSize.cols) {
    return;
  }

  cached.lastResize = nextSize;
  window.ipcRenderer.send('terminal:resize', { termId, ...nextSize });
}

export function TerminalComponent({ connectionId, termId, isVisible }: { connectionId?: string; termId?: string; isVisible?: boolean }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<XTerm | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const searchAddonRef = useRef<SearchAddon | null>(null);
  
  // Layout transition fast-path tracking
  const isLayoutTransitioning = useRef(false);
  // Layout transition React state for DOM class rendering
  const [layoutTransitioning, setLayoutTransitioning] = useState(false);

  // Search State
  const [isSearchOpen, setIsSearchOpen] = useState(false);
  const [searchText, setSearchText] = useState('');
  const [ghostSuggestion, setGhostSuggestion] = useState('');
  const {
    ghostPopup,
    ghostPopupRef,
    closeGhostPopup,
    openGhostPopup,
    moveGhostPopupSelection,
  } = useGhostPopupState();
  const searchInputRef = useRef<HTMLInputElement>(null);

  // Context Menu State
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number } | null>(null);
  const ghostTabStateRef = useRef<GhostTabState>(createInitialGhostTabState());
  const ghostTrackerRef = useRef<InputTracker | null>(null);

  // Search handlers
  const handleNext = useCallback(() => {
    searchAddonRef.current?.findNext(searchText);
  }, [searchText]);

  const handlePrev = useCallback(() => {
    searchAddonRef.current?.findPrevious(searchText);
  }, [searchText]);

  const handleClose = useCallback(() => {
    setIsSearchOpen(false);
    setSearchText('');
    termRef.current?.focus();
  }, []);

  const globalActiveId = useAppStore(state => state.activeConnectionId);
  const connections = useAppStore(state => state.connections);
  const connect = useAppStore(state => state.connect);
  const settings = useAppStore(state => state.settings);
  const terminalTransparency = resolveTerminalTransparency(settings);
  const terminalHostStyle = terminalTransparency.enabled
    ? {
      backgroundColor: 'var(--color-app-bg)',
      background: buildTerminalHostBackground(terminalTransparency.opacity),
    }
    : undefined;
  const updateSettings = useAppStore(state => state.updateSettings);
  const ghostSettings = settings.ghostSuggestions;
  const ghostSettingsRef = useRef(ghostSettings);
  const terminalSettingsRef = useRef(settings.terminal);

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

  useEffect(() => {
    terminalSettingsRef.current = settings.terminal;
  }, [settings.terminal]);

  // Helper for terminal settings update if needed, though usually we update global settings
  const updateTerminalSettings = (newSettings: Partial<typeof settings.terminal>) => {
    updateSettings({ terminal: { ...terminalSettingsRef.current, ...newSettings } });
  };

  const activeConnectionId = connectionId || globalActiveId;
  const terminalKey = activeConnectionId || 'local';
  const ghostScope = connectionId || terminalKey;
  const windowsShell = settings.localTerm?.windowsShell;
  const currentFontSizeRef = useRef(settings.terminal.fontSize);

  useEffect(() => {
    currentFontSizeRef.current = settings.terminal.fontSize;
  }, [settings.terminal.fontSize]);

  // Find connection status
  const isLocal = terminalKey === 'local';
  const connection = !isLocal ? connections.find((c: Connection) => c.id === terminalKey) : null;
  const isConnected = isLocal || connection?.status === 'connected';

  // True when this tab was restored from a previous session and has never spawned a PTY yet.
  const isPendingRestore = useAppStore(state =>
    !isLocal && !!state.terminals[terminalKey]?.find(t => t.id === (termId || terminalKey))?.pendingRestore
  );

  // Use termId if provided, otherwise fallback to terminalKey
  const sessionId = termId || terminalKey;

  const acceptGhostSuffix = useCallback((suffix: string) => {
    if (!suffix) return;
    const cached = terminalCache.get(sessionId);
    cached?.ghostTracker?.appendToLineBuffer(suffix);
    cached?.ghostTracker?.clearSuggestion();
    queueTerminalInput(sessionId, suffix);
    acceptGhostCommand(cached?.ghostTracker?.getLineBuffer() ?? '', ghostScope).catch(() => {});
    closeGhostPopup();
    setGhostSuggestion('');
    // Reset Tab-cycle state so subsequent Tab presses start a fresh cycle.
    ghostTabStateRef.current = resetGhostTabState();
  }, [sessionId, ghostScope, closeGhostPopup]);

  const truncateLabel = useCallback((label: string, max = 60) => {
    if (label.length <= max) return label;
    return `${label.slice(0, Math.max(0, max - 1))}…`;
  }, []);

  // Apply Settings Effect
  useEffect(() => {
    if (termRef.current) {
      const term = termRef.current;
      term.options.fontSize = settings.terminal.fontSize;
      term.options.fontFamily = settings.terminal.fontFamily;
      term.options.cursorStyle = settings.terminal.cursorStyle;
      term.options.lineHeight = settings.terminal.lineHeight;
      void (async () => {
        await setTerminalLigatures(sessionId, term, Boolean(settings.terminal.fontLigatures));
        try {
          const lastRow = Math.max(0, term.rows - 1);
          term.refresh(0, lastRow);
        } catch {
          // Ignore refresh failures; fit below still applies geometry.
        }
      })();
    }

    if (fitAddonRef.current) {
      try {
        fitAddonRef.current.fit();
      } catch (_e) {
        // ignore
      }
    }
  }, [sessionId, settings.terminal]);

  // Force fit and focus when visibility changes (e.g. switching tabs) or connection becomes active
  useEffect(() => {
    if (isVisible && isConnected && fitAddonRef.current && termRef.current) {
      let timer: ReturnType<typeof setTimeout>;
      // Small delay using requestAnimationFrame + setTimeout for layout stability
      const frameId = requestAnimationFrame(() => {
        timer = setTimeout(() => {
          try {
            if (fitAddonRef.current) fitAddonRef.current.fit();

            // Focus the terminal aggressively when it becomes visible or connected
            if (termRef.current) {
              termRef.current.focus();

              // Also sync with backend
              syncTerminalResize(sessionId, termRef.current);
            }
          } catch (e) { console.warn('Fit/Focus failed on visibility change', e); }
        }, 150); // Increased delay for layout settling
      });
      
      return () => {
        cancelAnimationFrame(frameId);
        if (timer) clearTimeout(timer);
      };
    }
  }, [isVisible, sessionId, isConnected]);

  // Layout Transition Listener (Flicker Hardening V2)
  useEffect(() => {
    const handleStart = () => {
      isLayoutTransitioning.current = true;
      setLayoutTransitioning(true);

      // V2 Width Pinning: Lock the terminal to its current pixel width instantly
      // using our own container width to prevent the flex parent from squishing the canvas
      if (containerRef.current) {
        const currentWidth = containerRef.current.offsetWidth;
        if (currentWidth && currentWidth > 0) {
          containerRef.current.style.width = `${currentWidth}px`;
          containerRef.current.style.flexShrink = '0';
        }
      }
    };
    const handleEnd = () => {
      isLayoutTransitioning.current = false;
      setLayoutTransitioning(false);
      
      // Unlock the fixed width
      if (containerRef.current) {
        containerRef.current.style.width = '';
        containerRef.current.style.flexShrink = '';
      }

      // Trigger a final clean fit when the layout is stable
      if (isVisible && isConnected && fitAddonRef.current && termRef.current) {
        try {
          fitAddonRef.current.fit();
          syncTerminalResize(sessionId, termRef.current);
        } catch (e) { console.warn('Final layout fit failed', e); }
      }
    };

    window.addEventListener('zync:layout-transition-start', handleStart);
    window.addEventListener('zync:layout-transition-end', handleEnd);
    return () => {
      window.removeEventListener('zync:layout-transition-start', handleStart);
      window.removeEventListener('zync:layout-transition-end', handleEnd);
    };
  }, [isVisible, isConnected, sessionId]);

  useEffect(() => {
    if (!containerRef.current || !activeConnectionId || !sessionId || !isConnected) return;

    let term: XTerm;
    let fitAddon: FitAddon;
    let searchAddon: SearchAddon;
    let isNewTerminal = false;

    // Check if we have a cached terminal instance
    const cached = terminalCache.get(sessionId);
    if (cached) {
      // Reuse existing terminal - preserves history!
      term = cached.term;
      fitAddon = cached.fitAddon;
      searchAddon = cached.searchAddon;

      // Reattach cached xterm DOM when remounting after route/view changes.
      // xterm.open() is a one-time operation; for already-opened terminals we
      // must move the existing element instead of calling open() again.
      if (containerRef.current) {
        if (term.element) {
          if (!containerRef.current.contains(term.element)) {
            containerRef.current.appendChild(term.element);
          }
        } else {
          term.open(containerRef.current);
        }
        if (isVisible) {
          setTimeout(() => term.focus(), 50);
        }
      }
    } else {
      // Create new terminal instance
      isNewTerminal = true;

      const computedStyle = getComputedStyle(containerRef.current ?? document.body);
      const appBg = computedStyle.getPropertyValue('--color-app-bg').trim();
      const appText = computedStyle.getPropertyValue('--color-app-text').trim();
      const appAccent = computedStyle.getPropertyValue('--color-app-accent').trim();
      const themePreset = connection?.theme && THEME_PRESETS[connection.theme]
        ? THEME_PRESETS[connection.theme]
        : null;
      const initialTheme = themePreset
        ? mergeTerminalThemePreset(
          buildXtermTheme(appBg, appText, appAccent, terminalTransparency.opacity, terminalTransparency.enabled),
          themePreset,
          terminalTransparency.enabled,
          terminalTransparency.opacity,
        )
        : buildXtermTheme(appBg, appText, appAccent, terminalTransparency.opacity, terminalTransparency.enabled);

      term = new XTerm({
        cursorBlink: true,
        fontSize: settings.terminal.fontSize,
        fontFamily: settings.terminal.fontFamily,
        cursorStyle: settings.terminal.cursorStyle,
        lineHeight: settings.terminal.lineHeight,
        allowTransparency: true,
        allowProposedApi: true,
        theme: initialTheme,
      });

      // Initialize Addons
      fitAddon = new FitAddon();
      const webLinksAddon = new WebLinksAddon();
      searchAddon = new SearchAddon();

      term.loadAddon(fitAddon);
      term.loadAddon(webLinksAddon);
      term.loadAddon(searchAddon);

      // OSC 7 CWD tracking — fired by shells that support shell integration
      // (bash w/ PROMPT_COMMAND, zsh precmd, fish, starship, oh-my-posh, etc.)
      term.parser.registerOscHandler(7, (data) => {
        try {
          // Format: "file://hostname/path"  or  "file:///path"  or just "/path"
          let path = data;
          if (path.startsWith('file://')) {
            // Strip scheme + authority: file://hostname/path → /path
            path = path.replace(/^file:\/\/[^/]*/, '');
          }
          // Decode percent-encoded chars regardless of whether the file:// prefix was present.
          path = decodeURIComponent(path);
          // Windows absolute paths arrive as /C:/Users/... — strip leading slash.
          if (/^\/[a-zA-Z]:/.test(path)) {
            path = path.slice(1);
          }
          if (path) {
            useAppStore.getState().setTerminalCwd(terminalKey, sessionId, path);
          }
        } catch { /* ignore malformed OSC 7 */ }
        return true; // consumed — do not pass to xterm default handler
      });

      term.open(containerRef.current);

      // Focus immediately for new terminals
      if (isVisible) {
        setTimeout(() => term.focus(), 100);
      }

      // Custom Key Handler
      term.attachCustomKeyEventHandler((e) => {
        if (e.type === 'keydown') {

          // AI Command Bar: Ctrl/Cmd + I
          if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'i') {
            e.preventDefault();
            window.dispatchEvent(new CustomEvent('zync:ai-command-bar'));
            return false;
          }

          // Zoom In: Ctrl + = or Ctrl + +
          if ((e.ctrlKey || e.metaKey) && (e.key === '=' || e.key === '+')) {
            e.preventDefault();
            const currentSize = currentFontSizeRef.current;
            updateTerminalSettings({ fontSize: Math.min(currentSize + 1, 32) });
            return false;
          }

          // Zoom Out: Ctrl + -
          if ((e.ctrlKey || e.metaKey) && e.key === '-') {
            e.preventDefault();
            const currentSize = currentFontSizeRef.current;
            updateTerminalSettings({ fontSize: Math.max(currentSize - 1, 8) });
            return false;
          }

          if (e.key === 'Escape') {
            if (isSearchOpen) {
              setIsSearchOpen(false);
              term.focus();
              return false;
            }
          }
        }
        return true;
      });

      // Store in cache
      terminalCache.set(sessionId, {
        term,
        fitAddon,
        searchAddon,
        generation: 0,
        spawned: false,
        starting: false,
        listenerAttached: false,
        pendingInput: '',
        inputFlushTimer: null,
        lastResize: null,
        ligaturesAddon: undefined,
        ligaturesEnabled: false,
      });
      void setTerminalLigatures(sessionId, term, Boolean(settings.terminal.fontLigatures));

      // Create tracker once per cached terminal; handlers are bound per mount below.
      const ghostTracker = new InputTracker({
        onLineChange: () => {},
        onAccept: () => {},
        onDismiss: () => {},
        onHistoryCommit: () => {},
      });
      terminalCache.get(sessionId)!.ghostTracker = ghostTracker;
    }

    // Bind ghost suggestion handlers for this mount (prevents stale React callbacks
    // when the terminal instance survives remounts via terminalCache).
    const cachedGhostTracker = terminalCache.get(sessionId)?.ghostTracker;
    ghostTrackerRef.current = cachedGhostTracker ?? null;
    // If inline suggestions are already disabled at mount time, clear any stale
    // active suffix that survived from a previous session.
    if (!ghostSettingsRef.current.inlineEnabled) {
      ghostTrackerRef.current?.clearSuggestion();
    }
    const unbindGhostTracker = cachedGhostTracker
      ? bindGhostTrackerRuntime({
        tracker: cachedGhostTracker,
        debounceMs: 30,
        resolveInlineSuggestion: async (line) => {
          if (!ghostSettingsRef.current.inlineEnabled) return '';
          const termState = useAppStore.getState().terminals[terminalKey]?.find(t => t.id === sessionId);
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

          // Always close immediately so stale results from a previous async
          // call never remain visible while the new request is in-flight.
          closeGhostPopup();

          if (!ghostSettingsRef.current.popupEnabled || line.trim().length < 2) {
            return;
          }

          const termState = useAppStore.getState().terminals[terminalKey]?.find(t => t.id === sessionId);
          const cwd = termState?.lastKnownCwd ?? termState?.initialPath;
          const preferPath = shouldPreferPathSuggestion(line);
          void resolvePopupCandidates({
            line,
            cwd,
            scope: ghostScope,
            preferPath,
            limit: 10,
            providers: ghostSettingsRef.current.providers,
          }).then((items) => {
            if (!cachedGhostTracker || cachedGhostTracker.getLineBuffer() !== line) return;
            // Re-check live setting — user may have disabled popup while resolution was in flight.
            if (!ghostSettingsRef.current.popupEnabled) return;
            if (items.length > 1) openGhostPopup(items, line);
            else closeGhostPopup();
          }).catch(() => {
            closeGhostPopup();
          });
        },
        onAccept: (suffix, lineAfterAccept) => {
          queueTerminalInput(sessionId, suffix);
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

    fitAddonRef.current = fitAddon;
    searchAddonRef.current = searchAddon;
    termRef.current = term;

    try {
      fitAddon.fit();
    } catch (e) {
      console.warn('Failed to fit terminal', e);
    }

    const triggerGhostPopup = async (tracker: InputTracker) => {
      try {
        const line = tracker.getLineBuffer();
        if (!ghostSettingsRef.current.popupEnabled) {
          queueTerminalInput(sessionId, '\t');
          return;
        }
        const termState = useAppStore.getState().terminals[terminalKey]?.find(t => t.id === sessionId);
        const cwd = termState?.lastKnownCwd ?? termState?.initialPath;
        const outcome = await resolveTabCompletionOutcome({
          line,
          cwd,
          scope: ghostScope,
          previousTabState: ghostTabStateRef.current,
          now: Date.now(),
          limit: 24,
          providers: ghostSettingsRef.current.providers,
        });

        // Stale-result guard: discard if the user typed more while we were awaiting.
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
          // Re-check: user may have disabled popups while the async call was in flight.
          if (!ghostSettingsRef.current.popupEnabled) {
            ghostTabStateRef.current = resetGhostTabState();
            closeGhostPopup();
            queueTerminalInput(sessionId, '\t');
            return;
          }
          ghostTabStateRef.current = outcome.nextState;
          openGhostPopup(outcome.items, line);
          return;
        }

        closeGhostPopup();
        ghostTabStateRef.current = resetGhostTabState();
        // No custom candidates: fall back to shell-native tab completion.
        queueTerminalInput(sessionId, '\t');
      } catch (error) {
        console.warn('[Ghost] Tab popup resolution failed:', error);
        ghostTabStateRef.current = resetGhostTabState();
        closeGhostPopup();
        queueTerminalInput(sessionId, '\t');
      }
    };

    // Rebind input handler per mount so callbacks always use current React state.
    const cachedForInput = terminalCache.get(sessionId);
    if (cachedForInput?.onDataDisposable) {
      cachedForInput.onDataDisposable.dispose();
      cachedForInput.onDataDisposable = undefined;
    }

    if (cachedForInput) {
      cachedForInput.onDataDisposable = term.onData(async (data) => {
        const cached = terminalCache.get(sessionId);

        // Check if the PTY session has ended and needs restart
        if (cached && !cached.spawned) {
          console.log('[Terminal] Session ended, restarting on user input');
          clearPendingInput(sessionId);
          cached.lastResize = null;
          const generation = cached.generation + 1;
          cached.generation = generation;
          cached.spawned = true;
          cached.starting = true;

          // Clear terminal for fresh start
          term.clear();
          term.reset();

          // Get shell preference for local terminals on Windows
          const isLocalTerminal = terminalKey === 'local';
          const shellSetting = isLocalTerminal
            ? useAppStore.getState().settings.localTerm?.windowsShell
            : undefined;

          // Resolve CWD for restart
          const terminals = useAppStore.getState().terminals;
          const terminalTab = terminals[terminalKey]?.find(t => t.id === sessionId);
          const restartCwd = terminalTab?.lastKnownCwd || terminalTab?.initialPath;

          // Respawn the terminal session
          window.ipcRenderer
            .invoke('terminal:create', {
              termId: sessionId,
              connectionId: terminalKey,
              rows: term.rows,
              cols: term.cols,
              shell: shellSetting,
              cwd: restartCwd,
              generation,
            })
            .catch((err) => {
              console.error('Failed to restart terminal:', err);
              term.write(`\r\n\x1b[31mFailed to restart terminal session: ${err}\x1b[0m\r\n`);
              if (cached.generation === generation) {
                cached.starting = false;
                cached.spawned = false;
              }
            });
          cached.ghostTracker?.reset();
          setGhostSuggestion('');
          closeGhostPopup();
          ghostTabStateRef.current = resetGhostTabState();
          return; // Don't send the input that triggered restart
        }

        // Ghost popup + inline suggestion routing.
        const handledByGhost = await handleGhostInputEvent({
          data: data,
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

        queueTerminalInput(sessionId, data);
      });
    }

    // Set up Tauri event listener for incoming terminal data - only once per terminal
    const cachedForListener = terminalCache.get(sessionId);
    if (cachedForListener && !cachedForListener.listenerAttached) {
      cachedForListener.listenerAttached = true;

      // Initialize unlisten array if not present
      if (!cachedForListener.unlisten) {
        cachedForListener.unlisten = [];
      }

      // Listen to Tauri event for this specific terminal
      listen<TerminalOutputEvent>(`terminal-output-${sessionId}`, (event) => {
        const cached = terminalCache.get(sessionId);
        if (!cached || event.payload.generation !== cached.generation) {
          return;
        }
        term.write(new Uint8Array(event.payload.data));
      }).then((unlistenFn) => {
        // Store the unlisten function
        if (terminalCache.has(sessionId)) {
          terminalCache.get(sessionId)!.unlisten!.push(unlistenFn);
        }
      });

      listen<TerminalLifecycleEvent>(`terminal-ready-${sessionId}`, (event) => {
        const cached = terminalCache.get(sessionId);
        if (cached && event.payload.generation === cached.generation) {
          cached.starting = false;
          cached.spawned = true;
        }
      }).then((unlistenFn) => {
        if (terminalCache.has(sessionId)) {
          terminalCache.get(sessionId)!.unlisten!.push(unlistenFn);
        }
      });

      // Listen for terminal exit event to reset the spawned flag
      listen<TerminalLifecycleEvent>(`terminal-exit-${sessionId}`, (event) => {
        console.log(`[Terminal] Session ${sessionId} exited`);
        const cached = terminalCache.get(sessionId);
        if (cached) {
          if (event.payload.generation !== cached.generation) {
            console.log(`[Terminal] Ignoring stale exit for ${sessionId} from generation ${event.payload.generation}`);
            return;
          }
          // Reset spawned flag so terminal can be restarted
          cached.starting = false;
          cached.spawned = false;
          clearPendingInput(sessionId);
          cached.lastResize = null;
          // Clear the terminal buffer and show exit message
          term.write('\r\n\x1b[33m[Terminal session ended. Press Enter to restart.]\x1b[0m\r\n');
        }
      }).then((unlistenFn) => {
        if (terminalCache.has(sessionId)) {
          terminalCache.get(sessionId)!.unlisten!.push(unlistenFn);
        }
      });
    }

    // Spawn shell via IPC - only after listeners are attached so we never miss
    // same-generation ready/output/exit events from a fast PTY startup/exit.
    const cachedEntry = terminalCache.get(sessionId);
    if (cachedEntry && !cachedEntry.spawned) {
      const generation = cachedEntry.generation + 1;
      cachedEntry.generation = generation;
      cachedEntry.spawned = true;
      cachedEntry.starting = true;

      // Get shell preference for local terminals on Windows
      const isLocalTerminal = (connectionId || 'local') === 'local';
      const shellSetting = isLocalTerminal ? settings.localTerm?.windowsShell : undefined;

      // Clear any existing content from a previous session (fresh start)
      if (!isNewTerminal) {
        term.clear();
        term.reset();
      }

      // Get initial/current path if any
      const terminals = useAppStore.getState().terminals;
      const terminalTab = terminals[terminalKey]?.find(t => t.id === sessionId);
      const spawnCwd = terminalTab?.lastKnownCwd || terminalTab?.initialPath;

      window.ipcRenderer
        .invoke('terminal:create', {
          termId: sessionId,
          connectionId: connectionId || 'local',
          rows: term.rows,
          cols: term.cols,
          shell: shellSetting,
          cwd: spawnCwd,
          generation,
        })
        .catch((err) => {
          console.error('Failed to create terminal:', err);
          term.write(`\r\n\x1b[31mFailed to start terminal session: ${err}\x1b[0m\r\n`);
          if (cachedEntry.generation === generation) {
            cachedEntry.starting = false;
            cachedEntry.spawned = false;
          }
        });
    }

    let ipcResizeTimer: any;
    const resizeObserver = new ResizeObserver(() => {
      try {
        if (!term.element || !containerRef.current) return;
        
        // Flicker Hardening: Skip fitting if we are currently animating/dragging a sidebar
        if (isLayoutTransitioning.current) return;

        // Only fit if dimensions are valid
        const nextWidth = containerRef.current.clientWidth;
        const nextHeight = containerRef.current.clientHeight;
        if (nextWidth <= 0 || nextHeight <= 0) return;

        // Synchronous visual fit prevents tearing/flickering during layout changes!
        // We MUST do this before the browser paints the next frame.
        fitAddon.fit();

        // Throttle backend PTY resize communication (IPC) to prevent flooding Tauri
        if (ipcResizeTimer) clearTimeout(ipcResizeTimer);
        ipcResizeTimer = window.setTimeout(() => {
          syncTerminalResize(sessionId, term);
        }, 50);

      } catch (e) {
        console.warn('Xterm fit resize failed', e);
      }
    });

    if (containerRef.current) {
      resizeObserver.observe(containerRef.current);
    }

    return () => {
      // NOTE: We do NOT remove the IPC listener here - it's stored in the cache
      // and will be cleaned up when destroyTerminalInstance() is called.
      // This prevents duplicate listeners when the component remounts.
      resizeObserver.disconnect();
      if (ipcResizeTimer) clearTimeout(ipcResizeTimer);

      const cachedForCleanup = terminalCache.get(sessionId);
      if (cachedForCleanup?.onDataDisposable) {
        cachedForCleanup.onDataDisposable.dispose();
        cachedForCleanup.onDataDisposable = undefined;
      }
      if (cachedForCleanup?.spawned) {
        flushPendingInput(sessionId);
      } else {
        clearPendingInput(sessionId);
      }
      unbindGhostTracker();

      // NOTE: We do NOT dispose the terminal here!
      // The terminal instance stays in cache to preserve history.
      // It will only be disposed when destroyTerminalInstance() is called
      // from terminalSlice.closeTerminal()

      termRef.current = null;
      fitAddonRef.current = null;
      searchAddonRef.current = null;
    };
  }, [
    activeConnectionId,
    sessionId,
    isConnected,
    // Settings dependencies removed to prevent re-spawning on theme/font changes.
  ]);

  // Handle Global Shortcuts (Copy, Paste, Find)
  useEffect(() => {
    const handleGlobalCopy = async () => {
      // Only trigger if this terminal is currently visible/active
      if (isVisible && termRef.current?.hasSelection()) {
        const selection = termRef.current.getSelection();
        if (selection) {
          try {
            const { writeText } = await import('@tauri-apps/plugin-clipboard-manager');
            await writeText(selection);
          } catch (e) {
            console.error('Tauri copy failed, falling back to navigator:', e);
            navigator.clipboard.writeText(selection).catch(console.error);
          }
        }
      }
    };

    const handleGlobalPaste = async () => {
      if (isVisible) {
        try {
          // Use Tauri plugin for robust clipboard access
          const { readText } = await import('@tauri-apps/plugin-clipboard-manager');
          const text = await readText();
          if (text && termRef.current) {
            termRef.current.paste(text);
          }
        } catch (e) {
          console.error('Paste failed:', e);
          // Fallback to navigator (though likely to fail if plugin failed)
          try {
            const text = await navigator.clipboard.readText();
            if (text && termRef.current) termRef.current.paste(text);
          } catch (e2) {
            console.error('Fallback paste failed:', e2);
          }
        }
      }
    };

    const handleGlobalFind = () => {
      if (isVisible) {
        setIsSearchOpen(true);
        // Small delay to ensure render
        setTimeout(() => searchInputRef.current?.focus(), 50);
      }
    };

    const handleGlobalFocus = () => {
      if (isVisible) {
        termRef.current?.focus();
      }
    };

    window.addEventListener('ssh-ui:term-copy', handleGlobalCopy);
    window.addEventListener('ssh-ui:term-paste', handleGlobalPaste);
    window.addEventListener('ssh-ui:term-find', handleGlobalFind);
    window.addEventListener('ssh-ui:term-focus', handleGlobalFocus);

    return () => {
      window.removeEventListener('ssh-ui:term-copy', handleGlobalCopy);
      window.removeEventListener('ssh-ui:term-paste', handleGlobalPaste);
      window.removeEventListener('ssh-ui:term-find', handleGlobalFind);
      window.removeEventListener('ssh-ui:term-focus', handleGlobalFocus);
    };

  }, [activeConnectionId, globalActiveId, isVisible]);

  // Handle Automatic Reconnect Sync from File Manager
  useEffect(() => {
    const handleWakeup = (e: any) => {
      // sessionId can be string | null | undefined, handle it carefully
      if (sessionId && e.detail === sessionId) {
        const cached = terminalCache.get(sessionId);
        if (cached && !cached.spawned) {
          console.log('[Terminal] Auto-waking terminal from File Manager reconnect');
          
          clearPendingInput(sessionId);
          cached.lastResize = null;
          const generation = cached.generation + 1;
          cached.generation = generation;
          cached.spawned = true;
          cached.starting = true;
          termRef.current?.clear();
          termRef.current?.reset();
          
          const isLocalTerminal = (connectionId || 'local') === 'local';
          const shellSetting = isLocalTerminal ? windowsShell : undefined;
          const terminals = useAppStore.getState().terminals;
          const terminalTab = terminals[terminalKey]?.find(t => t.id === sessionId);
          const wakeCwd = terminalTab?.lastKnownCwd || terminalTab?.initialPath;

          window.ipcRenderer
            .invoke('terminal:create', {
              termId: sessionId,
              connectionId: connectionId || 'local',
              rows: termRef.current?.rows || 24,
              cols: termRef.current?.cols || 80,
              shell: shellSetting,
              cwd: wakeCwd,
              generation,
            })
            .catch((err) => {
              console.error('Failed to auto-restart terminal:', err);
              termRef.current?.write(`\r\n\x1b[31mFailed to automatically restart terminal: ${err}\x1b[0m\r\n`);
              if (cached.generation === generation) {
                cached.starting = false;
                cached.spawned = false;
              }
            });
        }
      }
    };
    
    window.addEventListener('connection-wakeup', handleWakeup);
    return () => window.removeEventListener('connection-wakeup', handleWakeup);
  }, [sessionId, connectionId, terminalKey, windowsShell]);

  useEffect(() => {
    if (!termRef.current || !activeConnectionId) return;

    // Calculate effective theme
    const computedStyle = getComputedStyle(containerRef.current ?? document.body);
    const appBg = computedStyle.getPropertyValue('--color-app-bg').trim();
    const appText = computedStyle.getPropertyValue('--color-app-text').trim();
    const appAccent = computedStyle.getPropertyValue('--color-app-accent').trim();

    // Default Theme
    let themeObj = buildXtermTheme(appBg, appText, appAccent, terminalTransparency.opacity, terminalTransparency.enabled);

    // Apply Override if exists
    if (connection?.theme && THEME_PRESETS[connection.theme]) {
      themeObj = mergeTerminalThemePreset(
        themeObj,
        THEME_PRESETS[connection.theme],
        terminalTransparency.enabled,
        terminalTransparency.opacity,
      );
    }

    termRef.current.options.theme = themeObj;

  }, [
    settings.theme,
    settings.accentColor,
    settings.enableVibrancy,
    settings.windowOpacity,
    connection?.theme,
    activeConnectionId,
  ]);

  if (!activeConnectionId) return <div className="p-8 text-gray-400">Please connect to a server first.</div>;

  if (!isConnected) {
    const isConnecting = connection?.status === 'connecting';
    const hasError = connection?.status === 'error';

    return (
      <div key="disconnected" className="flex flex-col h-full items-center justify-center p-8 text-app-muted gap-4 bg-app-panel z-10 relative">
        {isConnecting ? (
          <>
            <div className="animate-spin rounded-full h-5 w-5 border-2 border-app-accent border-t-transparent"></div>
            <span>Connecting to terminal...</span>
          </>
        ) : (
          <div className="h-full flex flex-col items-center justify-center text-app-muted gap-4">
            <div className="h-12 w-12 rounded-full bg-app-surface border border-app-border flex items-center justify-center text-app-muted/50">
              <Terminal size={24} />
            </div>
            <div className="text-center">
              <p className="text-sm font-medium text-app-text mb-1">
                {hasError ? 'Connection Error' : 'Disconnected'}
              </p>
              <p className="text-xs text-app-muted mb-4 opacity-70">
                {hasError
                  ? 'Failed to establish connection. Please check credentials and try again.'
                  : isPendingRestore
                    ? 'Terminal restored from last session. Reconnect to resume.'
                    : 'The connection to this terminal was closed.'}
              </p>
              <Button onClick={() => activeConnectionId && connect(activeConnectionId)}>
                {hasError ? 'Retry Connection' : 'Reconnect'}
              </Button>
            </div>
          </div>
        )}
      </div>
    );
  }

  return (
    <div
      key="connected"
      className={cn("h-full w-full relative group outline-none", terminalTransparency.enabled ? "terminal-transparent" : "bg-app-bg")}
      style={terminalHostStyle}
      tabIndex={-1}
      onClick={() => {
        if (termRef.current) {
          termRef.current.focus();
        }
      }}
      onContextMenu={(e) => {
        e.preventDefault();
        setContextMenu({ x: e.clientX, y: e.clientY });
      }}
    >
      {/* Search Overlay */}
      <div className={cn(
        "absolute top-4 right-4 z-50 flex items-center gap-1 p-1 bg-app-panel backdrop-blur-xl border border-app-border rounded-lg shadow-xl transition-all duration-200 ease-out origin-top-right",
        isSearchOpen ? "opacity-100 scale-100 translate-y-0" : "opacity-0 scale-95 -translate-y-2 pointer-events-none"
      )}>
        <div className="relative flex items-center">
          <Search className="absolute left-2 w-3.5 h-3.5 text-app-muted" />
          <input
            ref={searchInputRef}
            type="text"
            value={searchText}
            onChange={(e) => {
              setSearchText(e.target.value);
              searchAddonRef.current?.findNext(e.target.value, { incremental: true });
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                if (e.shiftKey) handlePrev();
                else handleNext();
              }
              if (e.key === 'Escape') handleClose();
            }}
            placeholder="Find..."
            className="w-48 bg-transparent text-sm text-app-text placeholder:text-app-muted/50 pl-7 pr-2 py-1 focus:outline-none"
          />
        </div>

        <div className="h-4 w-[1px] bg-app-border mx-1" />

        <button
          onClick={handlePrev}
          className="p-1 hover:bg-app-surface rounded text-app-muted hover:text-app-text transition-colors"
          title="Previous (Shift+Enter)"
        >
          <ArrowUp className="w-4 h-4" />
        </button>
        <button
          onClick={handleNext}
          className="p-1 hover:bg-app-surface rounded text-app-muted hover:text-app-text transition-colors"
          title="Next (Enter)"
        >
          <ArrowDown className="w-4 h-4" />
        </button>

        <button
          onClick={handleClose}
          className="p-1 hover:bg-red-500/10 hover:text-red-400 rounded text-app-muted transition-colors ml-1"
        >
          <X className="w-4 h-4" />
        </button>
      </div>

      {contextMenu && (
        <ContextMenu
          x={contextMenu.x}
          y={contextMenu.y}
          onClose={() => setContextMenu(null)}
          items={[
            ...(
              ghostSettings.contextMenuEnabled && ghostPopup.items.length
                ? [
                  {
                    label: 'Suggestions',
                    children: ghostPopup.items.slice(0, 8).map((suffix) => ({
                      label: truncateLabel(`${ghostPopup.anchorLine}${suffix}`),
                      action: () => {
                        acceptGhostSuffix(suffix);
                      },
                    })),
                  },
                  { separator: true as const },
                ]
                : ghostSettings.contextMenuEnabled && ghostSuggestion
                  ? [
                    {
                      label: truncateLabel(
                        `Accept suggestion: ${ghostPopup.anchorLine || (terminalCache.get(sessionId)?.ghostTracker?.getLineBuffer() ?? '')}${ghostSuggestion}`
                      ),
                      action: () => {
                        acceptGhostSuffix(ghostSuggestion);
                      },
                    },
                    { separator: true as const },
                  ]
                  : []
            ),
            {
              label: 'Copy',
              icon: <Copy className="w-4 h-4" />,
              action: () => {
                const selection = termRef.current?.getSelection();
                if (selection) navigator.clipboard.writeText(selection);
              },
              disabled: !termRef.current?.hasSelection()
            },
            {
              label: 'Paste',
              icon: <ClipboardIcon className="w-4 h-4" />,
              action: async () => {
                try {
                  const text = await navigator.clipboard.readText();
                  if (text) termRef.current?.paste(text);
                } catch (err) {
                  console.error('Failed to paste', err);
                }
              }
            },
            {
              label: 'Select All',
              icon: <Scissors className="w-4 h-4" />,
              action: () => termRef.current?.selectAll()
            },
            {
              label: 'Clear Terminal',
              icon: <Trash2 className="w-4 h-4" />,
              variant: 'danger',
              action: () => termRef.current?.clear()
            }
          ]}
        />
      )}

      {/* Terminal Canvas Wrapper - Strict bottom padding - Always overflow-hidden during transition */}
      <div
        className={cn(
          "absolute inset-0 pointer-events-none",
          layoutTransitioning && "overflow-hidden",
        )}
        style={{
          padding: `${Math.max(0, settings.terminal.padding ?? 12)}px`,
        }}
      >
        {/*
          Wrap containerRef and the ghost overlay in a shared relative div so
          the overlay can be positioned as a sibling (not a child) of the xterm
          container. xterm.js owns the DOM inside containerRef via term.open() —
          putting React children inside it causes reconciliation conflicts.
        */}
        <div className="relative h-full w-full">
          <div ref={containerRef} className="h-full w-full terminal-container pointer-events-auto" />
          {termRef.current && ghostSettings.inlineEnabled && ghostSuggestion && !ghostPopup.visible && (
            <div className="absolute inset-0 pointer-events-none overflow-hidden">
              <GhostSuggestionOverlay term={termRef.current} suggestion={ghostSuggestion} />
            </div>
          )}
          {termRef.current && ghostSettings.popupEnabled && ghostPopup.visible && ghostPopup.items.length > 0 && (
            <div className="absolute inset-0 pointer-events-none overflow-visible z-20">
              <GhostSuggestionListOverlay
                term={termRef.current}
                items={ghostPopup.items}
                selectedIndex={ghostPopup.selectedIndex}
                anchorLine={ghostPopup.anchorLine}
              />
            </div>
          )}
        </div>
      </div>
    </div>
  );
}








