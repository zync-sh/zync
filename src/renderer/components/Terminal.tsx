import { useEffect, useRef, useState, useCallback } from 'react';
import { Terminal as XTerm } from 'xterm';
import { FitAddon } from 'xterm-addon-fit';
import { SearchAddon } from 'xterm-addon-search';
import { WebLinksAddon } from 'xterm-addon-web-links';
import 'xterm/css/xterm.css';
import { useConnections } from '../context/ConnectionContext';
import { useSettings } from '../context/SettingsContext';
import { Search, ArrowUp, ArrowDown, X, Copy, Clipboard as ClipboardIcon, Trash2, Scissors } from 'lucide-react';
import { cn } from '../lib/utils';
import { ContextMenu } from './ui/ContextMenu';

export function TerminalComponent({ connectionId, termId }: { connectionId?: string; termId?: string }) {
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

  const { activeConnectionId: globalId, connections } = useConnections();
  const { settings, updateTerminalSettings } = useSettings();
  const activeConnectionId = connectionId || globalId;

  // Find connection status
  const isLocal = activeConnectionId === 'local';
  const connection = !isLocal ? connections.find((c) => c.id === activeConnectionId) : null;
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

  useEffect(() => {
    if (!containerRef.current || !activeConnectionId || !sessionId || !isConnected) return;

    // Initialize Xterm with settings
    const computedStyle = getComputedStyle(document.body);
    const appBg = computedStyle.getPropertyValue('--color-app-bg').trim();
    const appText = computedStyle.getPropertyValue('--color-app-text').trim();
    const appAccent = computedStyle.getPropertyValue('--color-app-accent').trim();

    const term = new XTerm({
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
    const fitAddon = new FitAddon();
    const webLinksAddon = new WebLinksAddon();
    const searchAddon = new SearchAddon();

    term.loadAddon(fitAddon);
    term.loadAddon(webLinksAddon);
    term.loadAddon(searchAddon);

    fitAddonRef.current = fitAddon;
    searchAddonRef.current = searchAddon;

    term.open(containerRef.current);

    // Clipboard handlers
    const handleCopy = async () => {
      const selection = term.getSelection();
      if (selection) {
        await navigator.clipboard.writeText(selection);
      }
    };

    const handlePaste = async () => {
      try {
        const text = await navigator.clipboard.readText();
        if (text) {
          term.paste(text);
        }
      } catch (err) {
        console.error('Failed to paste:', err);
      }
    };

    // Custom Key Handler
    term.attachCustomKeyEventHandler((e) => {
      if (e.type === 'keydown') {
        // Search: Ctrl+F
        if ((e.ctrlKey || e.metaKey) && e.key === 'f') {
          e.preventDefault();
          setIsSearchOpen(true);
          setTimeout(() => searchInputRef.current?.focus(), 50);
          return false;
        }
        // Copy: Ctrl+Shift+C
        if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key === 'C') {
          e.preventDefault();
          handleCopy();
          return false;
        }
        // Paste: Ctrl+Shift+V
        if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key === 'V') {
          e.preventDefault();
          handlePaste();
          return false;
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

    try {
      fitAddon.fit();
    } catch (e) {
      console.warn('Failed to fit terminal', e);
    }

    termRef.current = term;

    // Spawn shell via IPC
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

    // Handle data
    term.onData((data) => {
      window.ipcRenderer.send('terminal:write', { termId: sessionId, data });
    });

    // Define the listener
    const handleTerminalData = (_: any, { termId: incomingTermId, data }: { termId: string; data: string }) => {
      if (incomingTermId === sessionId) {
        term.write(data);
      }
    };

    window.ipcRenderer.on('terminal:data', handleTerminalData);

    const resizeObserver = new ResizeObserver(() => {
      try {
        requestAnimationFrame(() => {
          if (!term.element) return;
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
      window.ipcRenderer.off('terminal:data', handleTerminalData);
      resizeObserver.disconnect();
      term.dispose();
      termRef.current = null;
      fitAddonRef.current = null;
      searchAddonRef.current = null;
    };
  }, [
    activeConnectionId,
    sessionId,
    isConnected,
    settings.terminal.cursorStyle,
    settings.terminal.fontFamily,
    settings.terminal.fontSize,
    settings.terminal.lineHeight,
    // settings.theme is handled by the dedicated theme effect to avoid re-creation
  ]);

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

  }, [settings.theme, connection?.theme, activeConnectionId]);

  if (!activeConnectionId) return <div className="p-8 text-gray-400">Please connect to a server first.</div>;
  if (!isConnected)
    return (
      <div className="p-8 text-gray-400 flex items-center gap-2">
        <div className="animate-spin rounded-full h-4 w-4 border-2 border-app-accent border-t-transparent"></div>{' '}
        Connecting to terminal...
      </div>
    );

  return (
    <div
      className="h-full w-full bg-app-bg p-2 relative group"
      ref={containerRef}
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
