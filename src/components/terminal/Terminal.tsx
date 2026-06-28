import { useCallback, useEffect, useRef, useState, memo } from 'react';
import { Terminal as XTerm } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { SearchAddon } from '@xterm/addon-search';
import '@xterm/xterm/css/xterm.css';
import { useAppStore, Connection } from '../../store/useAppStore';
import { cn } from '../../lib/utils';
import { GhostSuggestionOverlay } from './GhostSuggestionOverlay';
import { GhostSuggestionListOverlay } from './GhostSuggestionListOverlay';
import { useTerminalTheme } from './useTerminalTheme';
import { useTerminalLifecycle } from './useTerminalLifecycle';
import { useTerminalSearch } from './useTerminalSearch';
import { useTerminalGhost } from './useTerminalGhost';
import { useTerminalKeybindings } from './useTerminalKeybindings';
import { useTerminalGlobalShortcuts } from './useTerminalGlobalShortcuts';
import { TerminalSearchBar } from './TerminalSearchBar';
import { TerminalDisconnectedView } from './TerminalDisconnectedView';
import { TerminalContextMenu } from './TerminalContextMenu';

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
  const terminalKey = activeConnectionId || 'local';
  const ghostScope = connectionId || terminalKey;

  const isLocal = terminalKey === 'local';
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
    activeConnectionId,
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

  if (!activeConnectionId) {
    return <div className="p-8 text-gray-400">Please connect to a server first.</div>;
  }

  if (!isConnected) {
    return (
      <TerminalDisconnectedView
        connection={connection}
        isPendingRestore={isPendingRestore}
        activeConnectionId={activeConnectionId}
        onReconnect={() => connect(activeConnectionId)}
      />
    );
  }

  return (
    <div
      key="connected"
      className={cn('h-full w-full relative group outline-none', terminalTransparency.enabled ? 'terminal-transparent' : 'bg-app-bg')}
      style={terminalHostStyle}
      tabIndex={-1}
      onClick={() => termRef.current?.focus()}
      onContextMenu={(e) => {
        e.preventDefault();
        setContextMenu({ x: e.clientX, y: e.clientY });
      }}
    >
      <TerminalSearchBar
        isOpen={isSearchOpen}
        searchText={searchText}
        inputRef={searchInputRef}
        onSearchTextChange={handleSearchTextChange}
        onNext={handleNext}
        onPrev={handlePrev}
        onClose={handleClose}
      />

      {contextMenu && (
        <TerminalContextMenu
          position={contextMenu}
          sessionId={sessionId}
          ghostSettings={ghostSettings}
          ghostPopup={ghostPopup}
          ghostSuggestion={ghostSuggestion}
          termRef={termRef}
          truncateLabel={truncateLabel}
          onAcceptGhostSuffix={acceptGhostSuffix}
          onClose={() => setContextMenu(null)}
        />
      )}

      <div
        className={cn(
          'absolute inset-0 pointer-events-none',
          layoutTransitioning && 'overflow-hidden',
        )}
        style={{
          padding: `${Math.max(0, settings.terminal.padding ?? 12)}px`,
        }}
      >
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
}, terminalPropsEqual);