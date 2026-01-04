import { useState } from 'react';
import { useConnections, Connection } from '../../context/ConnectionContext';
import { useTransfers } from '../../context/TransferContext';
import { getCurrentDragSource } from '../file-manager/FileGrid';
import { useToast } from '../../context/ToastContext';
import { Plus, Search, Server, PanelLeftClose, PanelLeftOpen, FileText, Terminal, Settings, Database, Monitor, Cloud, Box, HardDrive, Globe, Code } from 'lucide-react';
import { cn } from '../../lib/utils';
import { Button } from '../ui/Button';
import { Modal } from '../ui/Modal';
import { Input } from '../ui/Input';
import { SettingsModal } from '../settings/SettingsModal';
import { ContextMenu, type ContextMenuItem } from '../ui/ContextMenu';



export function Sidebar() {
    const { connections, activeConnectionId, addConnection, deleteConnection, openTab, connect, disconnect, importConnections } = useConnections();
    const { addTransfer } = useTransfers();
    const { showToast } = useToast();
    const [isAddModalOpen, setIsAddModalOpen] = useState(false);
    const [isSettingsOpen, setIsSettingsOpen] = useState(false);
    const [searchTerm, setSearchTerm] = useState('');
    const [isCollapsed, setIsCollapsed] = useState(false);
    const [dropTargetId, setDropTargetId] = useState<string | null>(null);
    const [contextMenu, setContextMenu] = useState<{ x: number; y: number; connectionId: string } | null>(null);

    // Form State
    const [formData, setFormData] = useState<Partial<Connection>>({
        name: '', host: '', username: '', port: 22, password: '', privateKeyPath: ''
    });
    const [authMethod, setAuthMethod] = useState<'password' | 'key'>('password');

    const handleSave = () => {
        if (!formData.host || !formData.username) return;
        addConnection({
            id: Math.random().toString(36).substr(2, 9),
            name: formData.name || formData.host,
            host: formData.host!,
            username: formData.username!,
            port: formData.port || 22,
            password: formData.password,
            privateKeyPath: formData.privateKeyPath,
            status: 'disconnected',
            jumpServerId: formData.jumpServerId,
            icon: formData.icon
        } as Connection);
        setIsAddModalOpen(false);
        setFormData({ name: '', host: '', username: '', port: 22, password: '', privateKeyPath: '', jumpServerId: undefined, icon: 'Server' });
    };

    const filteredConnections = connections.filter(c =>
        (c.name || c.host).toLowerCase().includes(searchTerm.toLowerCase())
    );

    return (
        <div className={cn(
            "bg-app-panel/95 backdrop-blur-xl border-r border-app-border/50 flex flex-col h-full shrink-0 transition-all duration-300 ease-in-out relative z-50",
            isCollapsed ? "w-20" : "w-72"
        )}>
            {/* Header */}
            {/* Header */}
            <div className={cn(
                "h-16 flex items-center shrink-0 mb-4",
                isCollapsed ? "justify-center px-2" : "justify-between px-6"
            )} style={{ WebkitAppRegion: 'drag' } as any}>
                {!isCollapsed && (
                    <div className="flex items-center gap-3">
                        <svg width="32" height="32" viewBox="0 0 512 512" fill="none" xmlns="http://www.w3.org/2000/svg" className="shrink-0">
                             <rect width="512" height="512" rx="128" className="fill-app-accent/10" />
                             <path d="M128 170.667L213.333 256L128 341.333" className="stroke-app-accent" strokeWidth="64" strokeLinecap="round" strokeLinejoin="round"/>
                             <path d="M256 341.333H384" className="stroke-app-text" strokeWidth="64" strokeLinecap="round" strokeLinejoin="round"/>
                        </svg>
                        <div className="flex flex-col">
                            <span className="text-sm font-bold text-app-text tracking-wide">Hosts</span>
                            <span className="text-[10px] uppercase font-semibold text-app-accent/80 tracking-widest mt-0.5">Explorer</span>
                        </div>
                    </div>
                )}

                <div className="flex items-center gap-2" style={{ WebkitAppRegion: 'no-drag' } as any}>
                    {!isCollapsed && (
                        <div className="relative group">
                            <div className="absolute inset-0 bg-app-accent/20 blur-md rounded-full opacity-0 group-hover:opacity-100 transition-opacity" />
                            <Button variant="ghost" size="icon" onClick={() => setIsAddModalOpen(true)} className="relative h-8 w-8 text-app-accent hover:bg-app-accent hover:text-white rounded-full transition-all duration-300">
                                <Plus className="h-5 w-5" />
                            </Button>
                        </div>
                    )}
                    <Button variant="ghost" size="icon" onClick={() => setIsCollapsed(!isCollapsed)} className="h-8 w-8 text-app-muted hover:text-[var(--color-app-text)] transition-colors">
                        {isCollapsed ? <PanelLeftOpen className="h-5 w-5" /> : <PanelLeftClose className="h-5 w-5" />}
                    </Button>
                </div>
            </div>

            {/* Collapsed Add Button */}
            {isCollapsed && (
                <div className="flex justify-center mb-4">
                    <Button variant="ghost" size="icon" onClick={() => setIsAddModalOpen(true)} className="h-10 w-10 text-app-accent bg-app-accent/10 hover:bg-app-accent hover:text-white rounded-xl transition-all" style={{ WebkitAppRegion: 'no-drag' } as any}>
                        <Plus className="h-5 w-5" />
                    </Button>
                </div>
            )}

            {/* Search */}
            {!isCollapsed && (
                <div className="px-5 mb-6">
                    <div className="relative group">
                        <Search className="absolute left-3 top-2.5 h-4 w-4 text-app-muted group-focus-within:text-app-accent transition-colors" />
                        <input
                            className="w-full bg-app-surface/50 border border-app-border/50 rounded-xl px-3 py-2 pl-10 text-sm text-app-text focus:border-app-accent/50 focus:ring-2 focus:ring-app-accent/20 focus:outline-none placeholder:text-app-muted/40 transition-all font-medium"
                            placeholder="Search hosts..."
                            value={searchTerm}
                            onChange={e => setSearchTerm(e.target.value)}
                        />
                    </div>
                </div>
            )}

            {/* List */}
            <div className="flex-1 overflow-y-auto px-3 pb-4 space-y-2 scrollbar-hide">
                {/* Local Terminal Item */}
                <div
                    className={cn(
                        "group relative flex items-center transition-all cursor-pointer border select-none",
                        isCollapsed
                            ? "justify-center p-2 rounded-xl mx-auto w-12 h-12"
                            : "gap-3 p-3 rounded-xl mx-2",
                        "border-transparent hover:bg-app-surface/50",
                        activeConnectionId === 'local'
                            ? "bg-gradient-to-r from-app-accent/10 to-transparent border-app-accent/20 shadow-[0_0_15px_rgba(99,102,241,0.15)]"
                            : "text-app-muted hover:text-[var(--color-app-text)]"
                    )}
                    onClick={() => openTab('local')}
                    title="Open Local Terminal"
                >
                    <div className={cn(
                        "relative flex items-center justify-center rounded-lg transition-all duration-300",
                        isCollapsed ? "w-8 h-8" : "w-10 h-10",
                        activeConnectionId === 'local' ? "bg-app-accent text-white shadow-lg shadow-app-accent/30 scale-105" : "bg-app-surface text-app-muted group-hover:text-app-accent group-hover:scale-110"
                    )}>
                        <Terminal className="w-5 h-5" />
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

                {filteredConnections.map(conn => (
                    <div
                        key={conn.id}
                        className={cn(
                            "group relative flex items-center transition-all cursor-pointer border select-none",
                            // Layout & Spacing
                            isCollapsed
                                ? "justify-center p-2 rounded-xl mx-auto w-12 h-12"
                                : "gap-3 p-3 rounded-xl mx-2",
                            // Default State
                            "border-transparent hover:bg-app-surface/50",
                            // Active State (Clean Pill)
                            activeConnectionId === conn.id
                                ? "bg-gradient-to-r from-app-accent/10 to-transparent border-app-accent/20"
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
                            // Can drag to drop on other folders? For now just visual or for future 'organization' features
                            // We don't have folders yet, so maybe disable drag unless dragging AS a file source?
                            // Actually, let's keep it disabled for now to avoid confusion with file dragging.
                            e.preventDefault();
                        }}
                        // ... drop handlers remain the same ...
                        onDragOver={(e) => {
                            const dragSource = getCurrentDragSource();
                            if (dragSource && dragSource.connectionId !== conn.id && conn.status === 'connected') {
                                e.preventDefault();
                                setDropTargetId(conn.id);
                            }
                        }}
                        onDragLeave={() => setDropTargetId(null)}
                        onDrop={async (e) => {
                            // ... existing drop logic ...
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

                                        // Start transfer
                                        const transferId = addTransfer({
                                            sourceConnectionId: dragData.connectionId,
                                            sourcePath: dragData.path,
                                            destinationConnectionId: conn.id,
                                            destinationPath: destPath
                                        });

                                        showToast('info', `Copying to ${conn.name || conn.host}...`);

                                        // Execute in background
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
                            <div className="absolute left-0 top-3 bottom-3 w-1 rounded-r-lg bg-app-accent" />
                        )}

                        {/* Icon */}
                        <div className={cn(
                            "relative shrink-0 h-10 w-10 rounded-xl flex items-center justify-center transition-all duration-300",
                            activeConnectionId === conn.id
                                ? "bg-app-accent text-white shadow-md shadow-app-accent/20 scale-105"
                                : "bg-app-surface border border-app-border/50 group-hover:border-app-accent/30 group-hover:bg-app-surface/80"
                        )}>
                            {(() => {
                                const IconMap: any = { Server, Database, Monitor, Cloud, Box, HardDrive, Globe, Code, Terminal };
                                const IconComp = IconMap[conn.icon || 'Server'] || Server;
                                return <IconComp size={18} className={cn(
                                    "transition-transform duration-500",
                                    activeConnectionId === conn.id ? "text-white" : "text-app-muted group-hover:text-[var(--color-app-text)] group-hover:scale-110"
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
                                    "truncate font-semibold text-sm leading-tight transition-colors",
                                    activeConnectionId === conn.id ? "text-app-accent" : "text-app-text/90 group-hover:text-[var(--color-app-text)]"
                                )}>
                                    {conn.name || conn.host}
                                </span>
                                <span className="truncate text-xs text-app-muted/60 leading-tight mt-0.5 group-hover:text-app-muted/80">
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
                ))}
            </div>

            {/* Footer / User */}
            <div className={cn("p-4 border-t border-app-border/30 backdrop-blur-md bg-app-panel/50", isCollapsed && "p-2")}>
                <button
                    onClick={() => setIsSettingsOpen(true)}
                    className={cn(
                        "flex items-center gap-3 w-full p-2.5 rounded-xl transition-all duration-200 group",
                        "hover:bg-app-surface/80 border border-transparent hover:border-app-border/50",
                        isCollapsed && "justify-center p-0 h-12 w-12 rounded-2xl bg-app-surface/30"
                    )}
                >
                    <div className="h-8 w-8 rounded-lg bg-gradient-to-br from-indigo-500 to-purple-600 flex items-center justify-center shrink-0 shadow-lg shadow-indigo-500/20 group-hover:shadow-indigo-500/40 transition-shadow">
                        <span className="text-xs font-bold text-white">OP</span>
                    </div>
                    {!isCollapsed && (
                        <div className="flex-1 text-left overflow-hidden">
                            <div className="text-sm font-semibold text-app-text group-hover:text-[var(--color-app-text)] transition-colors">Operator</div>
                            <div className="text-[10px] text-app-muted uppercase tracking-wider">Settings</div>
                        </div>
                    )}
                </button>
            </div>

            {/* Modals */}
            <Modal isOpen={isAddModalOpen} onClose={() => setIsAddModalOpen(false)} title="New Connection">
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
                         <label className="text-xs font-semibold text-app-muted uppercase tracking-wider block mb-2">Icon</label>
                         <div className="flex gap-2 flex-wrap">
                             {['Server', 'Database', 'Cloud', 'Terminal', 'Code', 'Box', 'Monitor', 'Globe'].map(iconName => {
                                 const IconMap: any = { Server, Database, Cloud, Terminal, Code, Box, Monitor, Globe };
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

                    <div className="flex justify-end gap-2 mt-4 pt-4 border-t border-app-border">
                        <Button variant="secondary" onClick={async () => {
                            if (confirm('Import connections from ~/.ssh/config? This will skip duplicates.')) {
                                try {
                                    const configs = await window.ipcRenderer.invoke('ssh:readConfig');
                                    if (configs && configs.length > 0) {
                                        importConnections(configs);
                                        alert(`Imported ${configs.length} connections.`);
                                        setIsAddModalOpen(false);
                                    } else {
                                        alert('No connections found in config file.');
                                    }
                                } catch (e: any) {
                                    console.error(e);
                                    alert('Failed to import config: ' + e.message);
                                }
                            }
                        }} className="mr-auto">
                            <FileText className="h-4 w-4 mr-2" />
                            Import Config
                        </Button>
                        <Button variant="ghost" onClick={() => setIsAddModalOpen(false)}>Cancel</Button>
                        <Button onClick={handleSave}>Create</Button>
                    </div>
                </div>
            </Modal>

            {/* Context Menu */}
            {contextMenu && (() => {
                const conn = connections.find(c => c.id === contextMenu.connectionId);
                if (!conn) return null;

                const items: ContextMenuItem[] = [
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
                        label: "Properties",
                        action: () => alert('Properties not implemented yet')
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
                ];

                return (
                    <ContextMenu
                        x={contextMenu.x}
                        y={contextMenu.y}
                        items={items}
                        onClose={() => setContextMenu(null)}
                    />
                );
            })()}
            {/* Footer */}
            <div className={cn(
                "p-4 border-t border-app-border/30 mt-auto",
                isCollapsed ? "flex justify-center" : ""
            )}>
                <Button
                    variant="ghost"
                    className={cn(
                        "w-full flex items-center gap-3 text-app-muted hover:text-white transition-colors",
                        isCollapsed ? "justify-center px-0 py-2 h-auto" : "justify-start px-3 py-2"
                    )}
                    onClick={() => setIsSettingsOpen(true)}
                >
                    <Settings className="h-5 w-5" />
                    {!isCollapsed && <span>Settings</span>}
                </Button>
            </div>

            <SettingsModal isOpen={isSettingsOpen} onClose={() => setIsSettingsOpen(false)} />
        </div>
    );
}
