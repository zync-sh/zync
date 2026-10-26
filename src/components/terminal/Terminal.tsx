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
import type { TerminalMenuPosition } from '../../lib/terminal/terminalMouseBinding';

interface TerminalComponentProps {
  connectionId?: string;
  termId?: string;
  isVisible?: boolean;
  isWorkspaceActive?: boolean;
  isTerminalView?: boolean;
  isActiveTab?: boolean;
  /** Keyboard owner among visible split panes. Defaults to isActiveTab. */
  isFocused?: boolean;
}

function terminalPropsEqual(prev: TerminalComponentProps, next: TerminalComponentProps): boolean {
  return prev.connectionId === next.connectionId
    && prev.termId === next.termId
    && prev.isVisible === next.isVisible
    && prev.isWorkspaceActive === next.isWorkspaceActive
    && prev.isTerminalView === next.isTerminalView
    && prev.isActiveTab === next.isActiveTab
    && prev.isFocused === next.isFocused;
}

export const TerminalComponent = memo(function TerminalComponent({
  connectionId,
  termId,
  isVisible = true,
  isWorkspaceActive = true,
  isTerminalView = true,
  isActiveTab = true,
  isFocused,
}: TerminalComponentProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<XTerm | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const searchAddonRef = useRef<SearchAddon | null>(null);
  const [contextMenu, setContextMenu] = useState<TerminalMenuPosition | null>(null);

  const globalActiveId = useAppStore((state) => state.activeConnectionId);
  const connections = useAppStore((state) => state.connections);
  const connect = useAppStore((state) => state.connect);
  const openConnectionModal = useAppStore((state) => state.openConnectionModal);
  const openVaultTab = useAppStore((state) => state.openVaultTab);
  const setTabView = useAppStore((state) => state.setTabView);
  const activeTabId = useAppStore((state) => state.activeTabId);
  const settings = useAppStore((state) => state.settings);
  const ghostSettings = settings.ghostSuggestions;

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
    ghostLayout,
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
    isVisible,
    isVisibleRef,
    isConnectedRef,
  });

  const { attachKeybindings } = useTerminalKeybindings({
    isSearchOpenRef,
    closeSearch: handleClose,
    sessionId,
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
    isFocused,
    remoteReady,
    terminalSettings: settings.terminal,
    resolveInitialTheme,
    onCreateTerminal,
    onBindMount,
  });

  const { copied } = useTerminalGlobalShortcuts({
    isVisible: isVisible && isWorkspaceActive && isTerminalView && isConnected,
    isKeyboardOwner: isFocused ?? isActiveTab,
    sessionId,
    termRef,
    onOpenSearch: openSearch,
    mousePreferences: settings.terminal,
    onOpenContextMenu: setContextMenu,
  });

  useEffect(() => {
    if (isFocused !== true || isSearchOpen) return;
    if (!isVisible || !isWorkspaceActive || !isTerminalView) return;
    termRef.current?.focus();
  }, [isFocused, isSearchOpen, sessionId, isVisible, isWorkspaceActive, isTerminalView]);

  if (!isLocal && !activeConnectionId) {
    return <div className="p-8 text-gray-400">Please connect to a server first.</div>;
  }

  if (!isConnected) {
    // TerminalManager sets isVisible = workspaceActive && terminalView.
    const isSurfaceActive = isVisible && isWorkspaceActive && isTerminalView && (isFocused ?? isActiveTab);
    return (
      <TerminalDisconnectedView
        connection={connection}
        isPendingRestore={isPendingRestore}
        activeConnectionId={terminalKey}
        isSurfaceActive={isSurfaceActive}
        onReconnect={() => connect(terminalKey)}
        onEditHost={
          connection
            ? () => openConnectionModal(connection.id)
            : undefined
        }
        onOpenFiles={
          connection && activeTabId
            ? () => {
                // Land on Files and start SSH so SFTP can attach when live.
                setTabView(activeTabId, 'files');
                void connect(terminalKey);
              }
            : undefined
        }
        onOpenVault={
          connection
            ? () => openVaultTab('local')
            : undefined
        }
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
      copied={copied}
      onCloseContextMenu={() => setContextMenu(null)}
      connectionId={terminalKey}
      ghostSettings={ghostSettings}
      ghostSuggestion={ghostSuggestion}
      ghostLayout={ghostLayout}
      truncateLabel={truncateLabel}
      onAcceptGhostSuffix={acceptGhostSuffix}
    />
  );
}, terminalPropsEqual);
