import { useState, useCallback, useEffect, useRef } from 'react';
import { useConnections, Connection } from '../../context/ConnectionContext';
import { useTransfers } from '../../context/TransferContext';
import { getCurrentDragSource } from '../file-manager/FileGrid';
import { useToast } from '../../context/ToastContext';
import { useSettings } from '../../context/SettingsContext';
import { Plus, Search, Server, PanelLeftClose, PanelLeftOpen, FileText, Terminal, Database, Monitor, Cloud, Box, HardDrive, Globe, Code, Folder as FolderIcon, FolderOpen, ChevronRight, FolderPlus, Settings } from 'lucide-react';
import { cn } from '../../lib/utils';
import { Button } from '../ui/Button';
import { Modal } from '../ui/Modal';
import { Input } from '../ui/Input';
import { SettingsModal } from '../settings/SettingsModal';
import { ContextMenu } from '../ui/ContextMenu';

import { ConnectionDetailsModal } from '../modals/ConnectionDetailsModal';

export function Sidebar() {
    const [viewingDetailsId, setViewingDetailsId] = useState<string | null>(null);
    const { connections, activeConnectionId, addConnection, editConnection, importConnections, openTab, folders, addFolder, updateConnectionFolder, deleteFolder, isAddConnectionModalOpen, openAddConnectionModal, closeAddConnectionModal } = useConnections();
    const { settings, updateSettings, isSettingsOpen, openSettings, closeSettings } = useSettings();
    const compactMode = settings.compactMode;
    // const [isAddModalOpen, setIsAddModalOpen] = useState(false); // Moved to context
    const [isFolderModalOpen, setIsFolderModalOpen] = useState(false); // State for Create Folder Modal
    const [searchTerm, setSearchTerm] = useState('');
    // const [isCollapsed, setIsCollapsed] = useState(false); // Moved to Settings
    const isCollapsed = settings.sidebarCollapsed;

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

    // Form State
    const [formData, setFormData] = useState<Partial<Connection>>({
        name: '', host: '', username: '', port: 22, password: '', privateKeyPath: '', jumpServerId: undefined, icon: 'Server', folder: '', theme: ''
    });
    const [authMethod, setAuthMethod] = useState<'password' | 'key'>('password');
    const [editingConnectionId, setEditingConnectionId] = useState<string | null>(null);

    // Reset when modal closes
    useEffect(() => {
        if (!isAddConnectionModalOpen) {
            setEditingConnectionId(null);
            setFormData({ name: '', host: '', username: '', port: 22, password: '', privateKeyPath: '', jumpServerId: undefined, icon: 'Server', folder: '', theme: '' });
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
            folder: formData.folder
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
            theme: conn.theme
        });
        setAuthMethod(conn.privateKeyPath ? 'key' : 'password');
        openAddConnectionModal();
    };

    const [expandedFolders, setExpandedFolders] = useState<Set<string>>(new Set());

    // Group connections by folder
    const normalizedSearch = searchTerm.toLowerCase();

    // 1. Get connections that match directly
    const matchingConnections = connections.filter(c =>
        (c.name || c.host).toLowerCase().includes(normalizedSearch)
    );

    // 2. Get folders that match directly
    const matchingFolders = folders.filter(f => f.toLowerCase().includes(normalizedSearch));

    // 3. Include connections from matching folders
    const folderMatchingConnections = connections.filter(c =>
        c.folder && matchingFolders.includes(c.folder)
    );

    // Combine unique connections
    const combinedConnections = Array.from(new Set([...matchingConnections, ...folderMatchingConnections]));

    const groupedConnections = combinedConnections.reduce((acc, conn) => {
        const folder = conn.folder || 'ungrouped';
        if (!acc[folder]) acc[folder] = [];
        acc[folder].push(conn);
        return acc;
    }, {} as Record<string, Connection[]>);

    // Ensure matching folders exist in the map even if they have no connections (for search visibility)
    if (normalizedSearch) {
        matchingFolders.forEach(f => {
            if (!groupedConnections[f]) {
                groupedConnections[f] = [];
            }
        });
    } else {
        // If no search, ensure all explicit folders exist
        folders.forEach(f => {
            if (!groupedConnections[f]) {
                groupedConnections[f] = [];
            }
        });
    }

    const toggleFolder = (folderName: string) => {
        const newSet = new Set(expandedFolders);
        if (newSet.has(folderName)) {
            newSet.delete(folderName);
        } else {
            newSet.add(folderName);
        }
        setExpandedFolders(newSet);
    };

    // Auto-expand folder if search term is active
    useEffect(() => {
        if (searchTerm) {
            const allFolders = Object.keys(groupedConnections).filter(f => f !== 'ungrouped');
            setExpandedFolders(new Set(allFolders));
        }
    }, [searchTerm]);

    return (
        <div
            ref={sidebarRef}
            className={cn(
                "bg-app-panel/95 backdrop-blur-xl border-r border-app-border/50 flex flex-col h-full shrink-0 relative z-50 pt-3",
                // Only use transition when NOT resizing to ensure smooth drag
                !isResizing && "transition-all duration-300 ease-in-out"
            )}
            style={{ width: isCollapsed ? 80 : width }}
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
                compactMode ? "h-10" : "h-16",
                "flex items-center shrink-0",
                compactMode ? "mb-2" : "mb-4",
                isCollapsed ? "justify-center px-2" : compactMode ? "justify-between px-3" : "justify-between px-6"
            )} style={{ WebkitAppRegion: 'drag' } as any}>
                {!isCollapsed && (
                    <div className="flex items-center gap-3">
                        <svg width={compactMode ? "24" : "32"} height={compactMode ? "24" : "32"} viewBox="0 0 512 512" fill="none" xmlns="http://www.w3.org/2000/svg" className="shrink-0">
                            <rect width="512" height="512" rx="128" className="fill-app-accent/10" />
                            <path d="M128 170.667L213.333 256L128 341.333" className="stroke-app-accent" strokeWidth="64" strokeLinecap="round" strokeLinejoin="round" />
                            <path d="M256 341.333H384" className="stroke-app-text" strokeWidth="64" strokeLinecap="round" strokeLinejoin="round" />
                        </svg>
                        <div className="flex flex-col">
                            <span className="text-sm font-bold text-app-text tracking-wide">Hosts</span>
                            <span className="text-[10px] uppercase font-semibold text-app-accent/80 tracking-widest mt-0.5">Explorer</span>
                        </div>
                    </div>
                )}

                <div className="flex items-center gap-2" style={{ WebkitAppRegion: 'no-drag' } as any}>
                    {!isCollapsed && (
                        <>
                            <div className="relative group">
                                <div className="absolute inset-0 bg-app-accent/20 blur-md rounded-full opacity-0 group-hover:opacity-100 transition-opacity" />
                                <Button variant="ghost" size="icon" onClick={openAddConnectionModal} className="relative h-8 w-8 text-app-accent hover:bg-app-accent hover:text-white rounded-full transition-all duration-300" title="New Connection">
                                    <Plus className="h-5 w-5" />
                                </Button>
                            </div>
                            <Button
                                variant="ghost"
                                size="icon"
                                onClick={() => setIsFolderModalOpen(true)}
                                className="h-8 w-8 text-app-muted hover:text-[var(--color-app-text)] transition-colors"
                                title="New Folder"
                            >
                                <FolderPlus className="h-4 w-4" />
                            </Button>
                        </>
                    )}
                    <Button variant="ghost" size="icon" onClick={() => updateSettings({ sidebarCollapsed: !isCollapsed })} className="h-8 w-8 text-app-muted hover:text-[var(--color-app-text)] transition-colors">
                        {isCollapsed ? <PanelLeftOpen className="h-5 w-5" /> : <PanelLeftClose className="h-5 w-5" />}
                    </Button>
                </div>
            </div>

            {/* Collapsed Add Button */}
            {isCollapsed && (
                <div className="flex justify-center mb-4 px-2">
                    <Button variant="ghost" size="icon" onClick={openAddConnectionModal} className="h-10 w-10 text-app-accent bg-app-accent/10 hover:bg-app-accent hover:text-white rounded-xl transition-all shadow-sm" style={{ WebkitAppRegion: 'no-drag' } as any}>
                        <Plus className="h-5 w-5" />
                    </Button>
                </div>
            )}

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
                            placeholder="Type to search..."
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

            {/* List */}
            <div className={cn(
                "flex-1 overflow-y-auto pb-4 scrollbar-hide",
                compactMode ? "px-2 space-y-0.5" : "px-3 space-y-2"
            )}>
                {/* Local Terminal Item */}
                <div
                    className={cn(
                        "group relative flex items-center transition-all cursor-pointer border select-none",
                        isCollapsed
                            ? "justify-center p-2 rounded-xl mx-auto w-12 h-12"
                            : compactMode
                                ? "gap-2 p-1.5 rounded-lg mx-1"
                                : "gap-3 p-3 rounded-xl mx-2",
                        "border-transparent hover:bg-app-surface/50",
                        activeConnectionId === 'local'
                            ? "bg-app-accent/5"
                            : "text-app-muted hover:text-[var(--color-app-text)]"
                    )}
                    onClick={() => openTab('local')}
                    title="Open Local Terminal"
                >
                    {activeConnectionId === 'local' && (
                        <div className="absolute left-0 top-1/2 -translate-y-1/2 h-6 w-1 bg-app-accent shadow-[0_0_12px_rgba(var(--color-app-accent),0.6)] rounded-r-full" />
                    )}
                    <div className={cn(
                        "relative flex items-center justify-center rounded-lg transition-all duration-300",
                        isCollapsed ? "w-8 h-8" : compactMode ? "w-7 h-7" : "w-10 h-10",
                        activeConnectionId === 'local' ? "bg-app-accent/10 text-app-accent" : "bg-app-surface text-app-muted group-hover:text-app-accent"
                    )}>
                        <Terminal className={compactMode ? "w-4 h-4" : "w-5 h-5"} />
                    </div>

                    {!isCollapsed && (
                        <div className="flex flex-col overflow-hidden">
                            <span className={cn(
                                "font-medium truncate transition-colors duration-200",
                                activeConnectionId === 'local' ? "text-app-accent" : "text-app-text group-hover:text-[var(--color-app-text)]"
                            )}>
                                Local Terminal
                            </span>
                            <span className="text-xs text-app-muted/60 truncate group-hover:text-app-muted/80">
                                This Computer
                            </span>
                        </div>
                    )}
                </div>

                {/* Divider if needed, or just space */}
                <div className="h-px bg-app-border/30 mx-4 my-2" />

                {/* Render Folders First */}
                {Object.keys(groupedConnections).sort().filter(key => key !== 'ungrouped').map(folderName => {
                    const isExpanded = expandedFolders.has(folderName);
                    return (
                        <div
                            key={folderName}
                            className={cn(
                                "select-none transition-all duration-200",
                                isExpanded && isCollapsed && "bg-app-surface/30 rounded-2xl pb-1 mb-2 border border-app-border/20"
                            )}
                        >
                            {/* Folder Header */}
                            <div
                                className={cn(
                                    "flex items-center group cursor-pointer transition-colors mb-1 rounded-lg relative select-none",
                                    isCollapsed
                                        ? "justify-center mx-auto w-10 h-10 hover:bg-app-surface/50 my-1"
                                        : cn(compactMode ? "px-2 py-1 text-xs gap-2" : "px-4 py-1.5 text-sm gap-2", "text-app-muted hover:text-app-text hover:bg-app-surface/30")
                                )}
                                onClick={() => toggleFolder(folderName)}
                                onDragOver={(e) => {
                                    e.preventDefault();
                                    e.currentTarget.classList.add('bg-app-accent/10');
                                }}
                                onDragLeave={(e) => {
                                    e.currentTarget.classList.remove('bg-app-accent/10');
                                }}
                                onDrop={(e) => {
                                    e.preventDefault();
                                    e.currentTarget.classList.remove('bg-app-accent/10');
                                    const connId = e.dataTransfer.getData('connection-id');
                                    if (connId) {
                                        updateConnectionFolder(connId, folderName);
                                    }
                                }}
                            >
                                {isCollapsed ? (
                                    <div className={cn(
                                        "flex items-center justify-center w-8 h-8 rounded-lg border text-app-muted font-bold shadow-sm transition-all",
                                        isExpanded
                                            ? "bg-app-accent/20 border-app-accent/50 text-app-accent shadow-md"
                                            : "bg-app-surface/50 border-app-border/30 group-hover:border-app-accent/30 group-hover:text-app-text"
                                    )} title={folderName}>
                                        {folderName.charAt(0).toUpperCase()}
                                    </div>
                                ) : (
                                    <>
                                        <div className={cn("transition-transform duration-200", isExpanded ? "rotate-90" : "")}>
                                            <ChevronRight size={compactMode ? 12 : 14} />
                                        </div>
                                        {isExpanded ? <FolderOpen size={compactMode ? 14 : 16} className="text-app-accent/80" /> : <FolderIcon size={compactMode ? 14 : 16} />}
                                        <span className="font-semibold truncate flex-1">{folderName}</span>
                                        <span className="ml-auto text-[10px] opacity-0 group-hover:opacity-60 mr-2">{groupedConnections[folderName].length}</span>

                                        <Button
                                            variant="ghost"
                                            size="icon"
                                            className="h-5 w-5 opacity-0 group-hover:opacity-100 transition-opacity hover:text-red-400"
                                            onClick={(e) => {
                                                e.stopPropagation();
                                                if (confirm(`Delete folder "${folderName}"? Connections will be ungrouped.`)) {
                                                    deleteFolder(folderName);
                                                }
                                            }}
                                        >
                                            <PanelLeftClose className="h-3 w-3 rotate-45" />
                                        </Button>
                                    </>
                                )}
                            </div>

                            {/* Folder Contents */}
                            {isExpanded && (
                                <div className={cn(
                                    "space-y-1",
                                    !isCollapsed && "border-l border-app-border/30 ml-4 pl-1",
                                    compactMode ? "mb-1" : "mb-2",
                                    isCollapsed && "flex flex-col items-center gap-1"
                                )}>
                                    {groupedConnections[folderName].map(conn => (
                                        <ConnectionItem
                                            key={conn.id}
                                            conn={conn}
                                            isCollapsed={isCollapsed}
                                            onEdit={openEditConnection}
                                            onViewDetails={c => setViewingDetailsId(c.id)}
                                        />
                                    ))}
                                    {isCollapsed && (
                                        // Small connector line at the bottom to close the group visually? Or just spacing.
                                        <div className="w-0.5 h-2 bg-app-border/20 rounded-full" />
                                    )}
                                </div>
                            )}
                        </div>
                    );
                })}

                {/* Render Ungrouped Connections */}
                {groupedConnections['ungrouped'] && groupedConnections['ungrouped'].map(conn => (
                    <ConnectionItem
                        key={conn.id}
                        conn={conn}
                        isCollapsed={isCollapsed}
                        onEdit={openEditConnection}
                        onViewDetails={c => setViewingDetailsId(c.id)}
                    />
                ))}
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
                                <option key={f} value={f} />
                            ))}
                        </datalist>
                    </div>

                    <div className="pt-2">
                        <label className="text-xs font-semibold text-app-muted uppercase tracking-wider block mb-2">Icon</label>
                        <div className="flex gap-2 flex-wrap">
                            {['Server', 'Database', 'Cloud', 'Terminal', 'Code', 'Box', 'Monitor', 'Globe', 'HardDrive'].map(iconName => {
                                const IconMap: any = { Server, Database, Cloud, Terminal, Code, Box, Monitor, Globe, HardDrive };
                                const I = IconMap[iconName];
                                const isSelected = (formData.icon || 'Server') === iconName;
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
                                        <I size={18} />
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
                onCreate={(name) => {
                    addFolder(name);
                    setIsFolderModalOpen(false);
                }}
            />

            <ConnectionDetailsModal
                isOpen={!!viewingDetailsId}
                onClose={() => setViewingDetailsId(null)}
                connection={connections.find(c => c.id === viewingDetailsId) || null}
            />

            <SettingsModal isOpen={isSettingsOpen} onClose={closeSettings} />
        </div>
    );
}

function CreateFolderModal({ isOpen, onClose, onCreate }: { isOpen: boolean; onClose: () => void; onCreate: (name: string) => void }) {
    const [name, setName] = useState('');

    useEffect(() => {
        if (isOpen) setName('');
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
                            if (e.key === 'Enter' && name) onCreate(name);
                        }}
                    />

                    <div className="grid grid-cols-2 gap-3 pt-2">
                        <Button
                            variant="ghost"
                            onClick={onClose}
                            className="w-full hover:bg-app-surface text-app-muted hover:text-app-text"
                        >
                            Cancel
                        </Button>
                        <Button
                            onClick={() => name && onCreate(name)}
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
    const { activeConnectionId, openTab, connect, disconnect, deleteConnection } = useConnections();


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
                    "relative shrink-0 rounded-xl flex items-center justify-center transition-all duration-300",
                    compactMode ? "h-7 w-7" : "h-10 w-10",
                    activeConnectionId === conn.id
                        ? "bg-app-accent/10 text-app-accent"
                        : "bg-app-surface border border-app-border/50 group-hover:border-app-accent/30 group-hover:bg-app-surface/80"
                )}>
                    {(() => {
                        const IconMap: any = { Server, Database, Monitor, Cloud, Box, HardDrive, Globe, Code, Terminal };
                        const IconComp = IconMap[conn.icon || 'Server'] || Server;
                        return <IconComp size={compactMode ? 16 : 18} className={cn(
                            "transition-transform duration-500",
                            activeConnectionId === conn.id ? "text-app-accent" : "text-app-muted group-hover:text-[var(--color-app-text)] group-hover:scale-110"
                        )} />;
                    })()}

                    {/* Status Dot */}
                    {conn.status === 'connected' && (
                        <div className="absolute -bottom-1 -right-1 h-3 w-3 rounded-full bg-app-success border-2 border-app-panel shadow-sm animate-pulse-slow" />
                    )}
                </div>

                {!isCollapsed && (
                    <div className="flex flex-col overflow-hidden min-w-0 flex-1">
                        <span className={cn(
                            "truncate font-semibold leading-tight transition-colors",
                            compactMode ? "text-xs" : "text-sm",
                            activeConnectionId === conn.id ? "text-app-accent" : "text-app-text/90 group-hover:text-[var(--color-app-text)]"
                        )}>
                            {conn.name || conn.host}
                        </span>
                        <span className={cn(
                            "truncate leading-tight group-hover:text-app-muted/80",
                            compactMode ? "text-[10px] mt-0" : "text-xs mt-0.5",
                            "text-app-muted/60"
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
