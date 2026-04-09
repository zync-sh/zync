import { useState, useCallback, useEffect, useRef, useMemo, lazy, Suspense } from 'react';
import { useAppStore, Connection, Folder } from '../../store/useAppStore';
import { Code, Files, Info, LayoutDashboard, Network, Pencil, Power, Search, TerminalIcon, Trash2 } from 'lucide-react';
import { cn } from '../../lib/utils';
import { ContextMenu, type ContextMenuItem } from '../ui/ContextMenu';
import { ConfirmModal } from '../ui/ConfirmModal';
import { buildTree } from './sidebar/buildTree';
import { SidebarSection } from './sidebar/SidebarSection';
import { ConnectionItem } from './sidebar/ConnectionItem';
import { FolderItem } from './sidebar/FolderItem';
import { FolderFormModal } from './sidebar/FolderFormModal';

// Lazy Load Modals
const SettingsModal = lazy(() => import('../settings/SettingsModal').then(mod => ({ default: mod.SettingsModal })));
const AddTunnelModal = lazy(() => import('../modals/AddTunnelModal').then(mod => ({ default: mod.AddTunnelModal })));
const ConnectionDetailsModal = lazy(() => import('../modals/ConnectionDetailsModal').then(mod => ({ default: mod.ConnectionDetailsModal })));
const AddConnectionModal = lazy(() => import('../modals/AddConnectionModal').then(mod => ({ default: mod.AddConnectionModal })));


export function Sidebar({ className }: { className?: string }) {
    const [viewingDetailsId, setViewingDetailsId] = useState<string | null>(null);
    const [searchTerm, setSearchTerm] = useState('');

    // Connection Store Hooks
    const connections = useAppStore(state => state.connections);
    const activeConnectionId = useAppStore(state => state.activeConnectionId);
    const openTab = useAppStore(state => state.openTab);
    const openPortForwardingTab = useAppStore(state => state.openPortForwardingTab);
    const folders = useAppStore(state => state.folders);
    const addFolder = useAppStore(state => state.addFolder);
    const updateConnectionFolder = useAppStore(state => state.updateConnectionFolder);
    const deleteFolder = useAppStore(state => state.deleteFolder);
    const deleteConnection = useAppStore(state => state.deleteConnection);
    const renameFolder = useAppStore(state => state.renameFolder);
    const connect = useAppStore(state => state.connect);
    const disconnect = useAppStore(state => state.disconnect);
    
    // Settings Store Hooks
    const settings = useAppStore(state => state.settings);
    const updateSettings = useAppStore(state => state.updateSettings);
    
    // Modal open/close actions extracted from store
    const isSettingsOpen = useAppStore(state => state.isSettingsOpen);
    const closeSettings = useAppStore(state => state.closeSettings);
    const isAddConnectionModalOpen = useAppStore(state => state.isAddConnectionModalOpen);
    const openAddConnectionModal = () => useAppStore.getState().setAddConnectionModalOpen(true);
    const closeAddConnectionModal = () => useAppStore.getState().setAddConnectionModalOpen(false);

    const compactMode = settings.compactMode;
    const [isFolderModalOpen, setIsFolderModalOpen] = useState(false);

    const [isRenameFolderModalOpen, setIsRenameFolderModalOpen] = useState(false);
    const [folderToRename, setFolderToRename] = useState<string | null>(null);
    const isCollapsed = settings.sidebarCollapsed;

    const [isAddTunnelModalOpen, setIsAddTunnelModalOpen] = useState(false);
    const [deletingConnection, setDeletingConnection] = useState<Connection | null>(null);
    const [deletingFolder, setDeletingFolder] = useState<string | null>(null);
    const [connectionContextMenu, setConnectionContextMenu] = useState<{ x: number; y: number; connectionId: string } | null>(null);

    // Resize Logic
    const [width, setWidth] = useState(settings.sidebarWidth || 288);
    const [isResizing, setIsResizing] = useState(false);
    const widthRef = useRef(width);

    useEffect(() => {
        widthRef.current = width;
    }, [width]);

    const sidebarRef = useRef<HTMLDivElement>(null);

    // Sync width if settings change externally (e.g. via reset)
    useEffect(() => {
        if (settings.sidebarWidth && !isResizing) {
            setWidth(settings.sidebarWidth);
            widthRef.current = settings.sidebarWidth;
        }
    }, [settings.sidebarWidth, isResizing]);

    const startResizing = useCallback((e: React.MouseEvent) => {
        setIsResizing(true);
        e.preventDefault();
        document.body.style.cursor = 'col-resize';
        window.dispatchEvent(new CustomEvent('zync:layout-transition-start'));
    }, []);

    useEffect(() => {
        if (!isResizing) return;

        const resize = (e: MouseEvent) => {
            const newWidth = Math.max(200, Math.min(e.clientX, 600)); // Clamp between 200px and 600px
            widthRef.current = newWidth;
            setWidth(newWidth);
        };

        const stopResizing = () => {
            setIsResizing(false);
            document.body.style.cursor = '';
            // Save final width
            updateSettings({ sidebarWidth: widthRef.current });
            // Notify terminal that layout is now stable
            window.dispatchEvent(new CustomEvent('zync:layout-transition-end'));
        };

        window.addEventListener('mousemove', resize);
        window.addEventListener('mouseup', stopResizing);

        return () => {
            window.removeEventListener('mousemove', resize);
            window.removeEventListener('mouseup', stopResizing);
        };
    }, [isResizing, updateSettings]);

    // Compute Active Connections
    const activeConnections = useMemo(() => {
        const normalizedSearch = searchTerm.trim().toLowerCase();
        return connections.filter((c: Connection) => {
            if (c.status !== 'connected') return false;
            if (!normalizedSearch) return true;
            return (
                (c.name ?? '').toLowerCase().includes(normalizedSearch) ||
                (c.host ?? '').toLowerCase().includes(normalizedSearch) ||
                (c.username ?? '').toLowerCase().includes(normalizedSearch) ||
                (c.tags ?? []).some((tag) => tag.toLowerCase().includes(normalizedSearch))
            );
        });
    }, [connections, searchTerm]);

    const hostCountLabel = useMemo(() => {
        const hostCount = connections.filter((c: Connection) => c.id !== 'local').length;
        return hostCount > 99 ? '99+' : String(hostCount);
    }, [connections]);


    const [editingConnectionId, setEditingConnectionId] = useState<string | null>(null);

    // Reset editing state when modal closes
    useEffect(() => {
        if (!isAddConnectionModalOpen) {
            setEditingConnectionId(null);
        }
    }, [isAddConnectionModalOpen]);

    const openEditConnection = useCallback((conn: Connection) => {
        setEditingConnectionId(conn.id);
        openAddConnectionModal();
    }, []);

    // Listen for global events (Command Palette)
    useEffect(() => {
        const handleOpenFolder = () => setIsFolderModalOpen(true);
        const handleOpenTunnel = () => setIsAddTunnelModalOpen(true);

        window.addEventListener('ssh-ui:open-folder-modal', handleOpenFolder);
        window.addEventListener('ssh-ui:open-new-tunnel', handleOpenTunnel);

        return () => {
            window.removeEventListener('ssh-ui:open-folder-modal', handleOpenFolder);
            window.removeEventListener('ssh-ui:open-new-tunnel', handleOpenTunnel);
        };
    }, []);

    // Filter out active connections for the main tree
    const treeConnections = useMemo(() => {
        return connections.filter((c: Connection) => c.status !== 'connected');
    }, [connections]);

    // Build Recursive Tree
    const treeRoot = useMemo(() => buildTree(treeConnections, folders, searchTerm), [treeConnections, folders, searchTerm]);

    const toggleExpandedFolder = useAppStore(state => state.toggleExpandedFolder);

    const expandedFolders = useMemo(() => new Set(settings.expandedFolders), [settings.expandedFolders]);

    const toggleFolder = (folderPath: string) => {
        toggleExpandedFolder(folderPath);
    };

    const handleRenameFolder = (path: string) => {
        setFolderToRename(path);
        setIsRenameFolderModalOpen(true);
    };

    const openConnectionContextMenu = useCallback((conn: Connection, x: number, y: number) => {
        setConnectionContextMenu({ x, y, connectionId: conn.id });
    }, []);

    const contextMenuConnection = useMemo(() => {
        if (!connectionContextMenu) return null;
        return connections.find((c: Connection) => c.id === connectionContextMenu.connectionId) || null;
    }, [connectionContextMenu, connections]);

    useEffect(() => {
        if (!connectionContextMenu) return;
        if (contextMenuConnection) return;
        setConnectionContextMenu(null);
    }, [connectionContextMenu, contextMenuConnection]);

    const connectionContextMenuItems = useMemo<ContextMenuItem[]>(() => {
        if (!contextMenuConnection) return [];
        return [
            {
                label: contextMenuConnection.status === 'connected' ? 'Disconnect' : 'Connect',
                icon: <Power size={14} className={contextMenuConnection.status === 'connected' ? 'text-red-400' : 'text-emerald-400'} />,
                action: () => {
                    if (contextMenuConnection.status === 'connected') {
                        disconnect(contextMenuConnection.id);
                        return;
                    }
                    connect(contextMenuConnection.id);
                    openTab(contextMenuConnection.id);
                }
            },
            {
                label: 'Details',
                icon: <Info size={14} />,
                action: () => setViewingDetailsId(contextMenuConnection.id)
            },
            { separator: true },
            {
                label: 'File Manager',
                icon: <Files size={14} />,
                action: () => openTab(contextMenuConnection.id, 'files')
            },
            {
                label: 'Port Forwarding',
                icon: <Network size={14} />,
                action: () => openTab(contextMenuConnection.id, 'port-forwarding')
            },
            {
                label: 'Snippets',
                icon: <Code size={14} />,
                action: () => openTab(contextMenuConnection.id, 'snippets')
            },
            {
                label: 'Dashboard',
                icon: <LayoutDashboard size={14} />,
                action: () => openTab(contextMenuConnection.id, 'dashboard')
            },
            { separator: true },
            {
                label: 'Edit',
                icon: <Pencil size={14} />,
                action: () => openEditConnection(contextMenuConnection)
            },
            {
                label: 'Delete',
                icon: <Trash2 size={14} />,
                variant: 'danger',
                action: () => setDeletingConnection(contextMenuConnection)
            }
        ];
    }, [connect, contextMenuConnection, disconnect, openEditConnection, openTab]);

    const connectionItemProps = useMemo(() => ({
        onEdit: openEditConnection,
        onOpenContextMenu: openConnectionContextMenu,
    }), [openEditConnection, openConnectionContextMenu]);

    return (
        <div
            ref={sidebarRef}
            className={cn(
                "bg-app-panel flex flex-col h-full shrink-0 relative z-50 overflow-hidden",
                !isCollapsed && "border-r border-app-border/50",
                !isResizing ? "transition-[width] duration-300 ease-[cubic-bezier(0.2,0,0,1)]" : "",
                className
            )}
            style={{
                width: isCollapsed ? 0 : width,
                willChange: isResizing ? 'auto' : 'width'
            }}
        >
            {/* Resize Handle */}
            {!isCollapsed && width >= 40 && (
                <div
                    className="absolute right-0 top-0 bottom-0 w-1 hover:w-1.5 cursor-col-resize hover:bg-app-accent/50 transition-all z-[100] group"
                    onMouseDown={startResizing}
                >
                    <div className="absolute inset-y-0 right-0 w-4 -z-10" /> {/* Larger hit area */}
                </div>
            )}

            {/* Content Wrapper */}
            <div
                style={{ width: width, minWidth: width }}
                className="flex flex-col h-full pt-1.5"
            >
                <div className={cn(compactMode ? "px-3 py-2" : "px-4 py-3")}>
                    <div className="relative">
                        <input
                            type="text"
                            value={searchTerm}
                            onChange={(e) => setSearchTerm(e.target.value)}
                            aria-label="Search connections"
                            placeholder={`Connections ${hostCountLabel}`}
                            className="w-full rounded-lg border border-app-border/40 bg-app-surface/40 pl-3 pr-8 py-1.5 text-xs text-app-text placeholder:text-app-muted/70 focus:outline-none focus:border-app-accent/60"
                        />
                        <Search
                            size={13}
                            className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 text-app-muted/70"
                            aria-hidden="true"
                        />
                    </div>
                </div>



                {/* System Actions Column */}
                <div className={cn(compactMode ? "px-3 mb-2" : "px-4 mb-2")}>
                    <div className="flex flex-col gap-1.5 w-full">
                        <button
                            className={cn(
                                "group relative flex items-center transition-all cursor-pointer select-none outline-none w-full py-2 px-3 rounded-lg border border-transparent",
                                "bg-app-surface/30 hover:bg-app-surface hover:border-app-border/30 text-app-muted hover:text-app-text"
                            )}
                            onClick={() => openTab('local')}
                        >
                            <TerminalIcon size={13} className="opacity-70 group-hover:opacity-100" />
                            <span className="ml-3 font-medium text-[10px] uppercase tracking-wider opacity-80 group-hover:opacity-100">New Terminal</span>
                        </button>

                        <button
                            className={cn(
                                "group relative flex items-center transition-all cursor-pointer select-none outline-none w-full py-2 px-3 rounded-lg border border-transparent",
                                "bg-app-surface/30 hover:bg-app-surface hover:border-app-border/30 text-app-muted hover:text-app-text"
                            )}
                            onClick={() => openPortForwardingTab()}
                        >
                            <Network size={13} className="opacity-70 group-hover:opacity-100" />
                            <span className="ml-3 font-medium text-[10px] uppercase tracking-wider opacity-80 group-hover:opacity-100">Port Forwarding</span>
                        </button>
                    </div>
                </div>

                <div className="h-px bg-app-border/20 mb-2 mx-4" />

                {/* List */}
                <div className={cn(
                    "flex-1 overflow-y-auto pb-4 scrollbar-hide",
                    compactMode ? "px-2 space-y-0.5" : "px-3 space-y-2"
                )}>
                    {/* VISUAL SECTIONS LOGIC */}
                    {activeConnections.length > 0 ? (
                        <>
                            <SidebarSection title="Active" count={activeConnections.length} compactMode={compactMode}>
                                <div className={cn("space-y-1 mb-2 pl-1", compactMode && "space-y-0.5")}>
                                    {activeConnections.map((conn: Connection) => (
                                        <ConnectionItem
                                            key={`active-${conn.id}`}
                                            conn={conn}
                                            isCollapsed={false}
                                            {...connectionItemProps}
                                        />
                                    ))}
                                </div>
                            </SidebarSection>

                            <SidebarSection
                                title="All Hosts"
                                compactMode={compactMode}
                                onDrop={(e) => {
                                    e.preventDefault();
                                    e.stopPropagation();
                                    const connId = e.dataTransfer.getData('connection-id');
                                    const folderPath = e.dataTransfer.getData('folder-path');

                                    if (connId) {
                                        updateConnectionFolder(connId, '');
                                    } else if (folderPath) {
                                        // Move folder to root -> Rename to just its basename
                                        const baseName = folderPath.split('/').pop();
                                        if (baseName && baseName !== folderPath) {
                                            renameFolder(folderPath, baseName);
                                        }
                                    }
                                }}
                            >
                                <div className="pl-1">
                                    {/* Render Recursive Tree (Filtered to exclude active if not searching) */}
                                    {Object.keys(treeRoot.children).sort().map(key => (
                                        <FolderItem
                                            key={key}
                                            node={treeRoot.children[key]}
                                            isCollapsed={false}
                                            compactMode={compactMode}
                                            expandedFolders={expandedFolders}
                                            toggleFolder={toggleFolder}
                                            updateConnectionFolder={updateConnectionFolder}
                                            onDeleteFolder={(f) => setDeletingFolder(f)}
                                            onRenameFolder={handleRenameFolder}
                                            onMoveFolder={renameFolder}
                                            connectionItemProps={connectionItemProps}
                                        />
                                    ))}
                                    {treeRoot.connections.map(conn => (
                                        <ConnectionItem
                                            key={conn.id}
                                            conn={conn}
                                            isCollapsed={false}
                                            {...connectionItemProps}
                                        />
                                    ))}
                                </div>
                            </SidebarSection>
                        </>
                    ) : (
                        <div className="pl-1">
                            {Object.keys(treeRoot.children).sort().map(key => (
                                <FolderItem
                                    key={key}
                                    node={treeRoot.children[key]}
                                    isCollapsed={false}
                                    compactMode={compactMode}
                                    expandedFolders={expandedFolders}
                                    toggleFolder={toggleFolder}
                                    updateConnectionFolder={updateConnectionFolder}
                                    onDeleteFolder={(f) => setDeletingFolder(f)}
                                    onRenameFolder={handleRenameFolder}
                                    onMoveFolder={renameFolder}
                                    connectionItemProps={connectionItemProps}
                                />
                            ))}
                            {treeRoot.connections.map(conn => (
                                <ConnectionItem
                                    key={conn.id}
                                    conn={conn}
                                    isCollapsed={false}
                                    {...connectionItemProps}
                                />
                            ))}
                        </div>
                    )}
                </div>
            </div>

            {/* Modals */}
            <Suspense fallback={null}>
                {isAddConnectionModalOpen && (
                    <AddConnectionModal
                        isOpen={isAddConnectionModalOpen}
                        onClose={closeAddConnectionModal}
                        editingConnectionId={editingConnectionId}
                    />
                )}
            </Suspense>

            {/* Create Folder Modal */}
            <FolderFormModal
                isOpen={isFolderModalOpen}
                onClose={() => setIsFolderModalOpen(false)}
                onSubmit={(name, tags) => {
                    addFolder(name, tags);
                    setIsFolderModalOpen(false);
                }}
            />

            {/* Modals */}
            <Suspense fallback={null}>
                {isAddTunnelModalOpen && (
                    <AddTunnelModal
                        isOpen={isAddTunnelModalOpen}
                        onClose={() => setIsAddTunnelModalOpen(false)}
                        initialConnectionId={activeConnectionId && activeConnectionId !== 'local' && activeConnectionId !== 'port-forwarding' ? activeConnectionId : undefined}
                    />
                )}

                {viewingDetailsId && (
                    <ConnectionDetailsModal
                        isOpen={!!viewingDetailsId}
                        onClose={() => setViewingDetailsId(null)}
                        connection={connections.find((c: Connection) => c.id === viewingDetailsId) || null}
                    />
                )}

                {isSettingsOpen && <SettingsModal isOpen={isSettingsOpen} onClose={closeSettings} />}
            </Suspense>

            {connectionContextMenu && contextMenuConnection && (
                <ContextMenu
                    x={connectionContextMenu.x}
                    y={connectionContextMenu.y}
                    items={connectionContextMenuItems}
                    onClose={() => setConnectionContextMenu(null)}
                />
            )}

            <FolderFormModal
                isOpen={isRenameFolderModalOpen}
                onClose={() => setIsRenameFolderModalOpen(false)}
                initialName={folderToRename || ''}
                initialTags={folders.find((f: Folder) => f.name === folderToRename)?.tags || []}
                onSubmit={(newName, newTags) => {
                    if (folderToRename) {
                        renameFolder(folderToRename, newName, newTags);
                    }
                    setIsRenameFolderModalOpen(false);
                }}
            />

            {/* Delete Connection Confirmation */}
            <ConfirmModal
                isOpen={!!deletingConnection}
                onClose={() => setDeletingConnection(null)}
                onConfirm={() => {
                    if (deletingConnection) {
                        deleteConnection(deletingConnection.id);
                        setDeletingConnection(null);
                    }
                }}
                title="Delete Connection"
                message={
                    <span className="text-app-text/90">
                        Are you sure you want to delete connection <span className="text-app-accent font-bold">"{deletingConnection?.name || deletingConnection?.host}"</span>? This action cannot be undone.
                    </span>
                }
                confirmLabel="Delete"
                variant="danger"
            />

            {/* Delete Folder Confirmation */}
            <ConfirmModal
                isOpen={!!deletingFolder}
                onClose={() => setDeletingFolder(null)}
                onConfirm={() => {
                    if (deletingFolder) {
                        deleteFolder(deletingFolder);
                        setDeletingFolder(null);
                    }
                }}
                title="Delete Folder"
                message={
                    <span className="text-app-text/90">
                        Delete folder <span className="text-app-accent font-bold">"{deletingFolder}"</span>? Connections within this folder will be ungrouped.
                    </span>
                }
                confirmLabel="Delete"
                variant="danger"
            />
        </div>
    );
}
