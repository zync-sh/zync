import { useEffect, useState } from 'react';
import { useAppStore, type Connection, type Tab } from '../../store/useAppStore';
import { Button } from '../ui/Button';
import { cn } from '../../lib/utils';
import { Network, Play, Square, ExternalLink, ArrowRight } from 'lucide-react';

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
}

export function GlobalTunnelList() {
    const connections = useAppStore(state => state.connections);
    const connect = useAppStore(state => state.connect);
    const tabs = useAppStore(state => state.tabs);
    const openTab = useAppStore(state => state.openTab);

    const showToast = useAppStore((state) => state.showToast);
    const [tunnels, setTunnels] = useState<TunnelConfig[]>([]);
    const [loading, setLoading] = useState(false);

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

        // Poll for updates every 5 seconds as backup
        const interval = setInterval(loadTunnels, 5000);
        return () => {
            clearInterval(interval);
            window.ipcRenderer.off('tunnel:status-change', handleStatusChange);
        };
    }, []);

    const handleToggleTunnel = async (tunnel: TunnelConfig) => {
        const conn = connections.find(c => c.id === tunnel.connectionId);
        if (!conn) {
            showToast('error', 'Parent connection not found');
            return;
        }

        try {
            if (tunnel.status === 'active') {
                await window.ipcRenderer.invoke('tunnel:stop', tunnel.id);
                showToast('info', 'Tunnel stopped');
            } else {
                // Smart Connect Logic
                if (conn.status !== 'connected') {
                    showToast('info', `Connecting to ${conn.name || conn.host}...`);
                    try {
                        await connect(conn.id);
                        // Wait a bit for connection to stabilize? Connect is async and awaits success.
                    } catch (e: any) {
                        // Toast handled by connect()
                        return; // Stop here
                    }
                }

                await window.ipcRenderer.invoke('tunnel:start', tunnel.id);
                showToast('success', `Tunnel started`);
            }
            loadTunnels();
        } catch (error: any) {
            showToast('error', `Tunnel action failed: ${error.message}`);
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
            {/* Header */}
            <div className="p-6 border-b border-app-border flex justify-between items-center bg-app-panel/50 backdrop-blur-md sticky top-0 z-10">
                <div>
                    <h1 className="text-2xl font-bold flex items-center gap-3 text-app-text">
                        <div className="p-2 rounded-xl bg-app-accent/10 border border-app-accent/20">
                            <Network size={24} className="text-app-accent" />
                        </div>
                        Global Tunnels
                    </h1>
                    <p className="text-app-muted mt-1 ml-1 text-sm">
                        Manage SSH tunnels across all your connections from one place.
                    </p>
                </div>
                <Button variant="secondary" onClick={loadTunnels} isLoading={loading}>
                    Refresh
                </Button>
            </div>

            {/* Content */}
            <div className="flex-1 overflow-auto p-6 space-y-8">
                {tunnels.length === 0 ? (
                    <div className="text-center text-app-muted mt-20 flex flex-col items-center">
                        <div className="w-16 h-16 rounded-full bg-app-surface border border-app-border flex items-center justify-center mb-4">
                            <Network className="text-app-muted/50 w-8 h-8" />
                        </div>
                        <p className="font-medium text-lg">No Tunnels Found</p>
                        <p className="text-sm opacity-70 max-w-md mt-2">
                            Create tunnels inside individual connection tabs to see them here.
                        </p>
                    </div>
                ) : (
                    <div className="divide-y divide-app-border/30 border border-app-border rounded-xl bg-app-panel overflow-hidden">
                        {tunnels.map(tunnel => {
                            const conn = connections.find((c: Connection) => c.id === tunnel.connectionId);
                            const isConnected = conn?.status === 'connected';
                            const hasTab = isConnected && tabs.some((t: Tab) => t.connectionId === conn?.id);

                            return (
                                <div key={tunnel.id} className="p-4 flex items-center justify-between hover:bg-app-surface/30 transition-colors group">
                                    <div className="flex flex-col gap-1.5">
                                        <div className="flex items-center gap-3">
                                            {/* Status Dot */}
                                            <div className={cn(
                                                "w-2.5 h-2.5 rounded-full shrink-0",
                                                tunnel.status === 'active' ? "bg-green-500 shadow-[0_0_8px_rgba(34,197,94,0.4)]" : "bg-red-500/50"
                                            )} />

                                            <span className="font-semibold text-app-text text-sm pointer-events-none select-none">{tunnel.name}</span>

                                            <div className="flex items-center gap-2">
                                                <span className={cn(
                                                    "text-[9px] px-1.5 py-px rounded font-mono uppercase tracking-wider font-semibold",
                                                    tunnel.type === 'remote'
                                                        ? "bg-purple-500/10 text-purple-400 border border-purple-500/20"
                                                        : "bg-blue-500/10 text-blue-400 border border-blue-500/20"
                                                )}>
                                                    {tunnel.type === 'remote' ? 'REM' : 'LOC'}
                                                </span>

                                                {/* Server Badge */}
                                                {conn && (
                                                    <div
                                                        onClick={(e) => {
                                                            e.stopPropagation();
                                                            openTab(conn.id);
                                                        }}
                                                        className="flex items-center gap-1.5 text-[10px] bg-app-surface border border-app-border rounded-full pl-1.5 pr-2.5 py-0.5 text-app-muted/80 cursor-pointer hover:border-app-accent/50 hover:text-app-text transition-colors"
                                                        title="Click to open/focus Connection Tab"
                                                    >
                                                        <div className={cn(
                                                            "w-1.5 h-1.5 rounded-full",
                                                            !isConnected
                                                                ? "bg-app-muted/30"
                                                                : hasTab
                                                                    ? "bg-app-success" // Active Workspace
                                                                    : "bg-transparent border border-app-accent/80" // Background Tunnel
                                                        )} />
                                                        <span className="truncate max-w-[150px]">{conn.name || conn.host}</span>
                                                    </div>
                                                )}
                                            </div>
                                        </div>

                                        <div className="text-xs text-app-muted flex items-center gap-2 font-mono pl-6 opacity-70">
                                            {tunnel.type === 'local' ? (
                                                <>
                                                    <span className="text-app-text/60">localhost:{tunnel.localPort}</span>
                                                    <ArrowRight size={10} className="text-app-muted/50" />
                                                    <span className="text-app-text/60">{tunnel.remoteHost}:{tunnel.remotePort}</span>
                                                </>
                                            ) : (
                                                <>
                                                    <span className="text-app-text/60">remote:{tunnel.remotePort}</span>
                                                    <ArrowRight size={10} className="text-app-muted/50" />
                                                    <span className="text-app-text/60">localhost:{tunnel.localPort}</span>
                                                </>
                                            )}
                                        </div>
                                        {tunnel.error && (
                                            <div className="text-xs text-red-400 pl-6 pt-0.5">{tunnel.error}</div>
                                        )}
                                    </div>

                                    <div className="flex items-center gap-2 opacity-90 group-hover:opacity-100 transition-opacity">
                                        {tunnel.type === 'local' && (
                                            <Button
                                                variant="ghost"
                                                size="sm"
                                                onClick={() => handleOpenBrowser(tunnel.localPort)}
                                                className="h-8 w-8 p-0 text-app-muted hover:text-blue-400"
                                                title="Open in Browser"
                                            >
                                                <ExternalLink size={14} />
                                            </Button>
                                        )}

                                        <Button
                                            variant="secondary"
                                            size="sm"
                                            onClick={() => handleToggleTunnel(tunnel)}
                                            className={cn(
                                                "min-w-[70px] h-8 text-xs font-medium transition-all border",
                                                tunnel.status === 'active'
                                                    ? "bg-red-500/5 text-red-400 border-red-500/20 hover:bg-red-500/10 hover:border-red-500/30"
                                                    : "bg-green-500/5 text-green-400 border-green-500/20 hover:bg-green-500/10 hover:border-green-500/30"
                                            )}
                                        >
                                            {tunnel.status === 'active' ? (
                                                <>
                                                    <Square size={10} className="mr-1.5 fill-current" /> Stop
                                                </>
                                            ) : (
                                                <>
                                                    <Play size={10} className="mr-1.5 fill-current" /> Start
                                                </>
                                            )}
                                        </Button>
                                    </div>
                                </div>
                            );
                        })}
                    </div>
                )}
            </div>
        </div>
    );
}
