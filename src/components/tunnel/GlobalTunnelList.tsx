import { useEffect, useState } from 'react';
import { useAppStore } from '../../store/useAppStore';
import { Button } from '../ui/Button';
import { Modal } from '../ui/Modal';
import { cn } from '../../lib/utils';
import { ExternalLink, ArrowRight, Plus, Network, Trash2 } from 'lucide-react';
import { AddTunnelModal } from '../modals/AddTunnelModal';
import { OSIcon } from '../icons/OSIcon';

interface TunnelConfig {
    id: string;
    connectionId: string;
    name: string;
    type: 'local' | 'remote';
    localPort: number;
    remoteHost: string;
    remotePort: number;
    bindToAny?: boolean;
    status: 'active' | 'error' | 'stopped';
    autoStart?: boolean;
    error?: string;
    originalPort?: number; // Tracks original port when auto-switched
}

export function GlobalTunnelList() {
    const connections = useAppStore(state => state.connections);
    const connect = useAppStore(state => state.connect);

    const showToast = useAppStore((state) => state.showToast);
    const [tunnels, setTunnels] = useState<TunnelConfig[]>([]);
    const [searchQuery, setSearchQuery] = useState('');
    const [loading, setLoading] = useState(false);
    const [isAddModalOpen, setIsAddModalOpen] = useState(false);
    const [editingTunnel, setEditingTunnel] = useState<TunnelConfig | null>(null);
    const [initialConnectionId, setInitialConnectionId] = useState<string | undefined>(undefined);

    // Port suggestion dialog state
    const [portSuggestion, setPortSuggestion] = useState<{
        tunnel: TunnelConfig;
        currentPort: number;
        suggestedPort: number;
    } | null>(null);
    const [customPort, setCustomPort] = useState<string>(''); // For custom port input

    const disconnect = useAppStore(state => state.disconnect);
    const tabs = useAppStore(state => state.tabs);
    const terminals = useAppStore(state => state.terminals);

    const loadTunnels = async () => {
        setLoading(true);
        try {
            const list = await window.ipcRenderer.invoke('tunnel:getAll');
            setTunnels(list);
        } catch (error) {
            console.error('Failed to load global tunnels', error);
        } finally {
            setLoading(false);
        }
    };

    useEffect(() => {
        loadTunnels();

        const handleStatusChange = (_: any, { id, status, error }: any) => {
            setTunnels(prev => prev.map(t => t.id === id ? { ...t, status: status, error } : t));
        };

        window.ipcRenderer.on('tunnel:status-change', handleStatusChange);

        const interval = setInterval(loadTunnels, 30000);
        return () => {
            clearInterval(interval);
            window.ipcRenderer.off('tunnel:status-change', handleStatusChange);
        };
    }, []);

    const filteredTunnels = tunnels.filter(t => {
        const query = searchQuery.toLowerCase();
        const conn = connections.find(c => c.id === t.connectionId);
        return t.name.toLowerCase().includes(query) ||
            t.localPort.toString().includes(query) ||
            t.remotePort.toString().includes(query) ||
            t.remoteHost.toLowerCase().includes(query) ||
            conn?.name?.toLowerCase().includes(query) ||
            conn?.host?.toLowerCase().includes(query);
    });

    // Grouping by connection
    const groupedTunnels = filteredTunnels.reduce((acc, t) => {
        if (!acc[t.connectionId]) acc[t.connectionId] = [];
        acc[t.connectionId].push(t);
        return acc;
    }, {} as Record<string, TunnelConfig[]>);

    const activeCount = tunnels.filter(t => t.status === 'active').length;
    const serversCount = new Set(tunnels.map(t => t.connectionId)).size;

    const handleToggleTunnel = async (tunnel: TunnelConfig) => {
        const conn = connections.find(c => c.id === tunnel.connectionId);
        if (!conn) {
            showToast('error', 'Parent connection not found');
            return;
        }

        try {
            if (tunnel.status === 'active') {
                await window.ipcRenderer.invoke('tunnel:stop', tunnel.id);
                showToast('info', 'Forwarding stopped');

                // Auto-revert if it was using a suggested port
                if (tunnel.originalPort) {
                    try {
                        const revertedTunnel = {
                            ...tunnel,
                            [tunnel.type === 'local' ? 'localPort' : 'remotePort']: tunnel.originalPort,
                            originalPort: undefined,
                        };
                        await window.ipcRenderer.invoke('tunnel:save', revertedTunnel);
                        showToast('success', `Port reverted to ${tunnel.originalPort}`);
                        setTimeout(() => loadTunnels(), 200); // Refresh UI
                    } catch (revertError: any) {
                        showToast('error', `Failed to revert port: ${revertError.message || revertError}`);
                    }
                }

                // Connection Cleanup Logic
                setTimeout(() => {
                    const remainingActiveForthost = tunnels.filter(t => t.connectionId === tunnel.connectionId && t.status === 'active' && t.id !== tunnel.id).length;
                    const hasActiveTabs = tabs.some(tab => tab.connectionId === tunnel.connectionId && (tab.view === 'terminal' || tab.view === 'files'));
                    const hasActiveTerminals = (terminals[tunnel.connectionId] || []).length > 0;

                    if (remainingActiveForthost === 0 && !hasActiveTabs && !hasActiveTerminals) {
                        console.log(`[CLEANUP] Connection ${tunnel.connectionId} is idle, disconnecting...`);
                        disconnect(tunnel.connectionId);
                    }
                }, 1000); // Small delay to let status update
            } else {
                if (conn.status !== 'connected') {
                    showToast('info', `Connecting to ${conn.name || conn.host}...`);
                    try {
                        await connect(conn.id);
                    } catch (e: any) {
                        return;
                    }
                }
                // Start tunnel with proper parameters based on type
                if (tunnel.type === 'remote') {
                    await window.ipcRenderer.invoke('tunnel:start_remote',
                        tunnel.connectionId,
                        tunnel.remotePort,
                        tunnel.remoteHost || '127.0.0.1',
                        tunnel.localPort
                    );
                } else {
                    await window.ipcRenderer.invoke('tunnel:start_local',
                        tunnel.connectionId,
                        tunnel.localPort,
                        tunnel.remoteHost,
                        tunnel.remotePort
                    );
                }
                showToast('success', `Forwarding started`);
            }
        } catch (error: any) {
            const errorMsg = error.message || error || 'Unknown error';

            // Check if error mentions port conflict with suggested port
            const portConflictMatch = errorMsg.match(/Port (\d+) is already in use\. Port (\d+) is available/);
            if (portConflictMatch) {
                const currentPort = parseInt(portConflictMatch[1]);
                const suggestedPort = parseInt(portConflictMatch[2]);
                setPortSuggestion({ tunnel, currentPort, suggestedPort });
                return;
            }

            showToast('error', `Action failed: ${errorMsg}`);
        }
    };

    // Handle accepting the suggested port
    const handleAcceptSuggestedPort = async (port: number) => {
        if (!portSuggestion) return;
        const { tunnel } = portSuggestion;
        setPortSuggestion(null); // Close dialog
        setCustomPort(''); // Reset custom port input

        try {
            const currentPort = tunnel.type === 'local' ? tunnel.localPort : tunnel.remotePort;
            const updatedTunnel = {
                ...tunnel,
                [tunnel.type === 'local' ? 'localPort' : 'remotePort']: port,
                originalPort: tunnel.originalPort || currentPort, // Store original if not already stored
            };

            // Save the updated config
            await window.ipcRenderer.invoke('tunnel:save', updatedTunnel);

            // Then start tunnel with port
            if (tunnel.type === 'remote') {
                await window.ipcRenderer.invoke('tunnel:start_remote',
                    tunnel.connectionId,
                    port,
                    tunnel.remoteHost || '127.0.0.1',
                    tunnel.localPort
                );
            } else {
                await window.ipcRenderer.invoke('tunnel:start_local',
                    tunnel.connectionId,
                    port,
                    tunnel.remoteHost,
                    tunnel.remotePort
                );
            }
            showToast('success', `Switched to port ${port}`);

            // Force reload to show the new tunnel
            setTimeout(() => loadTunnels(), 100);
            setTimeout(() => loadTunnels(), 500);
            setTimeout(() => loadTunnels(), 1000);
        } catch (error: any) {
            showToast('error', `Failed to start on port ${port}: ${error.message || error}`);
        }
    };

    const handleDeleteTunnel = async (id: string) => {
        try {
            await window.ipcRenderer.invoke('tunnel:delete', id);
            showToast('success', 'Forward deleted');
            loadTunnels();
        } catch (error: any) {
            showToast('error', `Failed to delete: ${error.message || error}`);
        }
    };

    const handleOpenBrowser = async (port: number) => {
        try {
            await window.ipcRenderer.invoke('shell:open', `http://localhost:${port}`);
        } catch (e) {
            console.error('Failed to open browser', e);
        }
    };

    return (
        <div className="flex flex-col h-full bg-app-bg animate-in fade-in duration-300">
            {/* Compact Stacked Header */}
            <div className="py-2.5 px-4 bg-app-panel/40 border-b border-app-border/30 backdrop-blur-md sticky top-0 z-20">
                {/* Title Row */}
                <div className="flex items-center gap-2 mb-2">
                    <h1 className="text-sm font-bold tracking-tight text-app-text">Port Forwarding</h1>
                    {tunnels.length > 0 && (
                        <span className="text-[10px] text-app-muted/60 font-medium px-1.5 py-0.5 rounded-md bg-app-surface/50 border border-app-border/30">
                            {activeCount} Active · {serversCount} Servers
                        </span>
                    )}
                </div>

                {/* Search and Actions Row */}
                <div className="flex items-center gap-2">
                    {/* Search Bar */}
                    <div className="relative group flex-1">
                        <div className="absolute inset-y-0 left-0 pl-2.5 flex items-center pointer-events-none text-app-muted/40 group-focus-within:text-app-accent">
                            <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2.5" d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
                            </svg>
                        </div>
                        <input
                            type="text"
                            placeholder="Filter forwards..."
                            value={searchQuery}
                            onChange={(e) => setSearchQuery(e.target.value)}
                            className="w-full bg-app-surface/30 border border-app-border/30 rounded-lg py-1 pl-8 pr-3 text-[11px] focus:outline-none focus:ring-1 focus:ring-app-accent/40 transition-all placeholder:text-app-muted/30"
                        />
                    </div>

                    {/* Actions */}
                    <div className="flex items-center gap-1.5">
                        <Button
                            variant="ghost"
                            onClick={loadTunnels}
                            isLoading={loading}
                            className="h-7 px-2 text-[10px] text-app-muted"
                        >
                            Refresh
                        </Button>
                        <Button
                            onClick={() => {
                                setEditingTunnel(null);
                                setIsAddModalOpen(true);
                            }}
                            className="h-7 px-2.5 bg-app-accent text-white hover:bg-app-accent/90 text-[10px] font-bold whitespace-nowrap"
                        >
                            <Plus size={12} className="mr-1" /> Forward
                        </Button>
                    </div>
                </div>
            </div>

            {/* Content Area */}
            <div className="flex-1 overflow-auto p-4 pt-2">
                {
                    filteredTunnels.length === 0 ? (
                        <div className="h-full flex flex-col items-center justify-center -mt-20">
                            <div className="w-20 h-20 rounded-3xl bg-app-surface/50 border border-app-border/40 flex items-center justify-center mb-6 shadow-sm">
                                <Network className="text-app-muted/40 w-10 h-10" />
                            </div>
                            <h3 className="text-xl font-semibold text-app-text">
                                {searchQuery ? 'No results found' : 'No Port Forwards'}
                            </h3>
                            <p className="text-sm text-app-muted mt-2 max-w-xs text-center opacity-70">
                                {searchQuery
                                    ? `We couldn't find anything matching "${searchQuery}"`
                                    : 'Bridge your local environment with remote servers securely.'}
                            </p>
                            {!searchQuery && (
                                <Button variant="ghost" className="mt-6 text-app-accent hover:bg-app-accent/5" onClick={() => setIsAddModalOpen(true)}>
                                    Create your first forward
                                </Button>
                            )}
                        </div>
                    ) : (
                        <div className="space-y-6 max-w-6xl">
                            {Object.entries(groupedTunnels).map(([connectionId, ports]) => {
                                const conn = connections.find(c => c.id === connectionId);
                                return (
                                    <div key={connectionId} className="animate-in slide-in-from-top-1 duration-200">
                                        {/* Denser Group Header */}
                                        <div className="flex items-center gap-2 mb-2 px-1">
                                            <div className="h-6 w-6 flex items-center justify-center">
                                                <OSIcon icon={conn?.icon || 'Server'} className="w-4 h-4 text-app-muted" />
                                            </div>
                                            <div className="flex items-baseline gap-2 flex-1">
                                                <h2 className="font-bold text-app-text text-xs">
                                                    {conn?.name || conn?.host || 'Unknown Server'}
                                                </h2>
                                                <span className="text-[9px] text-app-muted font-mono opacity-50">
                                                    {conn?.username}@{conn?.host}
                                                </span>
                                                <span className="px-1 py-0.5 rounded bg-app-surface text-[9px] text-app-muted uppercase tracking-tighter border border-app-border/30">
                                                    {ports.length} Port{ports.length > 1 ? 's' : ''}
                                                </span>
                                            </div>
                                        </div>

                                        {/* Denser Ports Grid */}
                                        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-2">
                                            {ports.map(port => {
                                                const isActive = port.status === 'active';
                                                return (
                                                    <div
                                                        key={port.id}
                                                        className={cn(
                                                            "group flex flex-col p-2.5 rounded-xl bg-app-panel/50 border transition-all duration-200 hover:shadow-lg hover:bg-app-panel",
                                                            isActive ? "border-app-accent/40 bg-app-accent/[0.03]" : "border-app-border/40 hover:border-app-border/80"
                                                        )}
                                                    >
                                                        <div className="flex items-center justify-between mb-2">
                                                            <div className="flex items-center gap-2 overflow-hidden">
                                                                <div className={cn(
                                                                    "w-1.5 h-1.5 shrink-0 rounded-full",
                                                                    isActive ? "bg-app-success shadow-[0_0_6px_rgba(var(--color-app-success),0.4)]" : "bg-app-muted/30"
                                                                )} />
                                                                <span className="font-bold text-[11px] text-app-text truncate">{port.name}</span>
                                                            </div>
                                                            <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                                                                {port.type === 'local' && (
                                                                    <button
                                                                        onClick={() => handleOpenBrowser(port.localPort)}
                                                                        className="p-1 rounded hover:bg-app-surface text-app-muted hover:text-blue-400 transition-colors"
                                                                        title="Open Browser"
                                                                    >
                                                                        <ExternalLink size={11} />
                                                                    </button>
                                                                )}
                                                                <button
                                                                    onClick={() => {
                                                                        setEditingTunnel(port);
                                                                        setIsAddModalOpen(true);
                                                                    }}
                                                                    className="p-1 rounded hover:bg-app-surface text-app-muted hover:text-app-text transition-colors"
                                                                    title="Forward Settings"
                                                                >
                                                                    <div className="flex gap-0.5">
                                                                        <div className="w-0.5 h-0.5 rounded-full bg-current" />
                                                                        <div className="w-0.5 h-0.5 rounded-full bg-current" />
                                                                        <div className="w-0.5 h-0.5 rounded-full bg-current" />
                                                                    </div>
                                                                </button>
                                                                <button
                                                                    onClick={() => handleDeleteTunnel(port.id)}
                                                                    className="p-1 rounded hover:bg-red-500/10 text-app-muted hover:text-red-500 transition-colors"
                                                                    title="Delete Forward"
                                                                >
                                                                    <Trash2 size={11} />
                                                                </button>
                                                            </div>
                                                        </div>

                                                        {/* Middle Section: Details */}
                                                        <div className="flex flex-col gap-1.5 py-2 text-[11px]">
                                                            <div className="flex items-center gap-1.5 text-app-muted/80">
                                                                <span className="font-semibold text-app-text/60 text-[10px] uppercase tracking-wider">Target</span>
                                                                <span className="font-mono font-medium text-app-text/90">{port.remoteHost}:{port.type === 'local' ? port.remotePort : port.localPort}</span>
                                                            </div>
                                                            <div className="flex items-center gap-2">
                                                                {port.bindToAny !== undefined && (
                                                                    <span className={cn(
                                                                        "text-[9px] px-2 py-1 rounded-md font-bold uppercase tracking-wider",
                                                                        port.bindToAny
                                                                            ? "bg-orange-500/10 text-orange-400/90 border border-orange-500/20"
                                                                            : "bg-green-500/10 text-green-400/90 border border-green-500/20"
                                                                    )}>
                                                                        {port.bindToAny ? "Public" : "Localhost"}
                                                                    </span>
                                                                )}
                                                                {port.autoStart && (
                                                                    <span className="text-[9px] px-2 py-1 rounded-md bg-blue-500/10 text-blue-400/90 font-bold uppercase tracking-wider border border-blue-500/20">
                                                                        Auto-Start
                                                                    </span>
                                                                )}
                                                            </div>
                                                        </div>

                                                        <div className="flex items-center justify-between gap-2 border-t border-app-border/10 pt-2 mt-auto">
                                                            <div className="flex items-center gap-1.5 font-mono text-[9px] text-app-muted/60">
                                                                <span className="text-app-text/80 font-bold">{port.type === 'local' ? port.localPort : port.remotePort}</span>
                                                                <ArrowRight size={10} className="shrink-0 opacity-30" />
                                                                <span className="text-app-text/80 font-bold">{port.type === 'local' ? port.remotePort : port.localPort}</span>
                                                                <span className={cn(
                                                                    "ml-1 text-[8px] px-1 rounded uppercase font-extrabold tracking-tighter shrink-0",
                                                                    port.type === 'remote' ? "bg-purple-500/10 text-purple-400/80" : "bg-blue-500/10 text-blue-400/80"
                                                                )}>
                                                                    {port.type === 'remote' ? 'REM' : 'LOC'}
                                                                </span>
                                                            </div>

                                                            <Button
                                                                size="sm"
                                                                onClick={() => handleToggleTunnel(port)}
                                                                className={cn(
                                                                    "h-6 px-2 min-w-[50px] rounded text-[9px] font-bold uppercase tracking-tight",
                                                                    isActive
                                                                        ? "bg-red-500/10 text-red-500 hover:bg-red-500 hover:text-white"
                                                                        : "bg-app-surface border border-app-border/60 hover:border-app-accent hover:text-app-accent"
                                                                )}
                                                            >
                                                                {isActive ? 'Stop' : 'Start'}
                                                            </Button>
                                                        </div>
                                                    </div>
                                                );
                                            })}

                                            {/* Add Forward Card */}
                                            <button
                                                onClick={() => {
                                                    setEditingTunnel(null);
                                                    setInitialConnectionId(connectionId);
                                                    setIsAddModalOpen(true);
                                                }}
                                                className="group flex flex-col items-center justify-center min-h-[110px] p-4 rounded-xl border border-dashed border-app-border/40 hover:border-app-accent/50 bg-app-panel/20 hover:bg-app-accent/[0.02] transition-all duration-300"
                                            >
                                                <Plus size={24} className="mb-2 text-app-muted/40 group-hover:text-app-accent/80 group-hover:scale-110 transition-all duration-300" />
                                                <span className="text-[10px] font-medium text-app-muted/50 group-hover:text-app-accent/80 transition-colors">Add Forward</span>
                                            </button>
                                        </div>
                                    </div>
                                );
                            })}
                        </div>
                    )}
            </div>

            {/* Port Conflict Modal */}
            {portSuggestion && (
                <Modal
                    isOpen={true}
                    onClose={() => {
                        setPortSuggestion(null);
                        setCustomPort('');
                    }}
                    title="Port Conflict"
                    width="max-w-sm"
                >
                    <div className="space-y-3">
                        <p className="text-xs text-app-muted">
                            Port <span className="font-mono font-semibold text-app-accent">{portSuggestion.currentPort}</span> is busy.
                        </p>

                        {/* Quick suggestion */}
                        <button
                            onClick={() => handleAcceptSuggestedPort(portSuggestion.suggestedPort)}
                            className="w-full px-3 py-2 text-xs font-medium text-left bg-app-accent/10 hover:bg-app-accent/20 border border-app-accent/30 hover:border-app-accent/50 rounded-lg transition-all flex items-center justify-between group"
                        >
                            <span className="text-app-text">Use port <span className="font-mono font-semibold text-app-accent">{portSuggestion.suggestedPort}</span></span>
                            <ArrowRight size={14} className="text-app-accent opacity-50 group-hover:opacity-100 group-hover:translate-x-0.5 transition-all" />
                        </button>

                        {/* Custom port input */}
                        <div className="space-y-2">
                            <div className="flex gap-2">
                                <input
                                    type="number"
                                    value={customPort}
                                    onChange={(e) => {
                                        // Only allow digits, no decimals or negatives
                                        const value = e.target.value.replace(/[^0-9]/g, '');
                                        setCustomPort(value);
                                    }}
                                    placeholder="Or enter custom port..."
                                    className="flex-1 px-3 py-2 text-xs bg-app-surface border border-app-border/40 rounded-lg focus:outline-none focus:border-app-accent/50 font-mono"
                                    min="1"
                                    max="65535"
                                    onKeyDown={(e) => {
                                        if (e.key === 'Enter' && customPort) {
                                            const port = parseInt(customPort);
                                            if (port > 0 && port < 65536) {
                                                handleAcceptSuggestedPort(port);
                                            }
                                        }
                                    }}
                                />
                                <Button
                                    onClick={() => {
                                        const port = parseInt(customPort);
                                        if (port && port > 0 && port < 65536) {
                                            handleAcceptSuggestedPort(port);
                                        }
                                    }}
                                    disabled={!customPort || parseInt(customPort) <= 0 || parseInt(customPort) > 65535}
                                    className="px-3 text-xs bg-app-accent hover:bg-app-accent/90 disabled:opacity-40 disabled:cursor-not-allowed"
                                >
                                    Use
                                </Button>
                            </div>
                        </div>
                    </div>
                </Modal>
            )}

            <AddTunnelModal
                isOpen={isAddModalOpen}
                editingTunnel={editingTunnel}
                initialConnectionId={initialConnectionId}
                onClose={() => {
                    setIsAddModalOpen(false);
                    setEditingTunnel(null);
                    setInitialConnectionId(undefined);
                    loadTunnels();
                }}
            />
        </div >
    );
}
