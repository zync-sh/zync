import { useState, useCallback, useEffect, useRef, useMemo } from 'react';
import { useConnections, Connection, Folder } from '../../context/ConnectionContext';
import { useTransfers } from '../../context/TransferContext';
import { getCurrentDragSource } from '../file-manager/FileGrid';
import { useToast } from '../../context/ToastContext';
import { useSettings } from '../../context/SettingsContext';
import { Server, MoreVertical, FolderOpen, FolderClosed, Trash2, Pencil, ChevronRight, Play, Square, Network, Plus, Folder as FolderIcon, X, Search, Terminal as TerminalIcon, PanelLeftOpen, ChevronDown, Laptop, FolderPlus, PanelLeftClose, Terminal, Settings, FileText } from 'lucide-react';
import { OSIcon } from '../icons/OSIcon';
import { cn } from '../../lib/utils';
import { Button } from '../ui/Button';
import { Modal } from '../ui/Modal';
import { Input } from '../ui/Input';
import { SettingsModal } from '../settings/SettingsModal';
import { ContextMenu } from '../ui/ContextMenu';

import { AddTunnelModal } from '../modals/AddTunnelModal';
import { ConnectionDetailsModal } from '../modals/ConnectionDetailsModal';

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
            onDrop={onDrop}
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
        allFolders.filter(f =>
            f.name.toLowerCase().includes(normalizedSearch) ||
            (f.tags && f.tags.some(t => t.toLowerCase().includes(normalizedSearch)))
        ).forEach(f => getNode(f.name));
    }

    // 2. Populate Connections
    conns.forEach(conn => {
        // Search Filter: Check Name, Host, and Tags
        const matchesSearch = !searchTerm ||
            (conn.name || conn.host).toLowerCase().includes(normalizedSearch) ||
            (conn.tags && conn.tags.some(t => t.toLowerCase().includes(normalizedSearch)));

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

export function Sidebar() {
    const [viewingDetailsId, setViewingDetailsId] = useState<string | null>(null);
    const { connections, activeConnectionId, addConnection, editConnection, importConnections, openTab, openTunnelsTab, folders, addFolder, updateConnectionFolder, deleteFolder, renameFolder, isAddConnectionModalOpen, openAddConnectionModal, closeAddConnectionModal } = useConnections();
    const { settings, updateSettings, isSettingsOpen, openSettings, closeSettings } = useSettings();
    const compactMode = settings.compactMode;
    // const [isAddModalOpen, setIsAddModalOpen] = useState(false); // Moved to context
    const [isFolderModalOpen, setIsFolderModalOpen] = useState(false); // State for Create Folder Modal

    const [searchTerm, setSearchTerm] = useState('');
    const [isRenameFolderModalOpen, setIsRenameFolderModalOpen] = useState(false);
    const [folderToRename, setFolderToRename] = useState<string | null>(null);
    const [folderContextMenu, setFolderContextMenu] = useState<{ x: number; y: number; folderName: string } | null>(null);
    // const [isCollapsed, setIsCollapsed] = useState(false); // Moved to Settings
    const isCollapsed = settings.sidebarCollapsed;

    // Add Menu State
    const [isAddMenuOpen, setIsAddMenuOpen] = useState(false);
    const [isAddTunnelModalOpen, setIsAddTunnelModalOpen] = useState(false);
    const addMenuRef = useRef<HTMLDivElement>(null);

    useEffect(() => {
        const handleClickOutside = (event: MouseEvent) => {
            if (addMenuRef.current && !addMenuRef.current.contains(event.target as Node)) {
                setIsAddMenuOpen(false);
            }
        };
        document.addEventListener('mousedown', handleClickOutside);
        return () => document.removeEventListener('mousedown', handleClickOutside);
    }, []);

    // const canAddTunnel = activeConnectionId && activeConnectionId !== 'local' && activeConnectionId !== 'tunnels';

    // Resize Logic

    // Resize Logic
    const [width, setWidth] = useState(settings.sidebarWidth || 288);
    const [isResizing, setIsResizing] = useState(false);
    const sidebarRef = useRef<HTMLDivElement>(null);

    // Sync width if settings change externally (e.g. via reset)
    useEffect(() => {
        if (settings.sidebarWidth && !isResizing) {
            setWidth(settings.sidebarWidth);
        }
    }, [settings.sidebarWidth, isResizing]);

    const startResizing = useCallback((e: React.MouseEvent) => {
        setIsResizing(true);
        e.preventDefault();
        document.body.style.cursor = 'col-resize';
    }, []);

    useEffect(() => {
        if (!isResizing) return;

        const resize = (e: MouseEvent) => {
            const newWidth = Math.max(200, Math.min(e.clientX, 600)); // Clamp between 200px and 600px
            setWidth(newWidth);
        };

        const stopResizing = () => {
            setIsResizing(false);
            document.body.style.cursor = '';
            // Save final width
            updateSettings({ sidebarWidth: width });
        };

        window.addEventListener('mousemove', resize);
        window.addEventListener('mouseup', stopResizing);

        return () => {
            window.removeEventListener('mousemove', resize);
            window.removeEventListener('mouseup', stopResizing);
        };
    }, [isResizing, width, updateSettings]);

    // Compute Active Connections
    const activeConnections = useMemo(() => {
        return connections.filter(c => c.status === 'connected');
    }, [connections]);


    // Form State
    const [formData, setFormData] = useState<Partial<Connection>>({
        name: '', host: '', username: '', port: 22, password: '', privateKeyPath: '', jumpServerId: undefined, icon: 'Server', folder: '', theme: '', tags: []
    });
    const [authMethod, setAuthMethod] = useState<'password' | 'key'>('password');
    const [editingConnectionId, setEditingConnectionId] = useState<string | null>(null);

    // Reset when modal closes
    useEffect(() => {
        if (!isAddConnectionModalOpen) {
            setEditingConnectionId(null);
            setFormData({ name: '', host: '', username: '', port: 22, password: '', privateKeyPath: '', jumpServerId: undefined, icon: 'Server', folder: '', theme: '', tags: [] });
            setAuthMethod('password');
        }
    }, [isAddConnectionModalOpen]);

    const handleSave = () => {
        if (!formData.host || !formData.username) return;

        const connectionData = {
            id: editingConnectionId || Math.random().toString(36).substr(2, 9),
            name: formData.name || formData.host,
            host: formData.host!,
            username: formData.username!,
            port: formData.port || 22,
            password: formData.password,
            privateKeyPath: formData.privateKeyPath,
            status: editingConnectionId ? (connections.find(c => c.id === editingConnectionId)?.status || 'disconnected') : 'disconnected',
            jumpServerId: formData.jumpServerId,
            icon: formData.icon,
            theme: formData.theme,
            folder: formData.folder,
            tags: formData.tags || []
        } as Connection;

        if (editingConnectionId) {
            editConnection(connectionData);
        } else {
            addConnection(connectionData);
        }

        closeAddConnectionModal();
    };

    const openEditConnection = (conn: Connection) => {
        setEditingConnectionId(conn.id);
        setFormData({
            ...conn,
            password: conn.password || '', // Explicitly handle optional fields
            privateKeyPath: conn.privateKeyPath || '',
            jumpServerId: conn.jumpServerId,
            icon: conn.icon,
            folder: conn.folder,
            theme: conn.theme,
            tags: conn.tags || []
        });
        setAuthMethod(conn.privateKeyPath ? 'key' : 'password');
        openAddConnectionModal();
    };

    // Filter out active connections for the main tree if NO search term is active
    // If searching, we want to search everything
    const treeConnections = useMemo(() => {
        if (searchTerm) return connections;
        return connections.filter(c => c.status !== 'connected');
    }, [connections, searchTerm]);

    // Build Recursive Tree
    const treeRoot = useMemo(() => buildTree(treeConnections, folders, searchTerm), [treeConnections, folders, searchTerm]);

    const [expandedFolders, setExpandedFolders] = useState<Set<string>>(new Set());

    const toggleFolder = (folderPath: string) => {
        const newSet = new Set(expandedFolders);
        if (newSet.has(folderPath)) {
            newSet.delete(folderPath);
        } else {
            newSet.add(folderPath);
        }
        setExpandedFolders(newSet);
    };

    const handleRenameFolder = (path: string) => {
        setFolderToRename(path);
        setIsRenameFolderModalOpen(true);
    };

    // Auto-expand folder if search term is active
    useEffect(() => {
        if (searchTerm) {
            // Expand all folders that have matches
            setExpandedFolders(new Set(folders.map(f => f.name)));
        }
    }, [searchTerm, folders]);

    return (
        <div
            ref={sidebarRef}
            className={cn(
                "bg-app-panel/95 backdrop-blur-xl border-r border-app-border/50 flex flex-col h-full shrink-0 relative z-50",
                // Only use transition when NOT resizing to ensure smooth drag
                !isResizing && "transition-all duration-300 ease-in-out"
            )}
            style={{
                width: isCollapsed ? 0 : width,
                borderRight: isCollapsed ? 'none' : undefined,
                overflow: 'hidden' // Ensure content doesn't leak during animation
            }}
        >
            {/* Resize Handle */}
            {!isCollapsed && (
                <div
                    className="absolute right-0 top-0 bottom-0 w-1 hover:w-1.5 cursor-col-resize hover:bg-app-accent/50 transition-all z-[100] group"
                    onMouseDown={startResizing}
                >
                    <div className="absolute inset-y-0 right-0 w-4 -z-10" /> {/* Larger hit area */}
                </div>
            )}
            {/* Header */}
            {/* Header */}
            <div className={cn(
                "flex items-center justify-between shrink-0",
                compactMode ? "p-3 pb-2" : "p-5 pb-4" // Increased bottom padding
            )}>
                {!isCollapsed && (
                    <div className="flex items-center gap-3 overflow-hidden"> {/* Increased gap */}
                        <svg width={compactMode ? "24" : "32"} height={compactMode ? "24" : "32"} viewBox="0 0 512 512" fill="none" xmlns="http://www.w3.org/2000/svg" className="shrink-0">
                            <rect width="512" height="512" rx="128" className="fill-app-accent/10" />
                            <path d="M128 170.667L213.333 256L128 341.333" className="stroke-app-accent" strokeWidth="64" strokeLinecap="round" strokeLinejoin="round" />
                            <path d="M256 341.333H384" className="stroke-app-text" strokeWidth="64" strokeLinecap="round" strokeLinejoin="round" />
                        </svg>
                        <div className="flex flex-col">
                            <span className="font-bold text-sm tracking-tight text-app-text leading-none">Hosts</span>
                            <span className="text-[10px] font-bold text-app-muted/60 tracking-widest uppercase mt-0.5">Explorer</span>
                        </div>
                    </div>
                )}

                <div className="flex items-center gap-1">
                    {!isCollapsed && (
                        <div className="relative" ref={addMenuRef}>
                            <Button
                                variant="ghost"
                                size="icon"
                                onClick={() => setIsAddMenuOpen(!isAddMenuOpen)}
                                className={cn(
                                    "h-8 w-8 transition-colors",
                                    isAddMenuOpen ? "text-app-accent bg-app-accent/10" : "text-app-muted hover:text-[var(--color-app-text)]"
                                )}
                                title="Add New..."
                            >
                                <Plus className="h-4 w-4" />
                            </Button>

                            {/* Add Dropdown */}
                            {isAddMenuOpen && (
                                <div className="absolute top-full right-0 mt-2 w-48 bg-app-panel border border-app-border rounded-xl shadow-xl z-50 overflow-hidden animate-in fade-in zoom-in-95 duration-200">
                                    <div className="p-1 space-y-0.5">
                                        <button
                                            onClick={() => { openAddConnectionModal(); setIsAddMenuOpen(false); }}
                                            className="w-full text-left px-3 py-2 text-sm text-app-text hover:bg-app-surface rounded-lg flex items-center gap-2 transition-colors"
                                        >
                                            <Laptop size={14} className="text-app-muted" />
                                            <span>New Host</span>
                                        </button>
                                        <button
                                            onClick={() => { setIsFolderModalOpen(true); setIsAddMenuOpen(false); }}
                                            className="w-full text-left px-3 py-2 text-sm text-app-text hover:bg-app-surface rounded-lg flex items-center gap-2 transition-colors"
                                        >
                                            <FolderPlus size={14} className="text-app-muted" />
                                            <span>New Folder</span>
                                        </button>

                                        <div className="h-px bg-app-border/50 my-1 mx-2" />

                                        <button
                                            onClick={() => {
                                                setIsAddTunnelModalOpen(true);
                                                setIsAddMenuOpen(false);
                                            }}
                                            className="w-full text-left px-3 py-2 text-sm text-app-text hover:bg-app-surface rounded-lg flex items-center gap-2 transition-colors"
                                            title="Create a new tunnel"
                                        >
                                            <Network size={14} className="text-app-muted" />
                                            <span>New Tunnel</span>
                                        </button>
                                    </div>
                                </div>
                            )}
                        </div>
                    )}
                    <Button variant="ghost" size="icon" onClick={() => updateSettings({ sidebarCollapsed: !isCollapsed })} className="h-8 w-8 text-app-muted hover:text-[var(--color-app-text)] transition-colors">
                        {isCollapsed ? <PanelLeftOpen className="h-5 w-5" /> : <PanelLeftClose className="h-5 w-5" />}
                    </Button>
                </div>
            </div>



            {/* Quick Connect / Search */}
            {!isCollapsed && (
                <div className={compactMode ? "px-2 mb-2" : "px-4 mb-4"}>
                    <div className="relative group">
                        <div className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none">
                            <Search className="h-3.5 w-3.5 text-app-muted group-focus-within:text-app-accent transition-colors" />
                        </div>
                        <input
                            className={cn(
                                "w-full bg-app-surface/40 hover:bg-app-surface/60 border border-app-border/40 rounded-xl text-app-text focus:border-app-accent/40 focus:ring-4 focus:ring-app-accent/10 focus:outline-none placeholder:text-app-muted/50 transition-all font-medium",
                                compactMode ? "px-3 py-1.5 pl-9 text-xs" : "px-3 py-2.5 pl-9 text-sm"
                            )}
                            placeholder="Search by tag, host/folder name..."
                            value={searchTerm}
                            onChange={e => setSearchTerm(e.target.value)}
                        />
                        {/* Shortcut Hint */}
                        <div className="absolute inset-y-0 right-0 pr-3 flex items-center pointer-events-none">
                            <kbd className="hidden group-focus-within:inline-flex h-5 items-center gap-1 rounded border border-app-border bg-app-surface px-1.5 font-mono text-[10px] text-app-muted font-medium text-opacity-70">
                                ↵
                            </kbd>
                        </div>
                    </div>
                </div>
            )}

            {/* Tag Filter Bar Removed */}

            {/* System Bar (Pinned) */}
            <div className={cn(compactMode ? "px-2 mb-2" : "px-3 mb-2")}>
                <div className="bg-app-surface/25 p-1 rounded-xl flex items-center gap-1 border border-app-border/20 flex-row">
                    {/* Local Terminal */}
                    <button
                        className={cn(
                            "group relative flex items-center justify-center transition-all cursor-pointer select-none outline-none flex-1 py-1.5 rounded-lg",
                            activeConnectionId === 'local'
                                ? "bg-app-panel text-app-text shadow-sm border border-app-border/10"
                                : "text-app-muted hover:text-[var(--color-app-text)] hover:bg-app-surface/50 border border-transparent"
                        )}
                        onClick={() => openTab('local')}
                        title="Local Terminal"
                    >
                        <Terminal className={cn(compactMode ? "w-3.5 h-3.5" : "w-4 h-4", activeConnectionId === 'local' ? "text-app-accent" : "")} />
                        {!isCollapsed && <span className="ml-2 font-medium text-[11px] uppercase tracking-wide opacity-90">Term</span>}
                    </button>

                    {/* Global Tunnels */}
                    <button
                        className={cn(
                            "group relative flex items-center justify-center transition-all cursor-pointer select-none outline-none flex-1 py-1.5 rounded-lg",
                            activeConnectionId === 'tunnels'
                                ? "bg-app-panel text-app-text shadow-sm border border-app-border/10"
                                : "text-app-muted hover:text-[var(--color-app-text)] hover:bg-app-surface/50 border border-transparent"
                        )}
                        onClick={() => openTunnelsTab()}
                        title="Global Tunnels"
                    >
                        <Network className={cn(compactMode ? "w-3.5 h-3.5" : "w-4 h-4", activeConnectionId === 'tunnels' ? "text-app-accent" : "")} />
                        {!isCollapsed && <span className="ml-2 font-medium text-[11px] uppercase tracking-wide opacity-90">Tunnels</span>}
                    </button>
                </div>
            </div>

            <div className="h-px bg-app-border/30 mb-2 mx-4" />

            {/* List */}
            <div className={cn(
                "flex-1 overflow-y-auto pb-4 scrollbar-hide",
                compactMode ? "px-2 space-y-0.5" : "px-3 space-y-2"
            )}>
                {/* VISUAL SECTIONS LOGIC */}
                {!searchTerm && activeConnections.length > 0 ? (
                    <>
                        <SidebarSection title="Active" count={activeConnections.length} compactMode={compactMode}>
                            <div className={cn("space-y-1 mb-2 pl-1", compactMode && "space-y-0.5")}>
                                {activeConnections.map(conn => (
                                    <ConnectionItem
                                        key={`active-${conn.id}`}
                                        conn={conn}
                                        isCollapsed={isCollapsed}
                                        onEdit={openEditConnection}
                                        onViewDetails={(c) => setViewingDetailsId(c.id)}
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
                                        isCollapsed={isCollapsed}
                                        compactMode={compactMode}
                                        expandedFolders={expandedFolders}
                                        toggleFolder={toggleFolder}
                                        updateConnectionFolder={updateConnectionFolder}
                                        deleteFolder={deleteFolder}
                                        onRenameFolder={handleRenameFolder}
                                        renameFolder={renameFolder}
                                        connectionItemProps={{ onEdit: openEditConnection, onViewDetails: (c: Connection) => setViewingDetailsId(c.id) }}
                                    />
                                ))}
                                {treeRoot.connections.map(conn => (
                                    <ConnectionItem
                                        key={conn.id}
                                        conn={conn}
                                        isCollapsed={isCollapsed}
                                        onEdit={openEditConnection}
                                        onViewDetails={c => setViewingDetailsId(c.id)}
                                    />
                                ))}
                            </div>
                        </SidebarSection>
                    </>
                ) : (
                    /* Default / Search View: No sections, just the tree */
                    <>
                        {Object.keys(treeRoot.children).sort().map(key => (
                            <FolderItem
                                key={key}
                                node={treeRoot.children[key]}
                                isCollapsed={isCollapsed}
                                compactMode={compactMode}
                                expandedFolders={expandedFolders}
                                toggleFolder={toggleFolder}
                                updateConnectionFolder={updateConnectionFolder}
                                deleteFolder={deleteFolder}
                                onRenameFolder={handleRenameFolder}
                                renameFolder={renameFolder}
                                connectionItemProps={{ onEdit: openEditConnection, onViewDetails: (c: Connection) => setViewingDetailsId(c.id) }}
                            />
                        ))}
                        {treeRoot.connections.map(conn => (
                            <ConnectionItem
                                key={conn.id}
                                conn={conn}
                                isCollapsed={isCollapsed}
                                onEdit={openEditConnection}
                                onViewDetails={c => setViewingDetailsId(c.id)}
                            />
                        ))}
                    </>
                )}
            </div>

            {/* Footer / User */}
            <div className={cn("p-4 border-t border-app-border/30 backdrop-blur-md bg-app-panel/50", isCollapsed && "p-2")}>
                <button
                    onClick={openSettings}
                    className={cn(
                        "flex items-center gap-3 w-full p-2.5 rounded-xl transition-all duration-200 group",
                        "hover:bg-app-surface/80 border border-transparent hover:border-app-border/50",
                        isCollapsed && "justify-center p-0 h-12 w-12 rounded-2xl bg-app-surface/30"
                    )}
                >
                    <div className="h-8 w-8 rounded-lg bg-gradient-to-br from-indigo-500 to-purple-600 flex items-center justify-center shrink-0 shadow-lg shadow-indigo-500/20 group-hover:shadow-indigo-500/40 transition-shadow">
                        {/* Show Gear icon on hover or always? Let's show Gear on hover, OP otherwise for fun? Or just Settings Icon? */}
                        {/* actually, let's just use a Settings Icon for the button itself if it's the settings button */}
                        {/* The user currently has an 'Operator' avatar. Let's keep that but add a small gear or change it to a gear if they want 'Settings' */}
                        {/* If the user is asking "why the icon is not visible", they might be looking for the GEAR. */}
                        <Settings className="text-white w-5 h-5" />
                    </div>
                    {!isCollapsed && (
                        <div className="flex-1 text-left overflow-hidden">
                            <div className="text-sm font-semibold text-app-text group-hover:text-[var(--color-app-text)] transition-colors">Settings</div>
                            <div className="text-[10px] text-app-muted uppercase tracking-wider">Preferences</div>
                        </div>
                    )}
                </button>
            </div>

            {/* Modals */}
            <Modal isOpen={isAddConnectionModalOpen} onClose={closeAddConnectionModal} title={editingConnectionId ? "Edit Connection" : "New Connection"}>
                <div className="space-y-4">
                    <div className="grid grid-cols-2 gap-4">
                        <Input label="Name" placeholder="Production DB" value={formData.name} onChange={e => setFormData({ ...formData, name: e.target.value })} />
                        <Input label="Host" placeholder="192.168.1.1" value={formData.host} onChange={e => setFormData({ ...formData, host: e.target.value })} />
                    </div>
                    <div className="grid grid-cols-2 gap-4">
                        <Input label="Username" placeholder="root" value={formData.username} onChange={e => setFormData({ ...formData, username: e.target.value })} />
                        <Input label="Port" type="number" placeholder="22" value={formData.port} onChange={e => setFormData({ ...formData, port: Number(e.target.value) })} />
                    </div>

                    <div className="pt-2">
                        <Input
                            label="Folder (Optional)"
                            placeholder="e.g. Production, AWS, Personal"
                            value={formData.folder || ''}
                            onChange={e => setFormData({ ...formData, folder: e.target.value })}
                            list="folder-suggestions"
                        />
                        <datalist id="folder-suggestions">
                            {folders.map(f => (
                                <option key={f.name} value={f.name} />
                            ))}
                        </datalist>
                    </div>

                    <div className="pt-2">
                        <label className="text-xs font-semibold text-app-muted uppercase tracking-wider block mb-2">Icon</label>
                        <div className="flex gap-2 flex-wrap">
                            {[
                                // Generic
                                'Server', 'Database', 'Cloud', 'Terminal', 'Code', 'Box', 'Monitor', 'Globe', 'HardDrive',
                                // OS
                                'Ubuntu', 'Debian', 'CentOS', 'Arch', 'Kali', 'macOS', 'Windows', 'Linux'
                            ].map(iconName => {
                                const isSelected = (formData.icon || 'Server').toLowerCase() === iconName.toLowerCase();
                                return (
                                    <button
                                        key={iconName}
                                        onClick={() => setFormData({ ...formData, icon: iconName })}
                                        className={cn(
                                            "p-2 rounded-lg border transition-all hover:bg-app-surface",
                                            isSelected
                                                ? "bg-app-accent/20 border-app-accent text-app-accent"
                                                : "bg-app-bg border-app-border text-app-muted"
                                        )}
                                        title={iconName}
                                    >
                                        <OSIcon icon={iconName} className="w-[18px] h-[18px]" />
                                    </button>
                                );
                            })}
                        </div>
                    </div>

                    <div className="pt-4 border-t border-app-border">
                        <div className="flex gap-2 mb-3">
                            <Button size="sm" variant={authMethod === 'password' ? 'primary' : 'secondary'} onClick={() => setAuthMethod('password')}>Password</Button>
                            <Button size="sm" variant={authMethod === 'key' ? 'primary' : 'secondary'} onClick={() => setAuthMethod('key')}>Private Key</Button>
                        </div>

                        {authMethod === 'password' ? (
                            <Input label="Password" type="password" value={formData.password} onChange={e => setFormData({ ...formData, password: e.target.value })} />
                        ) : (
                            <div className="space-y-2">
                                <label className="text-xs font-semibold text-app-muted uppercase tracking-wider block">Private Key</label>
                                <div className="flex gap-2">
                                    <Input
                                        className="flex-1"
                                        readOnly
                                        placeholder="No key selected"
                                        value={formData.privateKeyPath ? formData.privateKeyPath.split(/[/\\]/).pop() : ''}
                                    />
                                    <Button onClick={async () => {
                                        try {
                                            const { filePaths, canceled } = await window.ipcRenderer.invoke('dialog:openFile');
                                            if (!canceled && filePaths.length > 0) {
                                                const importedPath = await window.ipcRenderer.invoke('ssh:importKey', filePaths[0]);
                                                setFormData({ ...formData, privateKeyPath: importedPath });
                                            }
                                        } catch (e) {
                                            console.error(e);
                                            alert('Failed to import key');
                                        }
                                    }}>Browse</Button>
                                </div>
                                <p className="text-[10px] text-app-muted/70">Selected key will be securely imported.</p>
                            </div>
                        )}
                    </div>

                    <div className="pt-4 border-t border-app-border">
                        <label className="text-xs font-semibold text-app-muted uppercase tracking-wider block mb-2">Jump Server (Optional)</label>
                        <select
                            className="w-full bg-app-bg border border-app-border rounded-md px-3 py-2 text-sm text-app-text focus:border-app-accent focus:outline-none appearance-none"
                            value={formData.jumpServerId || ''}
                            onChange={e => setFormData({ ...formData, jumpServerId: e.target.value === '' ? undefined : e.target.value })}
                        >
                            <option value="">None (Direct Connection)</option>
                            {connections.map(c => (
                                <option key={c.id} value={c.id}>
                                    {c.name || c.host} ({c.username}@{c.host})
                                </option>
                            ))}
                        </select>
                        <p className="text-[10px] text-app-muted/70 mt-1">Select a bastion host to route this connection through.</p>
                    </div>

                    <div className="pt-4 border-t border-app-border">
                        <label className="text-xs font-semibold text-app-muted uppercase tracking-wider block mb-2">Terminal Theme</label>
                        <div className="flex gap-3">
                            {[
                                { id: '', label: 'Default', color: 'bg-app-surface border-app-border' },
                                { id: 'red', label: 'Pro', color: 'bg-red-500/20 border-red-500' },
                                { id: 'blue', label: 'Dev', color: 'bg-blue-500/20 border-blue-500' },
                                { id: 'green', label: 'Test', color: 'bg-emerald-500/20 border-emerald-500' },
                                { id: 'orange', label: 'Stg', color: 'bg-orange-500/20 border-orange-500' },
                                { id: 'purple', label: 'App', color: 'bg-purple-500/20 border-purple-500' },
                            ].map(theme => (
                                <button
                                    key={theme.id}
                                    onClick={() => setFormData({ ...formData, theme: theme.id })}
                                    className={cn(
                                        "h-8 w-8 rounded-full border-2 transition-all flex items-center justify-center",
                                        theme.color,
                                        formData.theme === theme.id ? "ring-2 ring-white scale-110" : "opacity-70 hover:opacity-100 hover:scale-105"
                                    )}
                                    title={theme.label}
                                >
                                    {formData.theme === theme.id && <div className="w-2 h-2 rounded-full bg-white/80" />}
                                </button>
                            ))}
                        </div>
                    </div>

                    <div className="pt-4 border-t border-app-border">
                        <label className="text-xs font-semibold text-app-muted uppercase tracking-wider block mb-2">Tags</label>
                        <div className="space-y-3">
                            <div className="flex gap-2">
                                <Input
                                    placeholder="Add a tag..."
                                    className="flex-1"
                                    onKeyDown={(e) => {
                                        if (e.key === 'Enter') {
                                            const val = e.currentTarget.value.trim();
                                            if (val && !formData.tags?.includes(val)) {
                                                setFormData({ ...formData, tags: [...(formData.tags || []), val] });
                                                e.currentTarget.value = '';
                                            }
                                        }
                                    }}
                                />
                            </div>
                            <div className="flex flex-wrap gap-2">
                                {formData.tags?.map(tag => (
                                    <span key={tag} className="inline-flex items-center gap-1 px-2 py-1 rounded-md bg-app-surface border border-app-border text-xs font-medium text-app-text">
                                        {tag}
                                        <button
                                            onClick={() => setFormData({ ...formData, tags: formData.tags?.filter(t => t !== tag) })}
                                            className="hover:text-red-400 transition-colors"
                                        >
                                            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M18 6L6 18M6 6l12 12" /></svg>
                                        </button>
                                    </span>
                                ))}
                                {(!formData.tags || formData.tags.length === 0) && (
                                    <span className="text-xs text-app-muted italic">No tags added</span>
                                )}
                            </div>
                        </div>
                    </div>

                    <div className="flex justify-end gap-2 mt-4 pt-4 border-t border-app-border">
                        {!editingConnectionId && (
                            <Button variant="secondary" onClick={async () => {
                                if (confirm('Import connections from ~/.ssh/config? This will skip duplicates.')) {
                                    try {
                                        const configs = await window.ipcRenderer.invoke('ssh:readConfig');
                                        if (configs && configs.length > 0) {
                                            importConnections(configs);
                                            alert(`Imported ${configs.length} connections.`);
                                            closeAddConnectionModal();
                                        } else {
                                            alert('No connections found in config file.');
                                        }
                                    } catch (e: any) {
                                        console.error(e);
                                        alert('Failed to import config: ' + e.message);
                                    }
                                }
                            }} className="mr-auto whitespace-nowrap">
                                <FileText className="h-4 w-4 mr-2" />
                                Import Config
                            </Button>
                        )}
                        <Button variant="ghost" onClick={closeAddConnectionModal} className={editingConnectionId ? "ml-auto" : ""}>Cancel</Button>
                        <Button onClick={handleSave} className="whitespace-nowrap min-w-[80px]">
                            {editingConnectionId ? "Save Changes" : "Create"}
                        </Button>
                    </div>
                </div>
            </Modal>


            {/* Removed duplicate simple footer */}

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
            <AddTunnelModal
                isOpen={isAddTunnelModalOpen}
                onClose={() => setIsAddTunnelModalOpen(false)}
                initialConnectionId={activeConnectionId && activeConnectionId !== 'local' && activeConnectionId !== 'tunnels' ? activeConnectionId : undefined}
            />

            <ConnectionDetailsModal
                isOpen={!!viewingDetailsId}
                onClose={() => setViewingDetailsId(null)}
                connection={connections.find(c => c.id === viewingDetailsId) || null}
            />

            <SettingsModal isOpen={isSettingsOpen} onClose={closeSettings} />

            {/* Folder Context Menu */}
            {folderContextMenu && (
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
                                if (confirm(`Delete folder "${folderContextMenu.folderName}"? Connections will be ungrouped.`)) {
                                    deleteFolder(folderContextMenu.folderName);
                                }
                                setFolderContextMenu(null);
                            }
                        }
                    ]}
                />
            )}

            <RenameFolderModal
                isOpen={isRenameFolderModalOpen}
                onClose={() => setIsRenameFolderModalOpen(false)}
                currentName={folderToRename || ''}
                currentTags={folders.find(f => f.name === folderToRename)?.tags || []}
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
                        // @ts-ignore
                        renameFolder(folderToRename, newName, newTags);
                    }
                    setIsRenameFolderModalOpen(false);
                }}
            />
        </div>
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
function ConnectionItem({ conn, isCollapsed, onEdit, onViewDetails }: { conn: Connection; isCollapsed: boolean; onEdit: (c: Connection) => void; onViewDetails: (c: Connection) => void }) {
    const { activeConnectionId, openTab, connect, disconnect, deleteConnection, tabs } = useConnections();

    const hasTab = useMemo(() => tabs.some(t => t.connectionId === conn.id), [tabs, conn.id]);

    const { showToast } = useToast();
    const { addTransfer } = useTransfers();
    const [contextMenu, setContextMenu] = useState<{ x: number; y: number; connectionId: string } | null>(null);
    const [dropTargetId, setDropTargetId] = useState<string | null>(null);
    const { settings } = useSettings();
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
                    } catch (err) { }
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
                        <span className={cn(
                            "truncate font-semibold leading-tight transition-colors",
                            compactMode ? "text-sm" : "text-[15px]",
                            activeConnectionId === conn.id ? "text-app-accent" : "text-app-text/90 group-hover:text-[var(--color-app-text)]"
                        )}>
                            {conn.name || conn.host}
                        </span>
                        <span className={cn(
                            "truncate leading-tight group-hover:text-app-muted/80",
                            compactMode ? "text-[10px] mt-0" : "text-xs mt-0.5",
                            "text-app-muted/40 font-mono" // Mono and lighter
                        )}>
                            {conn.username}@{conn.host}
                        </span>

                    </div>
                )}

                {/* Hover Chevron (Subtle hint) */}
                {!isCollapsed && activeConnectionId !== conn.id && (
                    <div className="opacity-0 group-hover:opacity-100 transition-opacity -mr-1">
                        <div className="h-1.5 w-1.5 rounded-full bg-app-border/80" />
                    </div>
                )}
            </div>

            {/* Context Menu */}
            {
                contextMenu && (
                    <ContextMenu
                        x={contextMenu.x}
                        y={contextMenu.y}
                        items={[
                            {
                                label: conn.status === 'connected' ? "Disconnect" : "Connect",
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
                                action: () => onViewDetails(conn)
                            },
                            {
                                label: "Edit",
                                action: () => onEdit(conn)
                            },
                            {
                                label: "Delete",
                                variant: "danger",
                                action: () => {
                                    if (confirm('Are you sure you want to delete this connection?')) {
                                        deleteConnection(conn.id);
                                    }
                                }
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
                        onKeyDown={e => e.key === 'Enter' && onRename(name, tags)}
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

function FolderItem({
    node,
    isCollapsed,
    compactMode,
    expandedFolders,
    toggleFolder,
    updateConnectionFolder,
    deleteFolder,
    onRenameFolder,
    renameFolder, // Direct context action for DnD
    connectionItemProps
}: {
    node: TreeNode;
    isCollapsed: boolean;
    compactMode: boolean;
    expandedFolders: Set<string>;
    toggleFolder: (p: string) => void;
    updateConnectionFolder: (id: string, f: string) => void;
    deleteFolder: (f: string) => void;
    onRenameFolder: (f: string) => void;
    renameFolder: (oldName: string, newName: string) => void;
    connectionItemProps: { onEdit: any; onViewDetails: any }
}) {
    const isExpanded = expandedFolders.has(node.path);


    return (
        <div className={cn("select-none transition-all duration-200", isExpanded && isCollapsed && "bg-app-surface/30 rounded-2xl pb-1 mb-2 border border-app-border/20")}>
            <div
                className={cn(
                    "flex items-center group cursor-pointer transition-colors mb-1 rounded-lg relative select-none",
                    isCollapsed
                        ? "justify-center mx-auto w-10 h-10 hover:bg-app-surface/50 my-1"
                        : cn(compactMode ? "px-2 py-1 text-xs gap-2" : "px-4 py-1.5 text-sm gap-2", "text-app-muted hover:text-app-text hover:bg-app-surface/30")
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
                    // Prevent dropping parent into child or self
                    // We need to know what we are dragging. If it's a folder, check for cycles.
                    // This is hard to check in dragOver without storing "draggingFolder" in state.
                    // For now, just allow drop visual, and validate in onDrop.
                    e.currentTarget.classList.add('bg-app-accent/10');
                }}
                onDragLeave={(e) => {
                    e.currentTarget.classList.remove('bg-app-accent/10');
                }}
                onDrop={(e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    e.currentTarget.classList.remove('bg-app-accent/10');

                    const connId = e.dataTransfer.getData('connection-id');
                    const srcFolderPath = e.dataTransfer.getData('folder-path');

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
                        renameFolder(srcFolderPath, newName);
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
                                    if (confirm(`Delete folder "${node.name}"?`)) {
                                        deleteFolder(node.path);
                                    }
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
                                deleteFolder={deleteFolder}
                                onRenameFolder={onRenameFolder}
                                renameFolder={renameFolder}
                                connectionItemProps={connectionItemProps}
                            />
                        ))}
                        {node.connections.map(conn => (
                            <ConnectionItem
                                key={conn.id}
                                conn={conn}
                                isCollapsed={isCollapsed}
                                onEdit={connectionItemProps.onEdit}
                                onViewDetails={connectionItemProps.onViewDetails}
                            />
                        ))}
                    </div>
                )
            }
        </div >
    );
}
