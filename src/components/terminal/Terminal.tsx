import { useCallback, useEffect, useRef, useState, memo } from 'react';
import { Terminal as XTerm } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { SearchAddon } from '@xterm/addon-search';
import '@xterm/xterm/css/xterm.css';
import { useAppStore, Connection } from '../../store/useAppStore';
import { LOCAL_TERMINAL_CONNECTION_ID } from '../../lib/terminal/connectionIds.js';
import { useTerminalTheme } from './useTerminalTheme';
import { useTerminalLifecycle } from './useTerminalLifecycle';
import { useTerminalSearch } from './useTerminalSearch';
import { useTerminalGhost } from './useTerminalGhost';
import { useTerminalKeybindings } from './useTerminalKeybindings';
import { useTerminalGlobalShortcuts } from './useTerminalGlobalShortcuts';
import { TerminalDisconnectedView } from './TerminalDisconnectedView';
import { TerminalHost } from './TerminalHost';

interface TerminalComponentProps {
  connectionId?: string;
  termId?: string;
  isVisible?: boolean;
  isWorkspaceActive?: boolean;
  isTerminalView?: boolean;
  isActiveTab?: boolean;
}

function terminalPropsEqual(prev: TerminalComponentProps, next: TerminalComponentProps): boolean {
  return prev.connectionId === next.connectionId
    && prev.termId === next.termId
    && prev.isVisible === next.isVisible
    && prev.isWorkspaceActive === next.isWorkspaceActive
    && prev.isTerminalView === next.isTerminalView
    && prev.isActiveTab === next.isActiveTab;
}

export const TerminalComponent = memo(function TerminalComponent({
  connectionId,
  termId,
  isVisible = true,
  isWorkspaceActive = true,
  isTerminalView = true,
  isActiveTab = true,
}: TerminalComponentProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<XTerm | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const searchAddonRef = useRef<SearchAddon | null>(null);
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number } | null>(null);

  const globalActiveId = useAppStore((state) => state.activeConnectionId);
  const connections = useAppStore((state) => state.connections);
  const connect = useAppStore((state) => state.connect);
  const settings = useAppStore((state) => state.settings);
  const updateSettings = useAppStore((state) => state.updateSettings);
  const ghostSettings = settings.ghostSuggestions;
  const terminalSettingsRef = useRef(settings.terminal);

  useEffect(() => {
    terminalSettingsRef.current = settings.terminal;
  }, [settings.terminal]);

  const updateTerminalSettings = useCallback((newSettings: Partial<typeof settings.terminal>) => {
    updateSettings({ terminal: { ...terminalSettingsRef.current, ...newSettings } });
  }, [updateSettings]);

  const activeConnectionId = connectionId || globalActiveId;
  const terminalKey = activeConnectionId || LOCAL_TERMINAL_CONNECTION_ID;
  const ghostScope = connectionId || terminalKey;

  const isLocal = terminalKey === LOCAL_TERMINAL_CONNECTION_ID;
  const connection = !isLocal ? connections.find((c: Connection) => c.id === terminalKey) : null;
  const isConnected = isLocal || connection?.status === 'connected';

  const isPendingRestore = useAppStore((state) =>
    !isLocal && !!state.terminals[terminalKey]?.find((t) => t.id === (termId || terminalKey))?.pendingRestore,
  );

  const sessionId = termId || terminalKey;
  const spawnConnectionId = terminalKey;
  const remoteReady = isLocal || isConnected;

  const {
    isSearchOpen,
    isSearchOpenRef,
    searchText,
    searchInputRef,
    handleNext,
    handlePrev,
    handleClose,
    openSearch,
    resetSearch,
    handleSearchTextChange,
  } = useTerminalSearch({ searchAddonRef, termRef });

  const isVisibleRef = useRef(isVisible);
  const isConnectedRef = useRef(isConnected);

  useEffect(() => {
    isVisibleRef.current = isVisible;
  }, [isVisible]);

  useEffect(() => {
    isConnectedRef.current = isConnected;
  }, [isConnected]);

  const {
    ghostSuggestion,
    ghostPopup,
    acceptGhostSuffix,
    truncateLabel,
    resetGhostUi,
    initGhostTracker,
    onBindMount,
  } = useTerminalGhost({
    sessionId,
    terminalKey,
    spawnConnectionId,
    ghostScope,
    ghostSettings,
    isVisibleRef,
    isConnectedRef,
  });

  const { attachKeybindings } = useTerminalKeybindings({
    fontSize: settings.terminal.fontSize,
    updateTerminalSettings,
    isSearchOpenRef,
    closeSearch: handleClose,
  });

  useEffect(() => {
    resetSearch();
    resetGhostUi();
    setContextMenu(null);
  }, [sessionId, resetSearch, resetGhostUi]);

  const { terminalTransparency, terminalHostStyle, resolveInitialTheme } = useTerminalTheme({
    containerRef,
    termRef,
    settings,
    connection,
    sessionId,
    isConnected,
  });

  const onCreateTerminal = useCallback((term: XTerm) => {
    attachKeybindings(term);
    initGhostTracker(sessionId);
  }, [attachKeybindings, initGhostTracker, sessionId]);

  const { layoutTransitioning } = useTerminalLifecycle({
    containerRef,
    termRef,
    fitAddonRef,
    searchAddonRef,
    activeConnectionId,
    sessionId,
    terminalKey,
    spawnConnectionId,
    isConnected,
    isVisible,
    isWorkspaceActive,
    isTerminalView,
    isActiveTab,
    remoteReady,
    terminalSettings: settings.terminal,
    resolveInitialTheme,
    onCreateTerminal,
    onBindMount,
  });

  useTerminalGlobalShortcuts({
    isVisible,
    termRef,
    onOpenSearch: openSearch,
  });

  if (!isLocal && !activeConnectionId) {
    return <div className="p-8 text-gray-400">Please connect to a server first.</div>;
  }

  if (!isConnected) {
    return (
      <TerminalDisconnectedView
        connection={connection}
        isPendingRestore={isPendingRestore}
        activeConnectionId={terminalKey}
        onReconnect={() => connect(terminalKey)}
      />
    );
  }

  return (
    <TerminalHost
      containerRef={containerRef}
      termRef={termRef}
      sessionId={sessionId}
      terminalPadding={settings.terminal.padding ?? 12}
      terminalTransparencyEnabled={terminalTransparency.enabled}
      terminalHostStyle={terminalHostStyle}
      layoutTransitioning={layoutTransitioning}
      isSearchOpen={isSearchOpen}
      searchText={searchText}
      searchInputRef={searchInputRef}
      onSearchTextChange={handleSearchTextChange}
      onSearchNext={handleNext}
      onSearchPrev={handlePrev}
      onSearchClose={handleClose}
      contextMenu={contextMenu}
      onOpenContextMenu={setContextMenu}
      onCloseContextMenu={() => setContextMenu(null)}
      ghostSettings={ghostSettings}
      ghostSuggestion={ghostSuggestion}
      ghostPopup={ghostPopup}
      truncateLabel={truncateLabel}
      onAcceptGhostSuffix={acceptGhostSuffix}
    />
  );
}, terminalPropsEqual);