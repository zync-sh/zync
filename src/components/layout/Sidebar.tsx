import { useState, useCallback, useEffect, useRef, useMemo, lazy, Suspense } from 'react';
import { useAppStore, Connection, Folder, Tab } from '../../store/useAppStore'; // Updated Import
import { getCurrentDragSource } from '../../lib/dragDrop';
import { Pencil, ChevronRight, Folder as FolderIcon, ChevronDown, FolderPlus, Settings, Network, TerminalIcon, Trash2, FolderOpen, Files, Code, LayoutDashboard, Power, Info } from 'lucide-react';
import { OSIcon } from '../icons/OSIcon';
import { cn } from '../../lib/utils';
import { Button } from '../ui/Button';
import { Modal } from '../ui/Modal';
import { Input } from '../ui/Input';
import { ContextMenu } from '../ui/ContextMenu';
import { ConfirmModal } from '../ui/ConfirmModal';

// Lazy Load Modals
const SettingsModal = lazy(() => import('../settings/SettingsModal').then(mod => ({ default: mod.SettingsModal })));
const AddTunnelModal = lazy(() => import('../modals/AddTunnelModal').then(mod => ({ default: mod.AddTunnelModal })));
const ConnectionDetailsModal = lazy(() => import('../modals/ConnectionDetailsModal').then(show => ({ default: show.ConnectionDetailsModal })));
const AddConnectionModal = lazy(() => import('../modals/AddConnectionModal').then(mod => ({ default: mod.AddConnectionModal })));

interface TreeNode {
    name: string;
    path: string;
    children: { [key: string]: TreeNode };
    connections: Connection[];
    folderTags?: string[]; // Add tags metadata
}

function SidebarSection({
    title,
    count,
    children,
    defaultExpanded = true,
    compactMode = false,
    onDrop
}: {
    title: string;
    count?: number;
    children: React.ReactNode;
    defaultExpanded?: boolean;
    compactMode?: boolean;
    onDrop?: (e: React.DragEvent) => void;
}) {
    const [isExpanded, setIsExpanded] = useState(defaultExpanded);

    return (
        <div
            className="mb-2"
            onDragOver={onDrop ? (e) => {
                e.preventDefault();
                e.stopPropagation();
            } : undefined}
            onDrop={(e) => {
                e.preventDefault();
                e.stopPropagation();
                const types = Array.from(e.dataTransfer.types || []);
                const isExternal = types.includes('Files') || types.includes('text/uri-list');
                if (isExternal) {
                    useAppStore.getState().showToast('info', 'External drop here is currently disabled. We are working to bring this feature to Zync soon!');
                    return;
                }
                onDrop?.(e);
            }}
        >
            <button
                onClick={() => setIsExpanded(!isExpanded)}
                className={cn(
                    "w-full flex items-center gap-1 group select-none mb-1",
                    compactMode ? "px-2" : "px-4"
                )}
            >
                {isExpanded ? (
                    <ChevronDown size={12} className="text-app-muted group-hover:text-app-text transition-colors" />
                ) : (
                    <ChevronRight size={12} className="text-app-muted group-hover:text-app-text transition-colors" />
                )}
                <span className="text-xs font-bold text-app-muted group-hover:text-app-text transition-colors uppercase tracking-wider">
                    {title}
                </span>
                {count !== undefined && count > 0 && (
                    <span className="ml-auto text-[10px] font-medium text-app-accent bg-app-accent/10 px-1.5 rounded-full">
                        {count}
                    </span>
                )}
            </button>

            {isExpanded && (
                <div className="animate-in fade-in slide-in-from-top-1 duration-200">
                    {children}
                </div>
            )}
        </div>
    );
}

function buildTree(conns: Connection[], allFolders: Folder[], searchTerm: string): TreeNode {
    const root: TreeNode = { name: 'root', path: '', children: {}, connections: [] };
    const folderMap = new Map(allFolders.map(f => [f.name, f]));
    const normalizedSearch = searchTerm.toLowerCase();

    // Helper to get/create node
    const getNode = (path: string) => {
        const parts = path.split('/').filter(Boolean);
        let current = root;
        let currentPath = '';
        parts.forEach((part) => {
            currentPath = currentPath ? `${currentPath}/${part}` : part;
            if (!current.children[part]) {
                const folderMeta = folderMap.get(currentPath);
                current.children[part] = {
                    name: part,
                    path: currentPath,
                    children: {},
                    connections: [],
                    folderTags: folderMeta?.tags
                };
            }
            current = current.children[part];
        });
        return current;
    };

    // 1. Ensure matching folders exist (Explicit ones)
    // If search is active, only show folders that match OR contain matching connections
    // If no search, show all explicitly created folders
    if (!searchTerm) {
        allFolders.forEach(f => getNode(f.name));
    } else {
        allFolders.filter((f: Folder) =>
            f.name.toLowerCase().includes(normalizedSearch) ||
            (f.tags && f.tags.some((t: string) => t.toLowerCase().includes(normalizedSearch)))
        ).forEach((f: Folder) => getNode(f.name));
    }

    // 2. Populate Connections
    conns.forEach((conn: Connection) => {
        // Search Filter: Check Name, Host, and Tags
        const matchesSearch = !searchTerm ||
            (conn.name || conn.host).toLowerCase().includes(normalizedSearch) ||
            (conn.tags && conn.tags.some((t: string) => t.toLowerCase().includes(normalizedSearch)));

        if (matchesSearch) {
            if (conn.folder) {
                // If the connection matches, ensure its folder exists even if the folder name doesn't match
                getNode(conn.folder).connections.push(conn);
            } else {
                root.connections.push(conn);
            }
        }
    });

    return root;
}

export function Sidebar({ className }: { className?: string }) {
    const [viewingDetailsId, setViewingDetailsId] = useState<string | null>(null);

    // Connection Store Hooks
    const connections = useAppStore(state => state.connections);
    const activeConnectionId = useAppStore(state => state.activeConnectionId);
    // const addConnection = useAppStore(state => state.addConnection); // Removed - used in modal
    // const editConnection = useAppStore(state => state.editConnection); // Removed - used in modal
    // const importConnections = useAppStore(state => state.importConnections); // Removed - used in modal
    const openTab = useAppStore(state => state.openTab);
    const openPortForwardingTab = useAppStore(state => state.openPortForwardingTab);
    const folders = useAppStore(state => state.folders);
    const addFolder = useAppStore(state => state.addFolder);
    const updateConnectionFolder = useAppStore(state => state.updateConnectionFolder);
    const deleteFolder = useAppStore(state => state.deleteFolder);
    const deleteConnection = useAppStore(state => state.deleteConnection);
    const renameFolder = useAppStore(state => state.renameFolder);
    
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
    // const [isAddModalOpen, setIsAddModalOpen] = useState(false); // Moved to context
    const [isFolderModalOpen, setIsFolderModalOpen] = useState(false); // State for Create Folder Modal

    const [isRenameFolderModalOpen, setIsRenameFolderModalOpen] = useState(false);
    const [folderToRename, setFolderToRename] = useState<string | null>(null);
    const [folderContextMenu, setFolderContextMenu] = useState<{ x: number; y: number; folderName: string } | null>(null);
    // const [isCollapsed, setIsCollapsed] = useState(false); // Moved to Settings
    const isCollapsed = settings.sidebarCollapsed;

    const [isAddTunnelModalOpen, setIsAddTunnelModalOpen] = useState(false);
    const [deletingConnection, setDeletingConnection] = useState<Connection | null>(null);
    const [deletingFolder, setDeletingFolder] = useState<string | null>(null);

    // const canAddTunnel = activeConnectionId && activeConnectionId !== 'local' && activeConnectionId !== 'port-forwarding';

    // Resize Logic

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
        return connections.filter((c: Connection) => c.status === 'connected');
    }, [connections]);

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

    const openEditConnection = (conn: Connection) => {
        setEditingConnectionId(conn.id);
        openAddConnectionModal();
    };

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
    const treeRoot = useMemo(() => buildTree(treeConnections, folders, ''), [treeConnections, folders]);

    const toggleExpandedFolder = useAppStore(state => state.toggleExpandedFolder);

    const expandedFolders = useMemo(() => new Set(settings.expandedFolders), [settings.expandedFolders]);

    const toggleFolder = (folderPath: string) => {
        toggleExpandedFolder(folderPath);
    };

    const handleRenameFolder = (path: string) => {
        setFolderToRename(path);
        setIsRenameFolderModalOpen(true);
    };

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
                {/* Minimalist Title */}
                <div
                    className={cn(
                        "flex items-center justify-between shrink-0 select-none relative z-10",
                        compactMode ? "px-3.5 py-2" : "px-4 py-3"
                    )}
                >
                    <div className="flex min-w-0 items-center gap-2.5 overflow-hidden">
                        <div className="flex min-w-0 items-center gap-1.5 whitespace-nowrap">
                            <span className="text-[11px] font-bold uppercase tracking-wider text-app-muted/80">Connections</span>
                            <span
                                className="rounded-full border border-app-border/60 bg-app-surface/40 px-1.5 py-0.5 text-[9px] font-semibold tabular-nums text-app-muted/90"
                                title="Saved hosts"
                            >
                                {hostCountLabel}
                            </span>
                        </div>
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
                                            isCollapsed={false} // Always render as if expanded inside the wrapper
                                            onEdit={openEditConnection}
                                            onDelete={(c) => setDeletingConnection(c)}
                                            onViewDetails={(c: Connection) => setViewingDetailsId(c.id)}
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
                                            connectionItemProps={{ onEdit: openEditConnection, onDelete: (c: Connection) => setDeletingConnection(c), onViewDetails: (c: Connection) => setViewingDetailsId(c.id) }}
                                        />
                                    ))}
                                    {treeRoot.connections.map(conn => (
                                        <ConnectionItem
                                            key={conn.id}
                                            conn={conn}
                                            isCollapsed={false}
                                            onEdit={openEditConnection}
                                            onDelete={(c: Connection) => setDeletingConnection(c)}
                                            onViewDetails={c => setViewingDetailsId(c.id)}
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
                                    connectionItemProps={{ onEdit: openEditConnection, onDelete: (c: Connection) => setDeletingConnection(c), onViewDetails: (c: Connection) => setViewingDetailsId(c.id) }}
                                />
                            ))}
                            {treeRoot.connections.map(conn => (
                                <ConnectionItem
                                    key={conn.id}
                                    conn={conn}
                                    isCollapsed={false}
                                    onEdit={openEditConnection}
                                    onDelete={(c: Connection) => setDeletingConnection(c)}
                                    onViewDetails={c => setViewingDetailsId(c.id)}
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
            <CreateFolderModal
                isOpen={isFolderModalOpen}
                onClose={() => setIsFolderModalOpen(false)}
                onCreate={(name, tags) => {
                    addFolder(name, tags);
                    setIsFolderModalOpen(false);
                }}
            />

            {/* Modals */}
            <Suspense fallback={null}>
                <AddTunnelModal
                    isOpen={isAddTunnelModalOpen}
                    onClose={() => setIsAddTunnelModalOpen(false)}
                    initialConnectionId={activeConnectionId && activeConnectionId !== 'local' && activeConnectionId !== 'port-forwarding' ? activeConnectionId : undefined}
                />

                <ConnectionDetailsModal
                    isOpen={!!viewingDetailsId}
                    onClose={() => setViewingDetailsId(null)}
                    connection={connections.find((c: Connection) => c.id === viewingDetailsId) || null}
                />

                <SettingsModal isOpen={isSettingsOpen} onClose={closeSettings} />
            </Suspense>

            {/* Folder Context Menu */}
            {
                folderContextMenu && (
                    <ContextMenu
                        x={folderContextMenu.x}
                        y={folderContextMenu.y}
                        onClose={() => setFolderContextMenu(null)}
                        items={[
                            {
                                label: 'Rename Folder',
                                icon: <Pencil size={14} />,
                                action: () => {
                                    setFolderToRename(folderContextMenu.folderName);
                                    setIsRenameFolderModalOpen(true);
                                    setFolderContextMenu(null);
                                }
                            },
                            {
                                label: 'Delete Folder',
                                icon: <Trash2 size={14} />,
                                variant: 'danger',
                                action: () => {
                                    setDeletingFolder(folderContextMenu.folderName);
                                    setFolderContextMenu(null);
                                }
                            }
                        ]}
                    />
                )
            }

            <RenameFolderModal
                isOpen={isRenameFolderModalOpen}
                onClose={() => setIsRenameFolderModalOpen(false)}
                currentName={folderToRename || ''}
                currentTags={folders.find((f: Folder) => f.name === folderToRename)?.tags || []}
                onRename={(newName, newTags) => {
                    // We need a renameFolder that accepts tags, or updateFolder?
                    // renameFolder logic in context primarily handles name, but checking if it can update tags too
                    // Actually, renameFolder implementation only takes (oldName, newName).
                    // I need to update renameFolder in Context to accept tags or create 'updateFolder'
                    // For now, let's assume I will update Context next.
                    // But wait, renameFolder modifies the folder object.
                    // Let's modify renameFolder signature in Sidebar usage to match what we will change in Context.
                    if (folderToRename) {
                        // We need to call a function that updates both. 
                        // I'll update renameFolder in context to accept tags (optional 3rd arg)
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
        </div >
    );
}

function CreateFolderModal({ isOpen, onClose, onCreate }: { isOpen: boolean; onClose: () => void; onCreate: (name: string, tags: string[]) => void }) {
    const [name, setName] = useState('');
    const [tags, setTags] = useState<string[]>([]);

    useEffect(() => {
        if (isOpen) {
            setName('');
            setTags([]);
        }
    }, [isOpen]);

    return (
        <Modal isOpen={isOpen} onClose={onClose} title="">
            <div className="flex flex-col items-center pt-2 pb-4 px-2">
                {/* Icon Header */}
                <div className="mb-6 relative">
                    <div className="absolute inset-0 bg-app-accent/20 blur-xl rounded-full" />
                    <div className="relative bg-app-bg border border-app-border p-4 rounded-2xl shadow-xl">
                        <FolderPlus className="h-8 w-8 text-app-accent" />
                    </div>
                </div>

                <div className="text-center mb-6">
                    <h3 className="text-lg font-bold text-app-text mb-1">New Folder</h3>
                    <p className="text-xs text-app-muted">Organize your connections by grouping them together.</p>
                </div>

                <div className="w-full space-y-4">
                    <Input
                        label=""
                        placeholder="Folder Name (e.g. Production)"
                        value={name}
                        onChange={e => setName(e.target.value)}
                        autoFocus
                        className="py-2.5 text-center font-medium bg-app-surface/50 border-app-border focus:bg-app-bg transition-all"
                        onKeyDown={e => {
                            if (e.key === 'Enter' && name) onCreate(name, tags);
                        }}
                    />

                    {/* Tags Input */}
                    <div className="space-y-2">
                        <div className="flex gap-2">
                            <Input
                                placeholder="Add a tag..."
                                className="flex-1 text-xs"
                                onKeyDown={(e) => {
                                    if (e.key === 'Enter') {
                                        const val = e.currentTarget.value.trim();
                                        if (val && !tags.includes(val)) {
                                            setTags([...tags, val]);
                                            e.currentTarget.value = '';
                                        }
                                    }
                                }}
                            />
                        </div>
                        <div className="flex flex-wrap gap-2 min-h-[24px]">
                            {tags.map(tag => (
                                <span key={tag} className="inline-flex items-center gap-1 px-2 py-1 rounded-md bg-app-surface border border-app-border text-xs font-medium text-app-text">
                                    {tag}
                                    <button
                                        onClick={() => setTags(tags.filter(t => t !== tag))}
                                        className="hover:text-red-400 transition-colors"
                                    >
                                        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M18 6L6 18M6 6l12 12" /></svg>
                                    </button>
                                </span>
                            ))}
                        </div>
                    </div>

                    <div className="grid grid-cols-2 gap-3 pt-2">
                        <Button
                            variant="ghost"
                            onClick={onClose}
                            className="w-full hover:bg-app-surface text-app-muted hover:text-app-text"
                        >
                            Cancel
                        </Button>
                        <Button
                            onClick={() => name && onCreate(name, tags)}
                            disabled={!name}
                            className="w-full bg-app-accent hover:bg-app-accent/90 text-white shadow-lg shadow-app-accent/20"
                        >
                            Create Folder
                        </Button>
                    </div>
                </div>
            </div>
        </Modal>
    );
}

// Helper Component for Connection Items
function ConnectionItem({ conn, isCollapsed, onEdit, onDelete, onViewDetails }: { conn: Connection; isCollapsed: boolean; onEdit: (c: Connection) => void; onDelete: (c: Connection) => void; onViewDetails: (c: Connection) => void }) {
    // Zustand Hooks
    const activeConnectionId = useAppStore(state => state.activeConnectionId);
    const openTab = useAppStore(state => state.openTab);
    const connect = useAppStore(state => state.connect);
    const disconnect = useAppStore(state => state.disconnect);
    const tabs = useAppStore(state => state.tabs);

    const hasTab = useMemo(() => tabs.some((t: Tab) => t.connectionId === conn.id), [tabs, conn.id]);

    const showToast = useAppStore((state) => state.showToast);
    const addTransfer = useAppStore(state => state.addTransfer);
    const [contextMenu, setContextMenu] = useState<{ x: number; y: number; connectionId: string } | null>(null);
    const [dropTargetId, setDropTargetId] = useState<string | null>(null);
    const settings = useAppStore(state => state.settings);
    const compactMode = settings.compactMode;

    return (
        <>
            <div
                className={cn(
                    "group relative flex items-center transition-all cursor-pointer border select-none",
                    // Layout & Spacing
                    isCollapsed
                        ? "justify-center p-2 rounded-xl mx-auto w-12 h-12"
                        : compactMode
                            ? "gap-2 p-1.5 rounded-lg mx-1"
                            : "gap-3 p-3 rounded-xl mx-2",
                    // Default State
                    "border-transparent hover:bg-app-surface/50",
                    // Active State (Minimal)
                    activeConnectionId === conn.id
                        ? "bg-app-accent/5"
                        : "text-app-muted hover:text-[var(--color-app-text)]",
                    dropTargetId === conn.id && "bg-app-accent/20 border-app-accent ring-2 ring-app-accent/30"
                )}
                onClick={(e) => {
                    // Single Click: Selection only (if we implemented it) or Nothing as requested
                    e.preventDefault();
                    // Do nothing for now
                }}
                onContextMenu={(e) => {
                    // Right Click: Context Menu
                    e.preventDefault();
                    e.stopPropagation();
                    setContextMenu({ x: e.clientX, y: e.clientY, connectionId: conn.id });
                }}
                onDoubleClick={() => openTab(conn.id)}
                draggable
                onDragStart={(e) => {
                    e.dataTransfer.setData('connection-id', conn.id);
                    e.dataTransfer.effectAllowed = 'move';
                    // Optional: set custom drag image
                }}
                onDragOver={(e) => {
                    const dragSource = getCurrentDragSource();
                    if (dragSource && dragSource.connectionId !== conn.id && conn.status === 'connected') {
                        e.preventDefault();
                        setDropTargetId(conn.id);
                    }
                }}
                onDragLeave={() => setDropTargetId(null)}
                onDrop={async (e) => {
                    e.preventDefault();
                    setDropTargetId(null);
                    try {
                        const jsonData = e.dataTransfer.getData('application/json');
                        if (jsonData) {
                            const dragData = JSON.parse(jsonData);
                            if (dragData.type === 'server-file' && dragData.connectionId !== conn.id) {
                                // Get home directory first
                                let destPath: string;
                                try {
                                    const homeDir = await window.ipcRenderer.invoke('sftp:cwd', { id: conn.id });
                                    const fileName = dragData.name;
                                    destPath = homeDir === '/' ? `/${fileName}` : `${homeDir}/${fileName}`;
                                } catch (err) {
                                    showToast('error', 'Failed to get home directory');
                                    return;
                                }

                                const transferId = addTransfer({
                                    sourceConnectionId: dragData.connectionId,
                                    sourcePath: dragData.path,
                                    destinationConnectionId: conn.id,
                                    destinationPath: destPath
                                });

                                showToast('info', `Copying to ${conn.name || conn.host}...`);

                                (async () => {
                                    try {
                                        await window.ipcRenderer.invoke('sftp:copyToServer', {
                                            sourceConnectionId: dragData.connectionId,
                                            sourcePath: dragData.path,
                                            destinationConnectionId: conn.id,
                                            destinationPath: destPath,
                                            transferId
                                        });
                                    } catch (error: any) {
                                        if (error.message && !error.message.includes('destroy')) {
                                            showToast('error', `Transfer failed: ${error.message}`);
                                        }
                                    }
                                })();
                            }
                        }
                    } catch (err) {
                        console.error('Drop handling failed:', err);
                        showToast('error', `Drag & drop failed: ${err instanceof Error ? err.message : String(err)}`);
                    }
                }}
            >

                {/* Active Marker Line (Left) */}
                {activeConnectionId === conn.id && (
                    <div className="absolute left-0 top-1/2 -translate-y-1/2 h-6 w-1 bg-app-accent shadow-[0_0_12px_rgba(var(--color-app-accent),0.6)] rounded-r-full" />
                )}

                {/* Icon */}
                <div className={cn(
                    "relative shrink-0 flex items-center justify-center transition-all duration-300",
                    compactMode ? "h-7 w-7" : "h-9 w-9", // Slightly smaller
                    // Clean look: No background box
                    "bg-transparent"
                )}>
                    <OSIcon
                        icon={conn.icon || 'Server'}
                        className={cn(
                            "transition-transform duration-500",
                            compactMode ? "w-4 h-4" : "w-[18px] h-[18px]",
                            activeConnectionId === conn.id ? "text-app-accent" : "text-app-muted group-hover:text-[var(--color-app-text)] group-hover:scale-110"
                        )}
                    />

                    {/* Status Dot */}
                    {conn.status === 'connected' && (
                        <div className={cn(
                            "absolute -bottom-1 -right-1 h-3 w-3 rounded-full shadow-sm",
                            hasTab
                                ? "bg-app-success border-2 border-app-panel animate-pulse-slow" // Active Session
                                : "bg-transparent border-2 border-app-accent/60" // Background/Tunnel Only (Hollow)
                        )} title={hasTab ? "Connected" : "Tunnel/Background Active"} />
                    )}
                </div>

                {!isCollapsed && (
                    <div className="flex flex-col overflow-hidden min-w-0 flex-1">
                        <div className="flex items-center justify-between gap-2">
                            <span className={cn(
                                "truncate font-medium leading-tight transition-colors",
                                compactMode ? "text-sm" : "text-[14px]",
                                activeConnectionId === conn.id ? "text-app-text font-semibold" : "text-app-text/80 group-hover:text-app-text"
                            )}>
                                {conn.name || conn.host}
                            </span>

                            {/* Hover Actions */}
                            <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                                <button
                                    className="p-1 rounded hover:bg-app-surface hover:text-app-text text-app-muted transition-colors"
                                    onClick={(e) => {
                                        e.stopPropagation();
                                        onEdit(conn);
                                    }}
                                    title="Edit Connection"
                                >
                                    <Settings size={10} />
                                </button>
                            </div>
                        </div>
                        <span className={cn(
                            "truncate leading-tight",
                            compactMode ? "text-[10px] mt-0.5" : "text-xs mt-0.5",
                            "text-app-muted/50 font-mono group-hover:text-app-muted/70 transition-colors"
                        )}>
                            {conn.username}@{conn.host}
                        </span>

                    </div>
                )}
            </div >

            {/* Context Menu */}
            {
                contextMenu && (
                    <ContextMenu
                        x={contextMenu.x}
                        y={contextMenu.y}
                        items={[
                            {
                                label: conn.status === 'connected' ? "Disconnect" : "Connect",
                                icon: <Power size={14} className={conn.status === 'connected' ? "text-red-400" : "text-emerald-400"} />,
                                action: () => {
                                    if (conn.status === 'connected') {
                                        disconnect(conn.id);
                                    } else {
                                        connect(conn.id);
                                        openTab(conn.id);
                                    }
                                }
                            },
                            {
                                label: "Details",
                                icon: <Info size={14} />,
                                action: () => onViewDetails(conn)
                            },
                            { separator: true },
                            {
                                label: "File Manager",
                                icon: <Files size={14} />,
                                action: () => openTab(conn.id, 'files')
                            },
                            {
                                label: "Port Forwarding",
                                icon: <Network size={14} />,
                                action: () => openTab(conn.id, 'port-forwarding')
                            },
                            {
                                label: "Snippets",
                                icon: <Code size={14} />,
                                action: () => openTab(conn.id, 'snippets')
                            },
                            {
                                label: "Dashboard",
                                icon: <LayoutDashboard size={14} />,
                                action: () => openTab(conn.id, 'dashboard')
                            },
                            { separator: true },
                            {
                                label: "Edit",
                                icon: <Pencil size={14} />,
                                action: () => onEdit(conn)
                            },
                            {
                                label: "Delete",
                                icon: <Trash2 size={14} />,
                                variant: "danger",
                                action: () => onDelete(conn)
                            }
                        ]}
                        onClose={() => setContextMenu(null)}
                    />
                )
            }
        </>
    );
}

function RenameFolderModal({ isOpen, onClose, currentName, currentTags, onRename }: { isOpen: boolean; onClose: () => void; currentName: string; currentTags: string[]; onRename: (name: string, tags: string[]) => void }) {
    const [name, setName] = useState(currentName);
    const [tags, setTags] = useState<string[]>([]);

    useEffect(() => {
        if (!isOpen) return;
        setName(currentName);
        setTags(currentTags || []);
    }, [currentName, currentTags, isOpen]);

    return (
        <Modal isOpen={isOpen} onClose={onClose} title="Rename Folder">
            <div className="flex flex-col items-center pt-2 pb-4 px-2">
                <div className="mb-6 relative">
                    <div className="absolute inset-0 bg-app-accent/20 blur-xl rounded-full" />
                    <div className="relative bg-app-bg border border-app-border p-4 rounded-2xl shadow-xl">
                        <Pencil className="h-8 w-8 text-app-accent" />
                    </div>
                </div>
                <div className="w-full space-y-4">
                    <Input
                        label="Folder Name"
                        value={name}
                        onChange={e => setName(e.target.value)}
                        autoFocus
                        className="py-2.5 text-center font-medium bg-app-surface/50 border-app-border focus:bg-app-bg transition-all"
                        onKeyDown={e => e.key === 'Enter' && name.trim() !== '' && onRename(name, tags)}
                    />

                    {/* Tags Input */}
                    <div className="space-y-2">
                        <label className="text-xs font-semibold text-app-muted uppercase tracking-wider block">Tags</label>
                        <div className="flex gap-2">
                            <Input
                                placeholder="Add a tag..."
                                className="flex-1 text-xs"
                                onKeyDown={(e) => {
                                    if (e.key === 'Enter') {
                                        const val = e.currentTarget.value.trim();
                                        if (val && !tags.includes(val)) {
                                            setTags([...tags, val]);
                                            e.currentTarget.value = '';
                                        }
                                    }
                                }}
                            />
                        </div>
                        <div className="flex flex-wrap gap-2 min-h-[24px]">
                            {tags.map(tag => (
                                <span key={tag} className="inline-flex items-center gap-1 px-2 py-1 rounded-md bg-app-surface border border-app-border text-xs font-medium text-app-text">
                                    {tag}
                                    <button
                                        onClick={() => setTags(tags.filter(t => t !== tag))}
                                        className="hover:text-red-400 transition-colors"
                                    >
                                        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M18 6L6 18M6 6l12 12" /></svg>
                                    </button>
                                </span>
                            ))}
                        </div>
                    </div>

                    <div className="grid grid-cols-2 gap-3 pt-2">
                        <Button variant="ghost" onClick={onClose} className="w-full hover:bg-app-surface text-app-muted hover:text-app-text">Cancel</Button>
                        <Button onClick={() => onRename(name, tags)} className="w-full bg-app-accent hover:bg-app-accent/90 text-white shadow-lg shadow-app-accent/20">Save Changes</Button>
                    </div>
                </div>
            </div>
        </Modal>
    );
}

interface ConnectionItemProps {
    onEdit: (conn: Connection) => void;
    onDelete: (conn: Connection) => void;
    onViewDetails: (conn: Connection) => void;
}

function FolderItem({
    node,
    isCollapsed,
    compactMode,
    expandedFolders,
    toggleFolder,
    updateConnectionFolder,
    onDeleteFolder,
    onRenameFolder,
    onMoveFolder, // Used for internal DnD moves
    connectionItemProps
}: {
    node: TreeNode;
    isCollapsed: boolean;
    compactMode: boolean;
    expandedFolders: Set<string>;
    toggleFolder: (p: string) => void;
    updateConnectionFolder: (id: string, f: string) => void;
    onDeleteFolder: (f: string) => void;
    onRenameFolder: (f: string) => void;
    onMoveFolder: (oldName: string, newName: string) => void;
    connectionItemProps: ConnectionItemProps;
}) {
    const isExpanded = expandedFolders.has(node.path);
    const [isDragOver, setIsDragOver] = useState(false);

    return (
        <div className={cn("select-none transition-all duration-200", isExpanded && isCollapsed && "bg-app-surface/30 rounded-2xl pb-1 mb-2 border border-app-border/20")}>
            <div
                className={cn(
                    "flex items-center group cursor-pointer transition-colors mb-1 rounded-lg relative select-none",
                    isCollapsed
                        ? "justify-center mx-auto w-10 h-10 hover:bg-app-surface/50 my-1"
                        : cn(compactMode ? "px-2 py-1 text-xs gap-2" : "px-4 py-1.5 text-sm gap-2", "text-app-muted hover:text-app-text hover:bg-app-surface/30"),
                    isDragOver && "bg-app-accent/10"
                )}
                onClick={() => toggleFolder(node.path)}
                draggable
                onDragStart={(e) => {
                    e.dataTransfer.setData('folder-path', node.path);
                    e.dataTransfer.effectAllowed = 'move';
                }}
                onDragOver={(e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    setIsDragOver(true);
                }}
                onDragLeave={() => {
                    setIsDragOver(false);
                }}
                onDrop={(e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    setIsDragOver(false);

                    const connId = e.dataTransfer.getData('connection-id');
                    const srcFolderPath = e.dataTransfer.getData('folder-path');

                    // Friendly message for external file drops
                    const types = Array.from(e.dataTransfer.types);
                    if (!connId && !srcFolderPath && (types.includes('Files') || types.includes('text/uri-list'))) {
                        useAppStore.getState().showToast('info', 'External file drop into sidebar is currently disabled. We are working to bring this feature soon!');
                        return;
                    }

                    if (connId) {
                        // Connection Drop -> Move Connection to this Folder
                        updateConnectionFolder(connId, node.path);
                    } else if (srcFolderPath) {
                        // Folder Drop -> Nest Folder
                        // Validate:
                        // 1. Not self
                        if (srcFolderPath === node.path) return;
                        // 2. Not dropping Parent into Child (Target starts with Source/)
                        if (node.path.startsWith(srcFolderPath + '/')) return;
                        // 3. Not dropping into immediate Parent (Target is same as Source's parent)
                        // Actually, renaming 'A' to 'Target/A' handles this (it just becomes same path).

                        const newName = `${node.path}/${srcFolderPath.split('/').pop()}`;
                        onMoveFolder(srcFolderPath, newName);
                    }
                }}
            >
                {isCollapsed ? (
                    <div className={cn(
                        "flex items-center justify-center w-8 h-8 rounded-lg border text-app-muted font-bold shadow-sm transition-all",
                        isExpanded
                            ? "bg-app-accent/20 border-app-accent/50 text-app-accent shadow-md"
                            : "bg-app-surface/50 border-app-border/30 group-hover:border-app-accent/30 group-hover:text-app-text"
                    )} title={node.name}>
                        {node.name.charAt(0).toUpperCase()}
                    </div>
                ) : (
                    <>
                        <div className={cn("transition-transform duration-200", isExpanded ? "rotate-90" : "")}>
                            <ChevronRight size={compactMode ? 12 : 14} />
                        </div>
                        {isExpanded ? <FolderOpen size={compactMode ? 14 : 16} className="text-app-accent/80" /> : <FolderIcon size={compactMode ? 14 : 16} />}
                        <span className="font-semibold truncate flex-1 flex items-center gap-2">
                            {node.name}
                        </span>
                        <span className="ml-auto text-[10px] opacity-0 group-hover:opacity-60 mr-2">{node.connections.length}</span>

                        <div className="flex opacity-0 group-hover:opacity-100 transition-opacity">
                            <Button
                                variant="ghost"
                                size="icon"
                                className="h-5 w-5 hover:text-app-text"
                                onClick={(e) => {
                                    e.stopPropagation();
                                    onRenameFolder(node.path);
                                }}
                            >
                                <Pencil className="h-3 w-3" />
                            </Button>
                            <Button
                                variant="ghost"
                                size="icon"
                                className="h-5 w-5 hover:text-red-400"
                                onClick={(e) => {
                                    e.stopPropagation();
                                    onDeleteFolder(node.path);
                                }}
                            >
                                <Trash2 className="h-3 w-3" />
                            </Button>
                        </div>
                    </>
                )}
            </div>

            {
                isExpanded && (
                    <div className={cn(
                        "space-y-1",
                        !isCollapsed && "border-l border-app-border/30 ml-4 pl-1",
                        compactMode ? "mb-1" : "mb-2",
                        isCollapsed && "flex flex-col items-center gap-1"
                    )}>
                        {Object.keys(node.children).sort().map(key => (
                            <FolderItem
                                key={key}
                                node={node.children[key]}
                                isCollapsed={isCollapsed}
                                compactMode={compactMode}
                                expandedFolders={expandedFolders}
                                toggleFolder={toggleFolder}
                                updateConnectionFolder={updateConnectionFolder}
                                onRenameFolder={onRenameFolder}
                                onMoveFolder={onMoveFolder}
                                connectionItemProps={connectionItemProps}
                                onDeleteFolder={onDeleteFolder}
                            />
                        ))}
                        {node.connections.map((conn: Connection) => (
                            <ConnectionItem
                                key={conn.id}
                                conn={conn}
                                isCollapsed={isCollapsed}
                                onEdit={connectionItemProps.onEdit}
                                onDelete={connectionItemProps.onDelete}
                                onViewDetails={connectionItemProps.onViewDetails}
                            />
                        ))}
                    </div>
                )
            }
        </div >
    );
}
