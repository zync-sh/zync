import { GlobalUtilityActions } from './GlobalUtilityActions';
import { GoogleMarkIcon } from '../icons/providerIcons';
import { Settings as SettingsIcon, Network, Gift, Home, Shield, Monitor, Link2 } from 'lucide-react';
import { OSIcon } from '../icons/OSIcon';
import { HardeningAuditIcon } from '../icons/HardeningAuditIcon';
import { ZyncMark } from '../brand/ZyncMark';
import { LOCAL_TERMINAL_CONNECTION_ID } from '../../features/connections/application/tabService';
import { useAppStore, Tab, Connection } from '../../store/useAppStore'; // Updated Import
import { cn } from '../../lib/utils';
import { WindowControls } from './WindowControls';
import { NotificationBell, useNotificationBellPlacement } from '../notifications/NotificationBell';
import { useState, useEffect, useRef, useCallback } from 'react';

import { TabAddButton } from './TabAddButton';
import { WorkspaceTabList } from './WorkspaceTabList';
import { useWorkspaceTabCloseFocus, type WorkspaceTabCloseFocusIntent } from './useWorkspaceTabCloseFocus';
import { WorkspaceTabAppearanceDialog } from './WorkspaceTabAppearanceDialog';
import { DisplayAliasDialog } from '../workspace/DisplayAliasDialog';
import { isMainTabPinned } from '../../features/workspace/domain/mainTabPresentation';
import { listenWorkspacePresentationActions } from '../../features/shortcuts/workspacePresentation';
import { Tooltip } from '../ui/Tooltip';
import { ConfirmModal } from '../ui/ConfirmModal';
import { AppAddMenu } from './appAddMenu';
import { useShowHostAddressesInLists } from '../../features/connections/presentation/useConnectionDisplayLabels';
import { useWindowDrag } from '../../hooks/useWindowDrag';
import { isEditorOverlayOpen } from '../editor/overlayState';

function getIconForTab(tab: Tab, connections: Connection[], size: 12 | 13 = 12) {
    if (tab.type === 'port-forwarding') return <Network size={size} />;
    if (tab.type === 'security-audits') return <HardeningAuditIcon size={size} />;
    if (tab.type === 'public-urls') return <Link2 size={size} />;
    if (tab.type === 'settings') return <SettingsIcon size={size} />;
    if (tab.type === 'release-notes') return <Gift size={size} className="text-[var(--color-app-accent)]" />;
    if (tab.type === 'vault') return <Shield size={size} />;
    if (tab.type === 'sync') return <GoogleMarkIcon size={size} variant="mono" />;
    // Local workspace — same Monitor mark as status bar + sidebar
    if (tab.connectionId === LOCAL_TERMINAL_CONNECTION_ID) {
        return <Monitor size={size} className="text-app-muted" />;
    }

    const conn = connections.find((c: Connection) => c.id === tab.connectionId);
    const iconClassName = size === 13 ? "w-[13px] h-[13px]" : "w-[12px] h-[12px]";
    return <OSIcon icon={conn?.icon || 'Server'} className={iconClassName} />;
}

function isConnectedHostTab(tab: Tab, connections: Connection[]): boolean {
    if (tab.type !== 'connection' || !tab.connectionId || tab.connectionId === LOCAL_TERMINAL_CONNECTION_ID) {
        return false;
    }
    return connections.some((connection) => connection.id === tab.connectionId && connection.status === 'connected');
}

export function TabBar() {
    // Zustand Integrations
    const tabs = useAppStore(state => state.tabs);
    const activeTabId = useAppStore(state => state.activeTabId);
    const activateTab = useAppStore(state => state.activateTab);
    const handleActivateTab = useCallback((tabId: string) => {
        activateTab(tabId);
    }, [activateTab]);
    const closeTab = useAppStore(state => state.closeTab);
    const disconnect = useAppStore(state => state.disconnect);
    const connections = useAppStore(state => state.connections);
    const reorderWorkspaceTab = useAppStore(state => state.reorderWorkspaceTab);
    const setTabDisplayAlias = useAppStore(state => state.setTabDisplayAlias);
    const setTabPinned = useAppStore(state => state.setTabPinned);
    const updateTabPresentation = useAppStore(state => state.updateTabPresentation);
    const showToast = useAppStore(state => state.showToast);
    const closeButtonMode = useAppStore(state => state.settings.mainTabCloseButton);
    const [editor, setEditor] = useState<{ id: string; kind: 'rename' | 'appearance' } | null>(null);
    const editingTab = tabs.find(tab => tab.id === editor?.id);
    useEffect(() => {
        if (editor && !editingTab) setEditor(null);
    }, [editor, editingTab]);
    const moveTab = (id: string, direction: -1 | 1) => {
        const state = useAppStore.getState();
        const index = state.tabs.findIndex(tab => tab.id === id);
        const current = state.tabs[index];
        const neighbor = index >= 0 ? state.tabs[index + direction] : undefined;
        if (current && neighbor && isMainTabPinned(current) === isMainTabPinned(neighbor)) {
            return state.reorderWorkspaceTab(id, neighbor.id);
        }
        return false;
    };

    // Settings Slice
    const goHome = useAppStore(state => state.goHome);
    const openPublicUrlsTab = useAppStore(state => state.openPublicUrlsTab);
    const openPortForwardingTab = useAppStore(state => state.openPortForwardingTab);
    const openSecurityAuditsTab = useAppStore(state => state.openSecurityAuditsTab);
    const openTab = useAppStore(state => state.openTab);
    const setAddConnectionModalOpen = useAppStore(state => state.setAddConnectionModalOpen);
    const { showInTitleLeft, showInTitleRight } = useNotificationBellPlacement();
    const showHostAddressesInLists = useShowHostAddressesInLists();
    const tabsViewportRef = useRef<HTMLDivElement | null>(null);
    useEffect(() => listenWorkspacePresentationActions(useAppStore.getState,
        target => target.action === 'customize-tab',
        target => {
            if (editor?.id === target.tabId && editor.kind === 'appearance') return;
            // A palette input may be exiting; give the dialog a persistent exact-tab opener.
            [...(tabsViewportRef.current?.querySelectorAll<HTMLElement>('[data-workspace-tab]') ?? [])]
                .find(node => node.dataset.workspaceTab === target.tabId)?.focus();
            setEditor({ id: target.tabId, kind: 'appearance' });
        }), [editor]);
    const [tabOverflow, setTabOverflow] = useState({ left: false, right: false });
    const updateTabOverflow = useCallback(() => {
        const viewport = tabsViewportRef.current;
        if (!viewport) return;
        setTabOverflow({
            left: viewport.scrollLeft > 1,
            right: viewport.scrollLeft + viewport.clientWidth < viewport.scrollWidth - 1,
        });
    }, []);
    const handleTabsWheel = useCallback((event: React.WheelEvent<HTMLDivElement>) => {
        if (Math.abs(event.deltaY) <= Math.abs(event.deltaX)) return;
        const viewport = tabsViewportRef.current;
        if (!viewport || viewport.scrollWidth <= viewport.clientWidth) return;
        viewport.scrollLeft += event.deltaY;
        event.preventDefault();
        window.requestAnimationFrame(updateTabOverflow);
    }, [updateTabOverflow]);

    useEffect(() => {
        const viewport = tabsViewportRef.current;
        if (!viewport) return;
        updateTabOverflow();
        const observer = new ResizeObserver(updateTabOverflow);
        observer.observe(viewport);
        return () => observer.disconnect();
    }, [tabs, updateTabOverflow]);

    const [tabToClose, setTabToClose] = useState<string | null>(null);

    // Add menu state
    const [isAddMenuOpen, setIsAddMenuOpen] = useState(false);
    const addMenuRef = useRef<HTMLDivElement>(null);
    const addButtonRef = useRef<HTMLButtonElement>(null);
    const closeFocusIntentRef = useRef<WorkspaceTabCloseFocusIntent | null>(null);
    const { captureCloseFocus, restoreCloseFocus } = useWorkspaceTabCloseFocus(tabs, tabsViewportRef, addButtonRef, tabToClose !== null);
    // Click outside to close the Add menu
    useEffect(() => {
        if (!isAddMenuOpen) return;

        const handleClickOutside = (event: MouseEvent) => {
            if (addMenuRef.current && !addMenuRef.current.contains(event.target as Node)) {
                setIsAddMenuOpen(false);
            }
        };
        document.addEventListener('mousedown', handleClickOutside);
        return () => document.removeEventListener('mousedown', handleClickOutside);
    }, [isAddMenuOpen]);

    // Window drag hook for Linux compatibility
    const dragRegionRef = useRef<HTMLDivElement>(null);
    useWindowDrag(dragRegionRef, true);

    const handleCloseTab = (id: string, e?: React.MouseEvent) => {
        e?.stopPropagation();

        // Use fresh state
        const state = useAppStore.getState();
        const tab = state.tabs.find((t: Tab) => t.id === id);
        if (!tab) return;
        const focusIntent = captureCloseFocus(id);

        // Check if it's an active host connection (not Settings, Port Forwarding, or Local)
        if (tab.type === 'connection' && tab.connectionId && tab.connectionId !== 'local') {
            const conn = state.connections.find((c: Connection) => c.id === tab.connectionId);
            if (conn && conn.status === 'connected') {
                closeFocusIntentRef.current = focusIntent;
                setTabToClose(id);
                return;
            }
        }

        // Otherwise close immediately using store action
        state.closeTab(id);
        if (!useAppStore.getState().tabs.some(tab => tab.id === id)) restoreCloseFocus(focusIntent);
    };

    const handleDisconnectTab = (connectionId: string, e?: React.MouseEvent) => {
        e?.stopPropagation();
        void disconnect(connectionId);
    };

    const confirmClose = () => {
        if (tabToClose) {
            closeTab(tabToClose);
            if (!useAppStore.getState().tabs.some(tab => tab.id === tabToClose)) restoreCloseFocus(closeFocusIntentRef.current);
            closeFocusIntentRef.current = null;
            setTabToClose(null);
        }
    };

    useEffect(() => {
        const onCloseActiveTab = () => {
            if (isEditorOverlayOpen()) {
                return;
            }
            const activeId = useAppStore.getState().activeTabId;
            if (activeId) {
                handleCloseTab(activeId);
            }
        };
        window.addEventListener('zync:close-active-tab', onCloseActiveTab);
        return () => window.removeEventListener('zync:close-active-tab', onCloseActiveTab);
    }, []);



    const platform = window.electronUtils?.platform || 'linux';
    const isMac = platform === 'darwin';
    return (
        <>
            <div ref={dragRegionRef} data-zync-color="mainTabs" className={cn(
                "relative z-[60] flex h-10 bg-app-bg items-center pr-1 gap-1 app-drag-region shrink-0 select-none border-b border-app-border/40",
                isMac ? "pl-2" : "pl-1"
            )} data-tauri-drag-region>

                {/* macOS Controls on Left (Always at far edge) */}
                {isMac && (
                    <div className="shrink-0 flex items-center pr-2 pl-1">
                        <WindowControls />
                    </div>
                )}

                {/* Brand & Add (Now back on left) */}
                <div className="flex items-center gap-1.5 shrink-0 drag-none px-1">
                    {/* Zync mark → Home on hover (single control) */}
                    <Tooltip content="Welcome Screen" position="bottom">
                        <button
                            type="button"
                            onClick={goHome}
                            aria-label="Go to welcome screen"
                            className="group relative h-7 w-7 shrink-0 rounded-md flex items-center justify-center text-app-muted hover:text-app-text hover:bg-app-surface border border-transparent hover:border-app-border/40 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-app-accent/60"
                        >
                            <span className="absolute inset-0 flex items-center justify-center opacity-90 transition-opacity duration-150 group-hover:opacity-0 group-focus-visible:opacity-0">
                                <ZyncMark size={20} variant="theme" frame="bare" />
                            </span>
                            <span className="absolute inset-0 flex items-center justify-center opacity-0 transition-opacity duration-150 group-hover:opacity-100 group-focus-visible:opacity-100">
                                <Home size={14} />
                            </span>
                        </button>
                    </Tooltip>

                    {showInTitleLeft && <NotificationBell tooltipPosition="bottom" size="title" />}

                    {/* Add New Button */}
                    <div className="relative shrink-0" ref={addMenuRef}>
                        <TabAddButton
                            ref={addButtonRef}
                            label="Create or go"
                            open={isAddMenuOpen}
                            onClick={() => setIsAddMenuOpen(!isAddMenuOpen)}
                        />

                        {isAddMenuOpen && (
                            <AppAddMenu
                                showHostAddressesInLists={showHostAddressesInLists}
                                hosts={connections.map((connection) => ({
                                    id: connection.id,
                                    name: connection.name,
                                    host: connection.host,
                                    port: connection.port,
                                    username: connection.username,
                                    folder: connection.folder,
                                    isFavorite: connection.isFavorite,
                                    icon: connection.icon,
                                }))}
                                open={{
                                    portForwardingOpen: tabs.some((tab) => tab.type === 'port-forwarding'),
                                    publicUrlsOpen: tabs.some((tab) => tab.type === 'public-urls'),
                                    securityAuditsOpen: tabs.some((tab) => tab.type === 'security-audits'),
                                    localOpen: tabs.some((tab) => tab.connectionId === LOCAL_TERMINAL_CONNECTION_ID),
                                    openHostIds: new Set(
                                        tabs
                                            .filter((tab) => tab.type === 'connection' && tab.connectionId && tab.connectionId !== LOCAL_TERMINAL_CONNECTION_ID)
                                            .map((tab) => tab.connectionId as string),
                                    ),
                                }}
                                onClose={(source) => {
                                    setIsAddMenuOpen(false);
                                    if (source === 'keyboard') addButtonRef.current?.focus();
                                }}
                                onNewHost={() => setAddConnectionModalOpen(true)}
                                onNewFolder={() => window.dispatchEvent(new Event('ssh-ui:open-folder-modal'))}
                                onNewTunnel={() => window.dispatchEvent(new Event('ssh-ui:open-new-tunnel'))}
                                onOpenPortForwarding={() => openPortForwardingTab()}
                                onOpenPublicUrls={() => openPublicUrlsTab()}
                                onOpenSecurityAudits={() => openSecurityAuditsTab()}
                                onOpenLocal={() => openTab('local')}
                                onOpenHost={(hostId) => openTab(hostId)}
                            />
                        )}
                    </div>
                </div>

                <>
                    <WorkspaceTabList
                        ref={tabsViewportRef}
                        tabs={tabs}
                        activeTabId={activeTabId}
                        onReorder={reorderWorkspaceTab}
                        canDrag={() => {
                            const state = useAppStore.getState();
                            return state.sessionLoaded && !state.isRestoring && !state.sessionPersistenceBlocked;
                        }}
                        onActivate={handleActivateTab}
                        onClose={handleCloseTab}
                        onDisconnect={handleDisconnectTab}
                        onRename={id => setEditor({ id, kind: 'rename' })}
                        onAppearance={id => setEditor({ id, kind: 'appearance' })}
                        onSetPinned={setTabPinned}
                        onMove={moveTab}
                        onActionError={() => showToast('error', 'This tab could not be updated. Please try again.')}
                        closeButtonMode={closeButtonMode}
                        canDisconnect={tab => isConnectedHostTab(tab, connections)}
                        renderIcon={tab => getIconForTab(tab, connections, 12)}
                        className={cn(
                            "workspace-tabs-scroll flex h-full min-w-0 flex-1 items-center gap-1.5 overflow-x-auto px-1",
                            tabOverflow.left && tabOverflow.right && "workspace-tabs-fade-both",
                            tabOverflow.left && !tabOverflow.right && "workspace-tabs-fade-left",
                            !tabOverflow.left && tabOverflow.right && "workspace-tabs-fade-right",
                        )}
                        onWheel={handleTabsWheel}
                        onScroll={updateTabOverflow}
                        onDoubleClick={() => {
                            window.ipcRenderer?.send('window:maximize');
                        }}
                        data-tauri-drag-region
                    />

                    <div className="flex items-center gap-1 shrink-0 drag-none px-1">
                        {/* Header Actions (sidebar + AI toggles live in the bottom status bar) */}
                        <div className="flex items-center gap-1">
                            {showInTitleRight && <NotificationBell tooltipPosition="bottom" size="title" />}
                            <GlobalUtilityActions location="topbar" />

                            {/* Windows/Linux Controls inline with app actions */}
                            {!isMac && (
                                <div className="shrink-0 self-stretch flex flex-col justify-center">
                                    <WindowControls className="px-0" />
                                </div>
                            )}
                        </div>
                    </div>
                </>

            </div>

            {editingTab && editor?.kind === 'rename' && <DisplayAliasDialog
                key={editingTab.id} isOpen title="Rename tab" defaultTitle={editingTab.title} displayAlias={editingTab.displayAlias}
                onSave={alias => {
                    if (!setTabDisplayAlias(editingTab.id, alias)) throw new Error('This tab could not be updated. Please try again.');
                }} onClose={() => setEditor(null)} />}
            {editingTab && editor?.kind === 'appearance' && <WorkspaceTabAppearanceDialog
                key={editingTab.id} tab={editingTab} onClose={() => setEditor(null)}
                onChange={action => updateTabPresentation(editingTab.id, action)} />}
            <ConfirmModal
                isOpen={!!tabToClose}
                onClose={() => { closeFocusIntentRef.current = null; setTabToClose(null); }}
                onConfirm={confirmClose}
                title="Disconnect & Close?"
                message="This will disconnect the active SSH session."
                confirmLabel="Disconnect"
                variant="danger"
            />
        </>
    );
}
