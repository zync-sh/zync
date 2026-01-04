import { useEffect, useRef, useState } from 'react';
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

  // Add local state to track verified connection status
  const [backendConnected, setBackendConnected] = useState<boolean | null>(null);
  const [spawnError, setSpawnError] = useState<string | null>(null);

  // Verify connection with backend when component mounts or connection changes
  useEffect(() => {
    if (!activeConnectionId || isLocal) {
      setBackendConnected(true);
      return;
    }

    let retries = 0;
    const maxRetries = 10; // Try for up to 5 seconds
    let timeoutId: NodeJS.Timeout;

    const checkStatus = async () => {
      try {
        const isAlive = await window.ipcRenderer.invoke('ssh:status', activeConnectionId);
        if (isAlive) {
          setBackendConnected(true);
        } else if (retries < maxRetries) {
          // Connection might still be establishing, retry after delay
          retries++;
          timeoutId = setTimeout(checkStatus, 500);
        } else {
          setBackendConnected(false);
        }
      } catch {
        setBackendConnected(false);
      }
    };

    checkStatus();
    return () => clearTimeout(timeoutId);
  }, [activeConnectionId, isLocal]);

  // Also listen to frontend connection state changes
  useEffect(() => {
    if (connection?.status === 'connected') {
      setBackendConnected(true);
    } else if (connection?.status === 'disconnected' || connection?.status === 'error') {
      setBackendConnected(false);
    }
  }, [connection?.status]);

  // Use backend status if available, otherwise fall back to frontend state
  const isConnected = isLocal || (backendConnected !== null ? backendConnected : connection?.status === 'connected');

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
    const term = new XTerm({
      cursorBlink: true,
      fontSize: settings.terminal.fontSize,
      fontFamily: settings.terminal.fontFamily,
      cursorStyle: settings.terminal.cursorStyle,
      lineHeight: settings.terminal.lineHeight,
      allowProposedApi: true,
      theme: {
        background: '#0f111a', // --color-app-bg
        foreground: '#e2e8f0', // --color-app-text
        cursor: '#6366f1', // --color-app-accent
        selectionBackground: 'rgba(99, 102, 241, 0.3)',
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
    console.log(`[Terminal] Spawning shell for ${sessionId} (rows=${term.rows}, cols=${term.cols})`);
    window.ipcRenderer
      .invoke('terminal:spawn', {
        connectionId: activeConnectionId,
        termId: sessionId,
        rows: term.rows,
        cols: term.cols,
      })
      .then((res: any) => {
          console.log(`[Terminal] Spawn result:`, res);
          if (!res.success) {
              const msg = res.error || 'Unknown failure spawning terminal';
              console.error('Failed to spawn terminal:', msg);
              setSpawnError(msg);
              term.write(`\r\n\x1b[31mFailed to start terminal session: ${msg}\x1b[0m\r\n`);
          }
      })
      .catch((err: any) => {
        console.error('Failed to spawn terminal IPC:', err);
        setSpawnError(err.message);
        term.write(`\r\n\x1b[31mFailed to start terminal session: ${err.message}\x1b[0m\r\n`);
      });

    // Handle data
    term.onData((data) => {
      window.ipcRenderer.send('terminal:write', { termId: sessionId, data });
    });

    // Listeners
    const handleTerminalData = (_: any, { termId: incomingTermId, data }: { termId: string; data: string }) => {
      if (incomingTermId === sessionId) {
        term.write(data);
      }
    };
    
    const handleTerminalClosed = (_: any, { termId: incomingTermId }: { termId: string }) => {
        if (incomingTermId === sessionId) {
            console.log(`[Terminal] Session closed: ${sessionId}`);
            term.write('\r\n\x1b[33m--- Session Ended ---\x1b[0m\r\n');
        }
    };

    // Add listener
    window.ipcRenderer.on('terminal:data', handleTerminalData);
    window.ipcRenderer.on('terminal:closed', handleTerminalClosed);

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
      window.ipcRenderer.off('terminal:closed', handleTerminalClosed);

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
  ]); // Re-run if connected status changes

  if (!activeConnectionId) return <div className="p-8 text-gray-400">Please connect to a server first.</div>;
  if (!isConnected)
    return (
      <div className="p-8 text-gray-400 flex flex-col items-center gap-2">
        <div className="flex items-center gap-2">
            <div className="animate-spin rounded-full h-4 w-4 border-2 border-app-accent border-t-transparent"></div>{' '}
            Connecting to terminal...
        </div>
        <div className="text-xs text-gray-600 font-mono mt-4">
            DEBUG: ID={activeConnectionId}<br/>
            LocalState={backendConnected === null ? 'null' : backendConnected.toString()}<br/>
            GlobalState={connection?.status || 'undefined'}
        </div>
      </div>
    );
  
  if (spawnError) {
      return (
          <div className="h-full w-full bg-app-bg p-8 flex flex-col items-center justify-center text-red-400">
              <h3 className="text-xl font-bold mb-2">Terminal Connection Failed</h3>
              <p>{spawnError}</p>
          </div>
      );
  }

  return <div className="h-full w-full bg-app-bg p-2" ref={containerRef} />;
}
