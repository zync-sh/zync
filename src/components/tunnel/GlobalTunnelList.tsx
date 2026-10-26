import { useEffect, useState, useRef, useMemo } from 'react';
import { useAppStore } from '../../store/useAppStore';
import { Button } from '../ui/Button';
import { Modal } from '../ui/Modal';
import { TopbarDropdown } from '../ui/TopbarDropdown';
import { cn } from '../../lib/utils';
import { Plus, Network, ChevronDown, FileText, Play, Square, ChevronRight, ArrowRight } from 'lucide-react';
import { TUNNEL_PRESETS, TunnelPreset } from '../../lib/tunnelPresets';
import { AddTunnelModal } from '../modals/AddTunnelModal';
import { ImportSSHCommandModal } from '../modals/ImportSSHCommandModal';
import type { TunnelConfig } from './TunnelCard';
import {
    TunnelRow,
    TunnelGridCard,
    TunnelTableHeader,
    TunnelSearchInput,
    TunnelViewToggle,
    useTunnelViewMode,
    TunnelFilterToolbar,
    countTunnelFilters,
    tunnelMatchesQuery,
    tunnelMatchesStatus,
    tunnelMatchesType,
    type TunnelStatusFilter,
    type TunnelTypeFilter,
} from './TunnelRow';
import { getConnectionDisplayLabels } from '../../features/connections/domain/connectionDisplay';
import { OSIcon } from '../icons/OSIcon';
import {
    parsePortConflictError,
    tunnelWithSwappedPort,
} from '../../features/tunnels/application/tunnelPortConflict';
import {
    revertTunnelOriginalPort,
    stopTunnelConfig,
} from '../../features/tunnels/application/tunnelActions';
import { userTunnelActions } from '../../features/tunnels/application/userTunnelStoreActions';

export function GlobalTunnelList() {
    const connections = useAppStore(state => state.connections);
    const tunnelsMap = useAppStore(state => state.tunnels);
    const allTunnels = useMemo(() => Object.values(tunnelsMap).flat(), [tunnelsMap]);
    const loadAllTunnels = useAppStore(state => state.loadAllTunnels);
    const updateTunnelStatus = useAppStore(state => state.updateTunnelStatus);
    const deleteTunnel = useAppStore(state => state.deleteTunnel);
    const saveTunnel = useAppStore(state => state.saveTunnel);
    const stopTunnel = useAppStore(state => state.stopTunnel);

    const showToast = useAppStore((state) => state.showToast);
    // const [tunnels, setTunnels] = useState<TunnelConfig[]>([]); // Removed local state
    const [searchQuery, setSearchQuery] = useState('');
    const [statusFilter, setStatusFilter] = useState<TunnelStatusFilter>('all');
    const [typeFilter, setTypeFilter] = useState<TunnelTypeFilter>('all');
    const [loading, setLoading] = useState(false);
    const [isAddModalOpen, setIsAddModalOpen] = useState(false);
    const [editingTunnel, setEditingTunnel] = useState<TunnelConfig | null>(null);
    const [initialConnectionId, setInitialConnectionId] = useState<string | undefined>(undefined);
    const [showPresetDropdown, setShowPresetDropdown] = useState(false);
    const [showImportModal, setShowImportModal] = useState(false);
    const [viewMode, setViewMode] = useTunnelViewMode();
    const [collapsedHosts, setCollapsedHosts] = useState<Set<string>>(new Set());
    const dropdownRef = useRef<HTMLDivElement>(null);

    // Port suggestion dialog state
    const [portSuggestion, setPortSuggestion] = useState<{
        tunnel: TunnelConfig;
        currentPort: number;
        suggestedPort: number;
    } | null>(null);
    const [customPort, setCustomPort] = useState<string>(''); // For custom port input

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

    const toggleHost = (connectionId: string) => {
        setCollapsedHosts(prev => {
            const next = new Set(prev);
            if (next.has(connectionId)) next.delete(connectionId);
            else next.add(connectionId);
            return next;
        });
    };

    const filterCounts = useMemo(() => countTunnelFilters(allTunnels), [allTunnels]);

    const filteredTunnels = useMemo(() => {
        return allTunnels.filter(t => {
            const conn = connections.find(c => c.id === t.connectionId);
            const extra = [conn?.name, conn?.host].filter(Boolean) as string[];
            return (
                tunnelMatchesQuery(t, searchQuery, extra) &&
                tunnelMatchesStatus(t, statusFilter) &&
                tunnelMatchesType(t, typeFilter)
            );
        });
    }, [allTunnels, connections, searchQuery, statusFilter, typeFilter]);

    const hostGroups = useMemo(() => {
        const byConn = new Map<string, TunnelConfig[]>();
        for (const t of filteredTunnels) {
            const list = byConn.get(t.connectionId) ?? [];
            list.push(t);
            byConn.set(t.connectionId, list);
        }
        return Array.from(byConn.entries())
            .map(([connectionId, tunnels]) => {
                const conn = connections.find(c => c.id === connectionId);
                return {
                    connectionId,
                    hostLabel: conn
                        ? getConnectionDisplayLabels(conn, false).primary
                        : 'Unknown host',
                    icon: conn?.icon || 'Server',
                    connected: conn?.status === 'connected',
                    tunnels,
                };
            })
            .sort((a, b) => a.hostLabel.localeCompare(b.hostLabel));
    }, [filteredTunnels, connections]);

    const activeCount = filterCounts.running;
    const serversCount = new Set(allTunnels.map(t => t.connectionId)).size;
    const filtersActive = Boolean(searchQuery.trim()) || statusFilter !== 'all' || typeFilter !== 'all';

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

                // Stopping a forward leaves the shared host transport available to every pane.
                loadTunnels(); // Refresh UI
            } else {
                if (await userTunnelActions.start(tunnel) === 'cancelled') return;
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
            if (await userTunnelActions.start(updatedTunnel) === 'cancelled') return;
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
        showToast('info', `Starting ${groupName === 'Ungrouped' ? 'ungrouped' : groupName} forwards...`);
        const { started, failed, cancelled } = await userTunnelActions.startGroup(groupTunnels);

        loadTunnels();

        if (failed > 0) {
            showToast('error', `Started ${started} forwards; ${failed} failed${cancelled ? `; ${cancelled} not started` : ''}`);
        } else if (cancelled > 0) {
            showToast('info', `Started ${started} forwards; ${cancelled} not started`);
        } else if (started > 0) {
            showToast('success', `Started ${started} forwards`);
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
            <div className="sticky top-0 z-20 border-b border-app-border/30 bg-app-panel/40 px-4 py-2.5 backdrop-blur-md">
                <div className="mb-2 flex items-center gap-2">
                    <h1 className="text-sm font-bold tracking-tight text-app-text">Port Forwarding</h1>
                    {allTunnels.length > 0 && (
                        <span className="rounded-md border border-app-border/30 bg-app-surface/50 px-1.5 py-0.5 text-[10px] font-medium text-app-muted/60">
                            {activeCount} running · {serversCount} {serversCount === 1 ? 'host' : 'hosts'}
                        </span>
                    )}
                </div>

                <div className="flex flex-wrap items-center gap-2">
                    <TunnelSearchInput query={searchQuery} onQueryChange={setSearchQuery} />
                    <TunnelViewToggle viewMode={viewMode} onChange={setViewMode} />
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

            <div className="flex-1 overflow-auto p-4 pt-2">
                {allTunnels.length > 0 && (
                    <TunnelFilterToolbar
                        status={statusFilter}
                        onStatusChange={setStatusFilter}
                        type={typeFilter}
                        onTypeChange={setTypeFilter}
                        counts={filterCounts}
                    />
                )}
                {filteredTunnels.length === 0 ? (
                    <div className="flex h-full flex-col items-center justify-center -mt-20">
                        <div className="mb-6 flex h-20 w-20 items-center justify-center rounded-3xl border border-app-border/40 bg-app-surface/50 shadow-sm">
                            <Network className="h-10 w-10 text-app-muted/40" />
                        </div>
                        <h3 className="text-xl font-semibold text-app-text">
                            {filtersActive ? 'No matching forwards' : 'No Port Forwards'}
                        </h3>
                        <p className="mt-2 max-w-xs text-center text-sm text-app-muted opacity-70">
                            {filtersActive
                                ? 'Try a different search or clear the filters.'
                                : 'SSH local, remote, and SOCKS forwards across your hosts.'}
                        </p>
                        {!filtersActive && (
                            <Button variant="ghost" className="mt-6 text-app-accent hover:bg-app-accent/5" onClick={() => setIsAddModalOpen(true)}>
                                Create your first forward
                            </Button>
                        )}
                    </div>
                ) : (
                    <div className="w-full">
                        {viewMode === 'list' && <TunnelTableHeader />}
                        <div className="space-y-4">
                            {hostGroups.map(group => {
                                const running = group.tunnels.filter(t => t.status === 'active').length;
                                const collapsed = collapsedHosts.has(group.connectionId);
                                const copyHandlers = {
                                    onToggle: handleToggleTunnel,
                                    onEdit: (t: TunnelConfig) => {
                                        setEditingTunnel(t);
                                        setIsAddModalOpen(true);
                                    },
                                    onDelete: handleDeleteTunnel,
                                    onOpenBrowser: handleOpenBrowser,
                                    onCopy: (text: string) => {
                                        void navigator.clipboard.writeText(text).then(
                                            () => showToast('success', 'Copied'),
                                            () => showToast('error', 'Could not copy'),
                                        );
                                    },
                                };
                                return (
                                    <div key={group.connectionId}>
                                        <div
                                            role="button"
                                            tabIndex={0}
                                            aria-expanded={!collapsed}
                                            className="group flex cursor-pointer select-none items-center justify-between rounded-md px-1 py-1 hover:bg-app-surface/30 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-app-border"
                                            onClick={() => toggleHost(group.connectionId)}
                                            onKeyDown={e => {
                                                if (e.key === 'Enter' || e.key === ' ') {
                                                    e.preventDefault();
                                                    toggleHost(group.connectionId);
                                                }
                                            }}
                                        >
                                            <div className="flex min-w-0 items-center gap-2">
                                                <ChevronRight
                                                    size={14}
                                                    className={cn(
                                                        'shrink-0 text-app-muted transition-transform duration-200',
                                                        !collapsed && 'rotate-90',
                                                    )}
                                                />
                                                <span
                                                    className="relative flex h-4 w-4 shrink-0 items-center justify-center"
                                                    title={group.connected ? 'Connected' : 'Disconnected'}
                                                >
                                                    <OSIcon
                                                        icon={group.icon}
                                                        className="h-3.5 w-3.5 text-app-muted"
                                                    />
                                                    <span
                                                        className={cn(
                                                            'absolute -bottom-0.5 -right-0.5 h-1.5 w-1.5 rounded-full ring-1 ring-app-bg',
                                                            group.connected ? 'bg-app-success' : 'bg-app-muted/40',
                                                        )}
                                                    />
                                                </span>
                                                <h2 className="truncate text-xs font-semibold text-app-text">
                                                    {group.hostLabel}
                                                </h2>
                                                <span className="font-mono text-[10px] text-app-muted/50">
                                                    {running}/{group.tunnels.length}
                                                </span>
                                            </div>
                                            <div
                                                className="flex items-center gap-1 opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100"
                                                onKeyDown={e => e.stopPropagation()}
                                            >
                                                {running > 0 && (
                                                    <Button
                                                        size="sm"
                                                        variant="ghost"
                                                        onClick={e => {
                                                            e.stopPropagation();
                                                            handleStopGroup(group.hostLabel, group.tunnels);
                                                        }}
                                                        className="h-6 gap-1 px-2 text-[10px] text-app-muted hover:bg-red-400/10 hover:text-red-400"
                                                        title="Stop all on this host"
                                                    >
                                                        <Square size={10} className="fill-current" /> Stop all
                                                    </Button>
                                                )}
                                                <Button
                                                    size="sm"
                                                    variant="ghost"
                                                    onClick={e => {
                                                        e.stopPropagation();
                                                        handleStartGroup(group.hostLabel, group.tunnels);
                                                    }}
                                                    className="h-6 gap-1 px-2 text-[10px] text-app-muted hover:bg-green-400/10 hover:text-green-400"
                                                    title="Start all on this host"
                                                >
                                                    <Play size={10} className="fill-current" /> Start all
                                                </Button>
                                            </div>
                                        </div>
                                        {!collapsed && (
                                            viewMode === 'grid' ? (
                                                <div className="mt-2 grid w-full grid-cols-1 gap-2 sm:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4">
                                                    {group.tunnels.map(tunnel => (
                                                        <TunnelGridCard
                                                            key={tunnel.id}
                                                            tunnel={tunnel}
                                                            hostLabel={group.hostLabel}
                                                            {...copyHandlers}
                                                        />
                                                    ))}
                                                </div>
                                            ) : (
                                                <div className="mt-1 flex flex-col gap-1.5">
                                                    {group.tunnels.map(tunnel => (
                                                        <TunnelRow
                                                            key={tunnel.id}
                                                            tunnel={tunnel}
                                                            hostLabel={group.hostLabel}
                                                            {...copyHandlers}
                                                        />
                                                    ))}
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
