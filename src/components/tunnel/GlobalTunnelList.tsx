import { useEffect, useState, useRef, useMemo } from 'react';
import { useAppStore } from '../../store/useAppStore';
import { Button } from '../ui/Button';
import { Modal } from '../ui/Modal';
import { TopbarDropdown } from '../ui/TopbarDropdown';
import { cn } from '../../lib/utils';
import { Plus, Network, ChevronDown, FileText, Play, Square, Folder, FolderOpen, LayoutGrid, List, ChevronRight, ArrowRight } from 'lucide-react';
import { TUNNEL_PRESETS, TunnelPreset } from '../../lib/tunnelPresets';
import { AddTunnelModal } from '../modals/AddTunnelModal';
import { ImportSSHCommandModal } from '../modals/ImportSSHCommandModal';
import { TunnelCard, TunnelConfig } from './TunnelCard';
import { getConnectionDisplayLabels } from '../../features/connections/domain/connectionDisplay';
import {
    parsePortConflictError,
    tunnelWithSwappedPort,
} from '../../features/tunnels/application/tunnelPortConflict';
import {
    revertTunnelOriginalPort,
    stopTunnelConfig,
    startTunnelConfig,
} from '../../features/tunnels/application/tunnelActions';

export function GlobalTunnelList() {
    const connections = useAppStore(state => state.connections);
    const connect = useAppStore(state => state.connect);
    const tunnelsMap = useAppStore(state => state.tunnels);
    const allTunnels = useMemo(() => Object.values(tunnelsMap).flat(), [tunnelsMap]);
    const loadAllTunnels = useAppStore(state => state.loadAllTunnels);
    const updateTunnelStatus = useAppStore(state => state.updateTunnelStatus);
    const deleteTunnel = useAppStore(state => state.deleteTunnel);
    const saveTunnel = useAppStore(state => state.saveTunnel);
    const startTunnel = useAppStore(state => state.startTunnel);
    const stopTunnel = useAppStore(state => state.stopTunnel);

    const showToast = useAppStore((state) => state.showToast);
    // const [tunnels, setTunnels] = useState<TunnelConfig[]>([]); // Removed local state
    const [searchQuery, setSearchQuery] = useState('');
    const [loading, setLoading] = useState(false);
    const [isAddModalOpen, setIsAddModalOpen] = useState(false);
    const [editingTunnel, setEditingTunnel] = useState<TunnelConfig | null>(null);
    const [initialConnectionId, setInitialConnectionId] = useState<string | undefined>(undefined);
    const [showPresetDropdown, setShowPresetDropdown] = useState(false);
    const [showImportModal, setShowImportModal] = useState(false);
    const [viewMode, setViewMode] = useState<'grid' | 'list'>('list');
    const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(new Set());
    const dropdownRef = useRef<HTMLDivElement>(null);

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
            await loadAllTunnels();
        } catch (error) {
            console.error('Failed to load global tunnels', error);
        } finally {
            setLoading(false);
        }
    };

    const allTunnelsRef = useRef(allTunnels);
    useEffect(() => {
        allTunnelsRef.current = allTunnels;
    }, [allTunnels]);

    useEffect(() => {
        loadTunnels();

        const handleStatusChange = (_: any, { id, status, error }: any) => {
            // Find connectionId for the tunnel using the ref to get fresh data
            const tunnel = allTunnelsRef.current.find(t => t.id === id);
            if (tunnel) {
                updateTunnelStatus(id, tunnel.connectionId, status, error);
            }
        };

        window.ipcRenderer.on('tunnel:status-change', handleStatusChange);
        return () => {
            window.ipcRenderer.off('tunnel:status-change', handleStatusChange);
        };
    }, []);

    // Close dropdown when clicking outside
    useEffect(() => {
        const handleClickOutside = (event: MouseEvent) => {
            if (dropdownRef.current && !dropdownRef.current.contains(event.target as Node)) {
                setShowPresetDropdown(false);
            }
        };

        if (showPresetDropdown) {
            document.addEventListener('mousedown', handleClickOutside);
        }

        return () => {
            document.removeEventListener('mousedown', handleClickOutside);
        };
    }, [showPresetDropdown]);

    // Handle preset selection
    const handlePresetSelect = (preset: TunnelPreset) => {
        setShowPresetDropdown(false);
        setEditingTunnel({
            id: '',
            connectionId: '',
            name: preset.name,
            type: preset.type,
            localPort: preset.localPort,
            remoteHost: preset.remoteHost,
            remotePort: preset.remotePort,
            bindToAny: preset.bindToAny,
            status: 'stopped',
        } as TunnelConfig);
        setIsAddModalOpen(true);
    };

    const toggleGroup = (group: string) => {
        const newSet = new Set(collapsedGroups);
        if (newSet.has(group)) {
            newSet.delete(group);
        } else {
            newSet.add(group);
        }
        setCollapsedGroups(newSet);
    };

    const filteredTunnels = allTunnels.filter(t => {
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
    // Grouping by Group Name
    const groupedTunnels = filteredTunnels.reduce((acc, t) => {
        const groupName = t.group || 'Ungrouped';
        if (!acc[groupName]) acc[groupName] = [];
        acc[groupName].push(t);
        return acc;
    }, {} as Record<string, TunnelConfig[]>);

    // Sort groups: named groups alphabetical, then Ungrouped
    const sortedGroupNames = Object.keys(groupedTunnels).sort((a, b) => {
        if (a === 'Ungrouped') return 1;
        if (b === 'Ungrouped') return -1;
        return a.localeCompare(b);
    });

    const activeCount = allTunnels.filter(t => t.status === 'active').length;
    const serversCount = new Set(allTunnels.map(t => t.connectionId)).size;

    const handleToggleTunnel = async (tunnel: TunnelConfig) => {
        const conn = connections.find(c => c.id === tunnel.connectionId);
        if (!conn) {
            showToast('error', 'Parent connection not found');
            return;
        }

        try {
            if (tunnel.status === 'active') {
                await stopTunnelConfig(tunnel, stopTunnel);
                showToast('info', 'Forwarding stopped');

                try {
                    const reverted = await revertTunnelOriginalPort(tunnel, saveTunnel);
                    if (reverted && tunnel.originalPort) {
                        showToast('success', `Port reverted to ${tunnel.originalPort}`);
                    }
                } catch (revertError: unknown) {
                    const message = revertError instanceof Error ? revertError.message : String(revertError);
                    showToast('error', `Failed to revert port: ${message}`);
                }

                // Connection Cleanup Logic
                setTimeout(() => {
                    const remainingActiveForthost = allTunnels.filter(t => t.connectionId === tunnel.connectionId && t.status === 'active' && t.id !== tunnel.id).length;
                    const hasActiveTabs = tabs.some(tab => tab.connectionId === tunnel.connectionId && (tab.view === 'terminal' || tab.view === 'files'));
                    const hasActiveTerminals = (terminals[tunnel.connectionId] || []).length > 0;

                    if (remainingActiveForthost === 0 && !hasActiveTabs && !hasActiveTerminals) {
                        console.log(`[CLEANUP] Connection ${tunnel.connectionId} is idle, disconnecting...`);
                        disconnect(tunnel.connectionId);
                    }
                }, 1000); // Small delay to let status update
                loadTunnels(); // Refresh UI
            } else {
                if (conn.status !== 'connected') {
                    showToast('info', `Connecting to ${conn.name || conn.host}...`);
                    try {
                        await connect(conn.id);
                    } catch (e: any) {
                        return;
                    }
                }
                await startTunnelConfig(tunnel, startTunnel);
                showToast('success', `Forwarding started`);
            }
        } catch (error: unknown) {
            const conflict = parsePortConflictError(error, tunnel);
            if (conflict) {
                setPortSuggestion(conflict);
                return;
            }
            const errorMsg = error instanceof Error ? error.message : String(error);
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
            const updatedTunnel = tunnelWithSwappedPort(tunnel, port);
            await saveTunnel(updatedTunnel);
            await startTunnel(updatedTunnel.id, updatedTunnel.connectionId);
            showToast('success', `Switched to port ${port}`);
        } catch (error: unknown) {
            const message = error instanceof Error ? error.message : String(error);
            showToast('error', `Failed to start on port ${port}: ${message}`);
        }
    };

    const handleDeleteTunnel = async (id: string) => {
        try {
            const tunnel = allTunnels.find(t => t.id === id);
            if (tunnel) {
                await deleteTunnel(id, tunnel.connectionId);
                showToast('success', 'Forward deleted');
            }
        } catch (error: any) {
            showToast('error', `Failed to delete: ${error.message || error}`);
        }
    };


    // Handle starting all tunnels in a group
    const handleStartGroup = async (groupName: string, groupTunnels: TunnelConfig[]) => {
        let successCount = 0;
        let failCount = 0;

        showToast('info', `Starting ${groupName === 'Ungrouped' ? 'ungrouped' : groupName} forwards...`);

        // Group tunnels by connectionId to ensure active SSH sessions
        const tunnelsByConn = groupTunnels.reduce((acc, t) => {
            if (t.status !== 'active') {
                if (!acc[t.connectionId]) acc[t.connectionId] = [];
                acc[t.connectionId].push(t);
            }
            return acc;
        }, {} as Record<string, TunnelConfig[]>);

        for (const [connectionId, tunnels] of Object.entries(tunnelsByConn)) {
            const conn = connections.find(c => c.id === connectionId);

            // Connect if needed
            if (conn && conn.status !== 'connected') {
                try {
                    showToast('info', `Connecting to ${conn.name || 'host'}...`);
                    await connect(conn.id);
                } catch (e: any) {
                    failCount += tunnels.length;
                    continue;
                }
            }

            for (const tunnel of tunnels) {
                try {
                    await startTunnel(tunnel.id, tunnel.connectionId);
                    successCount++;
                } catch (err) {
                    console.error(`Failed to start tunnel ${tunnel.name}:`, err);
                    failCount++;
                }
            }
        }

        loadTunnels();

        if (failCount > 0) {
            showToast('error', `Started ${successCount} tunnels, failed ${failCount}`);
        } else if (successCount > 0) {
            showToast('success', `Started ${successCount} forwards`);
        }
    };

    // Handle stopping all tunnels in a group
    const handleStopGroup = async (groupName: string, groupTunnels: TunnelConfig[]) => {
        let count = 0;

        // Sequential stop
        for (const tunnel of groupTunnels) {
            if (tunnel.status === 'active') {
                try {
                    await stopTunnel(tunnel.id, tunnel.connectionId);
                    count++;
                } catch (err) {
                    console.error(`Failed to stop tunnel ${tunnel.name}:`, err);
                }
            }
        }

        loadTunnels();
        if (count > 0) showToast('info', `Stopped ${count} forwards in ${groupName === 'Ungrouped' ? 'ungrouped' : groupName}`);
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
                    {allTunnels.length > 0 && (
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
                    <div className="flex bg-app-surface/50 p-0.5 rounded-lg border border-app-border/40 mr-2">
                        <button
                            onClick={() => setViewMode('grid')}
                            className={cn(
                                "p-1.5 rounded transition-all",
                                viewMode === 'grid' ? "bg-app-accent text-white shadow-sm" : "text-app-muted hover:text-app-text hover:bg-app-highlight/30"
                            )}
                            title="Grid View"
                        >
                            <LayoutGrid size={14} />
                        </button>
                        <button
                            onClick={() => setViewMode('list')}
                            className={cn(
                                "p-1.5 rounded transition-all",
                                viewMode === 'list' ? "bg-app-accent text-white shadow-sm" : "text-app-muted hover:text-app-text hover:bg-app-highlight/30"
                            )}
                            title="List View"
                        >
                            <List size={14} />
                        </button>
                    </div>
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
                            variant="ghost"
                            onClick={() => setShowImportModal(true)}
                            className="h-7 px-2 text-[10px] text-app-muted hover:text-app-text"
                            title="Import from SSH Command"
                        >
                            <FileText size={12} className="mr-1" /> Import
                        </Button>
                        <div className="relative" ref={dropdownRef}>
                            <div className="flex">
                                <Button
                                    onClick={() => {
                                        setEditingTunnel(null);
                                        setIsAddModalOpen(true);
                                    }}
                                    className="h-7 px-2.5 bg-app-accent text-white hover:bg-app-accent/90 text-[10px] font-bold whitespace-nowrap rounded-r-none border-r border-white/20"
                                >
                                    <Plus size={12} className="mr-1" /> Forward
                                </Button>
                                <Button
                                    onClick={() => setShowPresetDropdown(!showPresetDropdown)}
                                    className="h-7 px-1.5 bg-app-accent text-white hover:bg-app-accent/90 rounded-l-none"
                                    title="Quick Tunnels"
                                >
                                    <ChevronDown size={12} />
                                </Button>
                            </div>

                            {/* Preset Dropdown */}
                            {showPresetDropdown && (
                                <TopbarDropdown
                                    align="right"
                                    widthClass="w-56"
                                    className="mt-1 rounded-lg shadow-xl p-0"
                                >
                                    {TUNNEL_PRESETS.map((preset) => (
                                        <button
                                            key={preset.id}
                                            onClick={() => handlePresetSelect(preset)}
                                            className="w-full px-3 py-2.5 text-left hover:bg-app-surface transition-colors border-b border-app-border/30 last:border-b-0 group"
                                        >
                                            <div className="flex items-center justify-between">
                                                <div className="flex-1">
                                                    <div className="font-semibold text-xs text-app-text group-hover:text-app-accent transition-colors">{preset.name}</div>
                                                    <div className="text-[10px] text-app-muted mt-0.5">{preset.description}</div>
                                                </div>
                                                <div className="text-[9px] font-mono text-app-muted/60 bg-app-surface/50 px-1.5 py-0.5 rounded">
                                                    {preset.localPort}
                                                </div>
                                            </div>
                                        </button>
                                    ))}
                                </TopbarDropdown>
                            )}
                        </div>
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
                            <div className="space-y-6 max-w-6xl">
                                {sortedGroupNames.map(groupName => {
                                    const ports = groupedTunnels[groupName];
                                    const activeCount = ports.filter(t => t.status === 'active').length;

                                    const isCollapsed = collapsedGroups.has(groupName);

                                    return (
                                        <div key={groupName} className="animate-in slide-in-from-top-1 duration-200">
                                            {/* Group Header */}
                                            <div
                                                className="group flex items-center justify-between mb-2 px-1 border-b border-app-border/30 pb-1 cursor-pointer select-none hover:bg-app-surface/30 rounded-t-lg transition-colors"
                                                onClick={() => toggleGroup(groupName)}
                                            >
                                                <div className="flex items-center gap-2">
                                                    <ChevronRight
                                                        size={14}
                                                        className={cn(
                                                            "text-app-muted transition-transform duration-200",
                                                            !isCollapsed && "rotate-90"
                                                        )}
                                                    />
                                                    {groupName === 'Ungrouped' ? (
                                                        <FolderOpen size={16} className="text-app-muted/60" />
                                                    ) : (
                                                        <Folder size={16} className="text-app-accent/80" />
                                                    )}
                                                    <div className="flex items-baseline gap-2 flex-1">
                                                        <h2 className={cn(
                                                            "font-bold text-xs",
                                                            groupName === 'Ungrouped' ? "text-app-muted italic" : "text-app-text"
                                                        )}>
                                                            {groupName}
                                                        </h2>
                                                        <span className="rounded border border-app-border/30 bg-app-surface px-1.5 py-0.5 font-mono text-[9px] text-app-muted">
                                                            {activeCount}/{ports.length} active
                                                        </span>
                                                    </div>
                                                </div>
                                                <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                                                    {activeCount > 0 && (
                                                        <Button
                                                            size="sm"
                                                            variant="ghost"
                                                            onClick={(e) => {
                                                                e.stopPropagation();
                                                                handleStopGroup(groupName, ports);
                                                            }}
                                                            className="h-6 px-2 text-[10px] text-app-muted hover:text-red-400 hover:bg-red-400/10 gap-1"
                                                            title="Stop All"
                                                        >
                                                            <Square size={10} className="fill-current" /> Stop All
                                                        </Button>
                                                    )}
                                                    <Button
                                                        size="sm"
                                                        variant="ghost"
                                                        onClick={(e) => {
                                                            e.stopPropagation();
                                                            handleStartGroup(groupName, ports);
                                                        }}
                                                        className="h-6 px-2 text-[10px] text-app-muted hover:text-green-400 hover:bg-green-400/10 gap-1"
                                                        title="Start All"
                                                    >
                                                        <Play size={10} className="fill-current" /> Start All
                                                    </Button>
                                                </div>
                                            </div>

                                            {/* Ports Grid/List */}
                                            {!isCollapsed && (
                                                viewMode === 'grid' ? (
                                                    <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4">
                                                        {ports.map((tunnel) => {
                                                            const conn = connections.find(c => c.id === tunnel.connectionId);
                                                            const hostLabel = conn
                                                                ? getConnectionDisplayLabels(conn, false).primary
                                                                : undefined;
                                                            return (
                                                                <TunnelCard
                                                                    key={tunnel.id}
                                                                    tunnel={tunnel}
                                                                    connectionIcon={conn?.icon}
                                                                    hostLabel={hostLabel}
                                                                    viewMode="grid"
                                                                    onToggle={handleToggleTunnel}
                                                                    onEdit={(t) => {
                                                                        setEditingTunnel(t);
                                                                        setIsAddModalOpen(true);
                                                                    }}
                                                                    onDelete={handleDeleteTunnel}
                                                                    onOpenBrowser={handleOpenBrowser}
                                                                    onCopy={(text) => {
                                                                        navigator.clipboard.writeText(text);
                                                                        showToast('success', 'Copied');
                                                                    }}
                                                                />
                                                            );
                                                        })}
                                                    </div>
                                                ) : (
                                                    // List View
                                                    <div className="space-y-1">
                                                        {ports.map((tunnel) => {
                                                            const conn = connections.find(c => c.id === tunnel.connectionId);
                                                            const hostLabel = conn
                                                                ? getConnectionDisplayLabels(conn, false).primary
                                                                : undefined;
                                                            return (
                                                                <TunnelCard
                                                                    key={tunnel.id}
                                                                    tunnel={tunnel}
                                                                    connectionIcon={conn?.icon}
                                                                    hostLabel={hostLabel}
                                                                    viewMode="list"
                                                                    onToggle={handleToggleTunnel}
                                                                    onEdit={(t) => {
                                                                        setEditingTunnel(t);
                                                                        setIsAddModalOpen(true);
                                                                    }}
                                                                    onDelete={handleDeleteTunnel}
                                                                    onOpenBrowser={handleOpenBrowser}
                                                                    onCopy={(text) => {
                                                                        navigator.clipboard.writeText(text);
                                                                        showToast('success', 'Copied');
                                                                    }}
                                                                />
                                                            );
                                                        })}
                                                    </div>
                                                )
                                            )}
                                        </div>
                                    );
                                })}
                            </div>
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

            {showImportModal && (
                <ImportSSHCommandModal
                    isOpen={showImportModal}
                    onClose={() => setShowImportModal(false)}
                    onImport={loadTunnels}
                />
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
