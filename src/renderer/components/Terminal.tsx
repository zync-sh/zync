import { useEffect, useRef } from 'react';
import { Terminal as XTerm } from 'xterm';
import { FitAddon } from 'xterm-addon-fit';
import { SearchAddon } from 'xterm-addon-search';
import { WebLinksAddon } from 'xterm-addon-web-links';
import 'xterm/css/xterm.css';
import { useConnections } from '../context/ConnectionContext';
import { useSettings } from '../context/SettingsContext';

export function TerminalComponent({ connectionId, termId }: { connectionId?: string; termId?: string }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<XTerm | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const searchAddonRef = useRef<SearchAddon | null>(null);

  const { activeConnectionId: globalId, connections } = useConnections();
  const { settings } = useSettings();
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
        selectionBackground: appAccent ? `${appAccent}33` : 'rgba(99, 102, 241, 0.3)', // minimal opacity hex if possible, else fallback
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

    // Load Renderer
    // defaulting to DOM renderer for maximum compatibility due to driver issues
    // (WebGL and Canvas caused blank screens)

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

    // Define the listener function separately so we can remove it later
    const handleTerminalData = (_: any, { termId: incomingTermId, data }: { termId: string; data: string }) => {
      if (incomingTermId === sessionId) {
        term.write(data);
      }
    };

    // Add listener
    window.ipcRenderer.on('terminal:data', handleTerminalData);

    // Resize Observer for container
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
      // Remove listener properly
      window.ipcRenderer.off('terminal:data', handleTerminalData);

      resizeObserver.disconnect();

      // Dispose everything
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
    settings.theme,
  ]); // Re-run if connected status changes or theme changes

  if (!activeConnectionId) return <div className="p-8 text-gray-400">Please connect to a server first.</div>;
  if (!isConnected)
    return (
      <div className="p-8 text-gray-400 flex items-center gap-2">
        <div className="animate-spin rounded-full h-4 w-4 border-2 border-app-accent border-t-transparent"></div>{' '}
        Connecting to terminal...
      </div>
    );

  return <div className="h-full w-full bg-app-bg p-2" ref={containerRef} />;
}
