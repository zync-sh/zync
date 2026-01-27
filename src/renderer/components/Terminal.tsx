import { useEffect, useRef, useState, useCallback } from 'react';
import { Terminal as XTerm } from 'xterm';
import { FitAddon } from 'xterm-addon-fit';
import { SearchAddon } from 'xterm-addon-search';
import { WebLinksAddon } from 'xterm-addon-web-links';
import 'xterm/css/xterm.css';
import { useAppStore, Connection } from '../store/useAppStore';
import { Search, ArrowUp, ArrowDown, X, Copy, Clipboard as ClipboardIcon, Trash2, Scissors } from 'lucide-react';
import { cn } from '../lib/utils';
import { ContextMenu } from './ui/ContextMenu';
import { Button } from './ui/Button';
import { Terminal } from 'lucide-react';

// Module-level cache to preserve xterm instances across component remounts
// This ensures terminal history is maintained during tab reordering
interface TerminalCache {
  term: XTerm;
  fitAddon: FitAddon;
  searchAddon: SearchAddon;
  spawned: boolean;
  dataHandler?: (event: any, payload: { termId: string; data: string }) => void;
}
const terminalCache = new Map<string, TerminalCache>();

// Export for cleanup from terminalSlice when terminal is explicitly closed
export function destroyTerminalInstance(termId: string) {
  const cached = terminalCache.get(termId);
  if (cached) {
    // Remove the IPC listener if it exists
    if (cached.dataHandler) {
      window.ipcRenderer.off('terminal:data', cached.dataHandler);
    }
    cached.term.dispose();
    terminalCache.delete(termId);
  }
}

export function TerminalComponent({ connectionId, termId, isVisible }: { connectionId?: string; termId?: string; isVisible?: boolean }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<XTerm | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const searchAddonRef = useRef<SearchAddon | null>(null);

  // Search State
  const [isSearchOpen, setIsSearchOpen] = useState(false);
  const [searchText, setSearchText] = useState('');
  const searchInputRef = useRef<HTMLInputElement>(null);

  // Context Menu State
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number } | null>(null);

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
  const updateSettings = useAppStore(state => state.updateSettings);

  // Helper for terminal settings update if needed, though usually we update global settings
  const updateTerminalSettings = (newSettings: Partial<typeof settings.terminal>) => {
    updateSettings({ terminal: { ...settings.terminal, ...newSettings } });
  };

  const activeConnectionId = connectionId || globalActiveId;

  // Find connection status
  const isLocal = activeConnectionId === 'local';
  const connection = !isLocal ? connections.find((c: Connection) => c.id === activeConnectionId) : null;
  const isConnected = isLocal || connection?.status === 'connected';

  // Use termId if provided, otherwise fallback to connectionId
  const sessionId = termId || activeConnectionId;

  // Apply Settings Effect
  useEffect(() => {
    if (termRef.current) {
      termRef.current.options.fontSize = settings.terminal.fontSize;
      termRef.current.options.fontFamily = settings.terminal.fontFamily;
      termRef.current.options.cursorStyle = settings.terminal.cursorStyle;
      termRef.current.options.lineHeight = settings.terminal.lineHeight;
    }

    if (fitAddonRef.current) {
      try {
        fitAddonRef.current.fit();
      } catch (_e) {
        // ignore
      }
    }
  }, [settings.terminal]);

  // Force fit when visibility changes (e.g. switching tabs)
  useEffect(() => {
    if (isVisible && fitAddonRef.current && termRef.current) {
      // Small delay to allow layout transitions to complete
      const timer = setTimeout(() => {
        try {
          fitAddonRef.current?.fit();
          // Also sync with backend
          if (termRef.current) {
            window.ipcRenderer.send('terminal:resize', {
              termId: sessionId,
              rows: termRef.current.rows,
              cols: termRef.current.cols,
            });
          }
        } catch (e) { console.warn('Fit failed on visibility change', e); }
      }, 50); // 50ms matches usually enough for display:block to settle, MainLayout has 300ms transition but content appears instantly?
      // Actually MainLayout has duration-300. But width should be available immediately on display:block.
      // Let's keep a small safety delay.
      return () => clearTimeout(timer);
    }
  }, [isVisible, sessionId]);

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

      // Re-open in new container (reattaches to DOM)
      if (containerRef.current && term.element && !containerRef.current.contains(term.element)) {
        term.open(containerRef.current);
      }
    } else {
      // Create new terminal instance
      isNewTerminal = true;

      const computedStyle = getComputedStyle(document.body);
      const appBg = computedStyle.getPropertyValue('--color-app-bg').trim();
      const appText = computedStyle.getPropertyValue('--color-app-text').trim();
      const appAccent = computedStyle.getPropertyValue('--color-app-accent').trim();

      term = new XTerm({
        cursorBlink: true,
        fontSize: settings.terminal.fontSize,
        fontFamily: settings.terminal.fontFamily,
        cursorStyle: settings.terminal.cursorStyle,
        lineHeight: settings.terminal.lineHeight,
        allowProposedApi: true,
        theme: {
          background: appBg || '#0f111a',
          foreground: appText || '#e2e8f0',
          cursor: appAccent || '#6366f1',
          selectionBackground: appAccent ? `${appAccent}33` : 'rgba(99, 102, 241, 0.3)',
          black: '#000000',
          red: '#ef4444',
          green: '#10b981',
          yellow: '#f59e0b',
          blue: '#3b82f6',
          magenta: '#d946ef',
          cyan: '#06b6d4',
          white: '#ffffff',
          brightBlack: '#64748b',
          brightRed: '#fca5a5',
          brightGreen: '#86efac',
          brightYellow: '#fcd34d',
          brightBlue: '#93c5fd',
          brightMagenta: '#f0abfc',
          brightCyan: '#67e8f9',
          brightWhite: '#f8fafc',
        },
      });

      // Initialize Addons
      fitAddon = new FitAddon();
      const webLinksAddon = new WebLinksAddon();
      searchAddon = new SearchAddon();

      term.loadAddon(fitAddon);
      term.loadAddon(webLinksAddon);
      term.loadAddon(searchAddon);

      term.open(containerRef.current);

      // Custom Key Handler
      term.attachCustomKeyEventHandler((e) => {
        if (e.type === 'keydown') {
          // Smart Copy: Ctrl+C
          if (e.key.toLowerCase() === 'c' && (e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey) {
            if (term.hasSelection()) {
              const selection = term.getSelection();
              navigator.clipboard.writeText(selection);
              term.clearSelection();
              return false;
            }
          }

          // Zoom In: Ctrl + = or Ctrl + +
          if ((e.ctrlKey || e.metaKey) && (e.key === '=' || e.key === '+')) {
            e.preventDefault();
            const currentSize = settings.terminal.fontSize;
            updateTerminalSettings({ fontSize: Math.min(currentSize + 1, 32) });
            return false;
          }

          // Zoom Out: Ctrl + -
          if ((e.ctrlKey || e.metaKey) && e.key === '-') {
            e.preventDefault();
            const currentSize = settings.terminal.fontSize;
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
      terminalCache.set(sessionId, { term, fitAddon, searchAddon, spawned: false });
    }

    fitAddonRef.current = fitAddon;
    searchAddonRef.current = searchAddon;
    termRef.current = term;

    try {
      fitAddon.fit();
    } catch (e) {
      console.warn('Failed to fit terminal', e);
    }

    // Spawn shell via IPC - only for new terminals that haven't been spawned yet
    const cachedEntry = terminalCache.get(sessionId);
    if (cachedEntry && !cachedEntry.spawned) {
      cachedEntry.spawned = true;
      window.ipcRenderer
        .invoke('terminal:spawn', {
          connectionId: activeConnectionId,
          termId: sessionId,
          rows: term.rows,
          cols: term.cols,
        })
        .catch((err) => {
          console.error('Failed to spawn terminal:', err);
          term.write(`\r\n\x1b[31mFailed to start terminal session: ${err.message}\x1b[0m\r\n`);
        });
    }

    // Handle data from user input - only set up for new terminals
    if (isNewTerminal) {
      term.onData((data) => {
        window.ipcRenderer.send('terminal:write', { termId: sessionId, data });
      });
    }

    // Set up IPC listener for incoming terminal data - only once per terminal
    const cachedForListener = terminalCache.get(sessionId);
    if (cachedForListener && !cachedForListener.dataHandler) {
      // Create and store the handler so we only have one per terminal
      const handleTerminalData = (_: any, { termId: incomingTermId, data }: { termId: string; data: string }) => {
        if (incomingTermId === sessionId) {
          term.write(data);
        }
      };
      cachedForListener.dataHandler = handleTerminalData;
      window.ipcRenderer.on('terminal:data', handleTerminalData);
    }

    const resizeObserver = new ResizeObserver(() => {
      try {
        requestAnimationFrame(() => {
          if (!term.element || !containerRef.current) return;

          // Prevent resizing if dimensions are invalid/hidden (0x0)
          if (containerRef.current.clientWidth === 0 || containerRef.current.clientHeight === 0) return;

          fitAddon.fit();
          window.ipcRenderer.send('terminal:resize', {
            termId: sessionId,
            rows: term.rows,
            cols: term.cols,
          });
        });
      } catch (e) {
        console.warn('Resize failed', e);
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
    const handleGlobalCopy = () => {
      // Only trigger if this terminal is the active one (or part of active view)
      // For simplicity, we check if this component's ID matches the global active one
      // If we implement split views later, we'll need a different check (e.g. tracking focus)
      if (activeConnectionId === globalActiveId && termRef.current?.hasSelection()) {
        const selection = termRef.current.getSelection();
        if (selection) navigator.clipboard.writeText(selection);
      }
    };

    const handleGlobalPaste = async () => {
      if (activeConnectionId === globalActiveId) {
        try {
          const text = await navigator.clipboard.readText();
          if (text && termRef.current) termRef.current.paste(text);
        } catch (e) {
          console.error('Paste failed:', e);
        }
      }
    };

    const handleGlobalFind = () => {
      if (activeConnectionId === globalActiveId) {
        setIsSearchOpen(true);
        // Small delay to ensure render
        setTimeout(() => searchInputRef.current?.focus(), 50);
      }
    };

    window.addEventListener('ssh-ui:term-copy', handleGlobalCopy);
    window.addEventListener('ssh-ui:term-paste', handleGlobalPaste);
    window.addEventListener('ssh-ui:term-find', handleGlobalFind);

    return () => {
      window.removeEventListener('ssh-ui:term-copy', handleGlobalCopy);
      window.removeEventListener('ssh-ui:term-paste', handleGlobalPaste);
      window.removeEventListener('ssh-ui:term-find', handleGlobalFind);
    };
  }, [activeConnectionId, globalActiveId]);

  // Define Presets
  const THEME_PRESETS: Record<string, any> = {
    'red': { background: '#1a0b0b', cursor: '#ef4444', selectionBackground: 'rgba(239, 68, 68, 0.3)' },
    'blue': { background: '#0b101a', cursor: '#3b82f6', selectionBackground: 'rgba(59, 130, 246, 0.3)' },
    'green': { background: '#0b1a10', cursor: '#10b981', selectionBackground: 'rgba(16, 185, 129, 0.3)' },
    'orange': { background: '#1a120b', cursor: '#f97316', selectionBackground: 'rgba(249, 115, 22, 0.3)' },
    'purple': { background: '#160b1a', cursor: '#d946ef', selectionBackground: 'rgba(217, 70, 239, 0.3)' },
  };

  useEffect(() => {
    if (!termRef.current || !activeConnectionId) return;

    // Calculate effective theme
    const computedStyle = getComputedStyle(document.body);
    const appBg = computedStyle.getPropertyValue('--color-app-bg').trim();
    const appText = computedStyle.getPropertyValue('--color-app-text').trim();
    const appAccent = computedStyle.getPropertyValue('--color-app-accent').trim();

    // Default Theme
    let themeObj = {
      background: appBg || '#0f111a',
      foreground: appText || '#e2e8f0',
      cursor: appAccent || '#6366f1',
      selectionBackground: appAccent ? `${appAccent}33` : 'rgba(99, 102, 241, 0.3)',
      black: '#000000',
      red: '#ef4444',
      green: '#10b981',
      yellow: '#f59e0b',
      blue: '#3b82f6',
      magenta: '#d946ef',
      cyan: '#06b6d4',
      white: '#ffffff',
      brightBlack: '#64748b',
      brightRed: '#fca5a5',
      brightGreen: '#86efac',
      brightYellow: '#fcd34d',
      brightBlue: '#93c5fd',
      brightMagenta: '#f0abfc',
      brightCyan: '#67e8f9',
      brightWhite: '#f8fafc',
    };

    // Apply Override if exists
    if (connection?.theme && THEME_PRESETS[connection.theme]) {
      themeObj = { ...themeObj, ...THEME_PRESETS[connection.theme] };
    }

    termRef.current.options.theme = themeObj;

  }, [settings.theme, settings.accentColor, connection?.theme, activeConnectionId]);

  if (!activeConnectionId) return <div className="p-8 text-gray-400">Please connect to a server first.</div>;

  if (!isConnected) {
    const isConnecting = connection?.status === 'connecting';
    const hasError = connection?.status === 'error';

    return (
      <div className="flex flex-col h-full items-center justify-center p-8 text-app-muted gap-4">
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
      className="h-full w-full bg-app-bg p-2 relative group focus:outline-none"
      ref={containerRef}
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
        "absolute top-4 right-4 z-50 flex items-center gap-1 p-1 bg-app-panel/95 backdrop-blur-xl border border-app-border rounded-lg shadow-xl transition-all duration-200 ease-out origin-top-right",
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
    </div>
  );
}
