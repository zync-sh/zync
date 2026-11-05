import { Activity, Cpu, Gauge, LayoutDashboard, Search } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';

import { getConnectionBackendEpoch } from '../../lib/terminal/connectionBackend';
import { Connection, useAppStore } from '../../store/useAppStore';
import { HostConnectionNotice } from '../connections/HostConnectionNotice';
import { createDashboardMetricsSampler } from './dashboardMetrics';
import { ProcessWidget } from './ProcessWidget';
import { QuickActionsWidget } from './QuickActionsWidget';
import { RadialProgress } from './RadialProgress';
import { ResourceWidget } from './ResourceWidget';
import { UptimeWidget } from './UptimeWidget';

const dashboardMetrics = createDashboardMetricsSampler({
    /** Executes one combined sample through the existing command boundary. */
    execute: (connectionId, command) =>
        window.ipcRenderer.invoke('ssh:exec', { connectionId, command }),
    readEpoch: getConnectionBackendEpoch,
});

/** Displays shared host samples only while this dashboard owns a visible live target. */
export function Dashboard({
    connectionId,
    isVisible = true,
}: {
    connectionId?: string;
    isVisible?: boolean;
}) {
    const globalId = useAppStore((state) => state.activeConnectionId);
    const connections = useAppStore((state) => state.connections);
    const settings = useAppStore((state) => state.settings);

    const activeConnectionId = connectionId || globalId;

    // Find connection status
    const isLocal = activeConnectionId === 'local';
    const connection = !isLocal
        ? connections.find((c: Connection) => c.id === activeConnectionId)
        : null;
    const isConnected = isLocal || connection?.status === 'connected';

    const [metrics, setMetrics] = useState({
        cpu: 0,
        ram: { used: 0, total: 0, percent: 0 },
        disk: { used: '0', total: '0', percent: 0 },
        info: { os: 'Loading...', kernel: '', arch: '' },
        uptime: '',
        processes: 0,
    });

    const [history, setHistory] = useState<{
        cpu: { time: string; value: number }[];
        ram: { time: string; value: number }[];
    }>({
        cpu: Array.from({ length: 20 }, () => ({ time: '', value: 0 })),
        ram: Array.from({ length: 20 }, () => ({ time: '', value: 0 })),
    });

    const [isSaturationDetected, setIsSaturationDetected] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const isFetching = useRef<{
        connectionId: string;
        epoch: number;
        isPolling: () => boolean;
    } | null>(null);
    const currentTarget = useRef({
        id: activeConnectionId,
        visible: isVisible,
        connected: isConnected,
    });
    currentTarget.current = { id: activeConnectionId, visible: isVisible, connected: isConnected };

    /** A visible pane owns its sample even when another workspace connection is globally active. */
    const fetchMetrics = useCallback(
        async (isPolling: () => boolean) => {
            const targetId = activeConnectionId;
            const epoch =
                targetId === 'local'
                    ? 0
                    : targetId
                      ? getConnectionBackendEpoch(targetId)
                      : undefined;
            if (!targetId || epoch === undefined || !isVisible || document.hidden) {
                return true;
            }
            if (
                isFetching.current?.connectionId === targetId &&
                isFetching.current.epoch === epoch &&
                isFetching.current.isPolling()
            ) {
                return true;
            }
            const request = { connectionId: targetId, epoch, isPolling };
            isFetching.current = request;
            /** Reject late samples/errors after hiding, switching or replacing this pane's transport. */
            const isCurrent = () =>
                isPolling() &&
                currentTarget.current.id === targetId &&
                currentTarget.current.visible &&
                currentTarget.current.connected &&
                (targetId === 'local' || getConnectionBackendEpoch(targetId) === epoch);
            try {
                const isWindowsLocal =
                    targetId === 'local' && navigator.userAgent.includes('Windows');
                const sample = await dashboardMetrics.sample(targetId, isWindowsLocal);
                if (!isCurrent()) {
                    return true;
                }
                const cpuLoad = sample.cpu;
                const memPercent = sample.ram.percent;
                const osName = sample.info.os;
                const now = new Date().toLocaleTimeString('en-US', {
                    hour12: false,
                    hour: '2-digit',
                    minute: '2-digit',
                    second: '2-digit',
                });
                setMetrics(sample);
                // Auto-detect and set icon based on OS if not already set
                if (targetId !== 'local' && osName) {
                    // ... (existing icon logic) ...
                    /** Maps sampled platform labels to the existing host icon choices. */
                    const detectOSIcon = (osName: string): string => {
                        const os = osName.toLowerCase();
                        if (os.includes('ubuntu')) {
                            return 'ubuntu';
                        }
                        if (os.includes('debian')) {
                            return 'debian';
                        }
                        if (
                            os.includes('centos') ||
                            os.includes('red hat') ||
                            os.includes('rhel')
                        ) {
                            return 'redhat';
                        }
                        if (os.includes('arch')) {
                            return 'arch';
                        }
                        if (os.includes('kali')) {
                            return 'kali';
                        }
                        if (os.includes('fedora') || os.includes('amazon linux')) {
                            return 'redhat';
                        }
                        if (os.includes('suse') || os.includes('opensuse')) {
                            return 'linux';
                        }
                        if (os.includes('windows')) {
                            return 'windows';
                        }
                        if (
                            os.includes('darwin') ||
                            os.includes('macos') ||
                            os.includes('mac os')
                        ) {
                            return 'macos';
                        }
                        if (os.includes('pop') || os.includes('mint')) {
                            return 'ubuntu';
                        }
                        return 'linux'; // Default fallback
                    };

                    const detectedIcon = detectOSIcon(osName);
                    void useAppStore
                        .getState()
                        .setConnectionIconIfMissing(targetId, detectedIcon)
                        .catch((error) =>
                            console.warn('Could not save detected host icon:', error),
                        );
                }

                setHistory((prev) => ({
                    cpu: [...prev.cpu.slice(1), { time: now, value: cpuLoad || 0 }],
                    ram: [...prev.ram.slice(1), { time: now, value: memPercent || 0 }],
                }));

                // Success - Clear saturation flag and error
                setIsSaturationDetected(false);
                setError(null);
                return true; // Continue polling
            } catch (error: unknown) {
                if (!isCurrent()) {
                    return true;
                }
                const errorMsg = error instanceof Error ? error.message : String(error);
                if (errorMsg.includes('Connection not found')) {
                    console.warn(
                        'Backend lost connection, stopping dashboard polling:',
                        activeConnectionId,
                    );
                    if (activeConnectionId) {
                        useAppStore.getState().disconnect(activeConnectionId as string);
                    }
                    return false; // Stop polling
                }

                // Handle Channel Open Failure - likely saturation
                if (errorMsg.includes('Channel open failure')) {
                    console.warn('SSH Channel saturation, skipping update and backing off');
                    setIsSaturationDetected(true);
                    // Do not disconnect, just skip this update cycle
                    return true;
                } else {
                    setError(errorMsg);
                    console.warn('Metrics polling failed:', error);
                    return true; // Continue trying?
                }
            } finally {
                if (isFetching.current === request) {
                    isFetching.current = null;
                }
            }
        },
        [activeConnectionId, isVisible],
    );

    useEffect(() => {
        if (!activeConnectionId || !isConnected || !isVisible) {
            return;
        }

        // Variable polling interval based on saturation status
        let timeoutId: ReturnType<typeof setTimeout>;
        let isActive = true; // Mounted flag
        void fetchMetrics(() => isActive);

        /** Schedules one next visible polling cycle with the existing saturation backoff. */
        const scheduleNext = () => {
            const delay = isSaturationDetected ? 15000 : 3000; // 15s backoff if saturated, else 3s
            timeoutId = setTimeout(async () => {
                if (!isActive) {
                    return;
                }
                const shouldContinue = await fetchMetrics(() => isActive);
                if (shouldContinue && isActive) {
                    scheduleNext(); // Recursive schedule
                }
            }, delay);
        };

        scheduleNext();

        return () => {
            isActive = false;
            clearTimeout(timeoutId);
        };
    }, [activeConnectionId, isConnected, isSaturationDetected, isVisible, fetchMetrics]); // Re-run if visibility changes so polling stops immediately when hidden
    if (!activeConnectionId) {
        const platform =
            (navigator as Navigator & { userAgentData?: { platform?: string } }).userAgentData
                ?.platform ?? navigator.userAgent;
        const isMac = /mac/i.test(platform);

        return (
            <div className="h-full flex flex-col items-center justify-center -mt-20 px-6">
                <div className="w-20 h-20 rounded-3xl bg-app-surface/50 border border-app-border/40 flex items-center justify-center mb-8 shadow-sm">
                    <LayoutDashboard className="text-app-muted/40 w-10 h-10" />
                </div>

                {/* Global Search Bar */}
                <div
                    className="relative group w-full max-w-md cursor-pointer mb-8 animate-in fade-in slide-in-from-bottom-2 duration-500"
                    onClick={() => {
                        window.dispatchEvent(new CustomEvent('zync:open-command-palette'));
                    }}
                >
                    <div className="absolute inset-y-0 left-0 pl-3.5 flex items-center pointer-events-none">
                        <Search className="h-4 w-4 text-app-muted group-hover:text-app-accent transition-colors" />
                    </div>
                    <div className="w-full bg-app-surface/40 hover:bg-app-surface/80 border border-app-border/50 hover:border-app-accent/50 rounded-xl text-app-muted text-sm px-4 py-3 pl-10 shadow-sm transition-all flex items-center justify-between">
                        <span>Search servers, tunnels, settings...</span>
                        <div className="flex bg-app-bg/60 rounded px-1.5 py-0.5 border border-app-border/40 shadow-sm opacity-70 group-hover:bg-app-accent/10 group-hover:text-app-accent group-hover:border-app-accent/30 transition-all">
                            <span className="text-[10px] font-mono font-medium tracking-wider">
                                {isMac ? '⌘' : 'Ctrl'}+P
                            </span>
                        </div>
                    </div>
                </div>

                <h3 className="text-xl font-semibold text-app-text">Welcome to Zync</h3>
                <p className="text-sm text-app-muted mt-2 max-w-sm text-center opacity-70 leading-relaxed">
                    Select a connection from the sidebar, or search for a host above to get started.
                </p>
            </div>
        );
    }

    // Metrics and remote actions belong to the live session; disconnected hosts keep a recovery action instead.
    if (!isConnected) {
        return (
            <div className="h-full min-h-0 overflow-auto bg-app-bg text-app-text">
                <div className="mx-auto max-w-5xl px-4 py-5 sm:px-7 sm:py-7">
                    <header className="flex min-w-0 items-center gap-3">
                        <LayoutDashboard
                            size={28}
                            className="shrink-0 text-app-accent"
                            aria-hidden="true"
                        />
                        <div className="min-w-0">
                            <h1 className="text-base font-semibold tracking-tight">
                                System overview
                            </h1>
                            <p className="mt-1 break-all text-xs text-app-muted">
                                {connection
                                    ? `${connection.username}@${connection.host}`
                                    : 'SSH host'}
                            </p>
                        </div>
                    </header>
                    <HostConnectionNotice
                        connectionId={activeConnectionId}
                        description="Connect to view live system metrics."
                        className="mt-5"
                    />
                </div>
            </div>
        );
    }

    // Dynamic class for grid columns based on dashboard width is best handled by CSS Grid auto-fit

    return (
        <div
            className={`p-8 overflow-auto h-full scroll-smooth ${settings.enableVibrancy ? 'dashboard-vibrancy' : ''}`}
        >
            {/* Header */}
            <div className="mb-8 flex justify-between items-end">
                <div>
                    <h1 className="text-4xl font-bold bg-gradient-to-r from-[var(--color-app-text)] to-[var(--color-app-muted)] bg-clip-text text-transparent mb-2">
                        System Overview
                    </h1>
                    <p className="text-[var(--color-app-muted)] text-base font-medium flex items-center gap-2">
                        <span
                            className={`w-2 h-2 rounded-full ${isConnected ? 'bg-emerald-500 shadow-[0_0_8px_rgba(16,185,129,0.5)]' : 'bg-red-500'}`}
                        />
                        {isConnected ? 'Live Monitoring' : 'Disconnected'}
                    </p>
                </div>
                <div className="text-right flex flex-col items-end gap-2">
                    {error && (
                        <div className="bg-red-500/10 text-red-400 text-[10px] px-2 py-1 rounded border border-red-500/20 max-w-[200px] truncate">
                            {error}
                        </div>
                    )}
                    {metrics.info.os !== 'Loading...' && (
                        <div className="bg-[var(--color-app-surface)]/50 backdrop-blur px-4 py-2 rounded-lg border border-[var(--color-app-border)] text-xs font-mono text-[var(--color-app-muted)]">
                            {metrics.info.os} {metrics.info.arch}
                        </div>
                    )}
                </div>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-4 gap-6 pb-20 auto-rows-[minmax(180px,auto)]">
                {/* Row 1: Primary Resources */}
                <ResourceWidget
                    title="CPU Usage"
                    value={`${metrics.cpu.toFixed(1)}%`}
                    subtext="Load Average"
                    icon={Cpu}
                    data={history.cpu}
                    color="#f43f5e"
                    className="md:col-span-1 xl:col-span-1"
                />

                <ResourceWidget
                    title="Memory Usage"
                    value={`${Math.round(metrics.ram.used)} MB`}
                    subtext={`of ${Math.round(metrics.ram.total)} MB`}
                    icon={Activity}
                    data={history.ram}
                    color="#8b5cf6"
                    className="md:col-span-1 xl:col-span-1"
                />

                {/* Disk & Process */}
                <RadialProgress
                    value={metrics.disk.percent}
                    label={metrics.disk.used}
                    subtext={metrics.disk.total}
                    color="#06b6d4"
                    className="md:col-span-1"
                />

                <ProcessWidget
                    count={metrics.processes}
                    className="md:col-span-1"
                />

                {/* Row 2: Uptime & Info */}
                <UptimeWidget
                    uptime={metrics.uptime}
                    className="md:col-span-1 xl:col-span-2"
                />

                <div className="bg-app-panel border border-[var(--color-app-border)] rounded-2xl p-6 flex flex-col justify-between shadow-sm backdrop-blur-xl bg-opacity-60 md:col-span-2 xl:col-span-2 relative overflow-hidden group hover:border-[var(--color-app-accent)]/50 transition-all">
                    <h3 className="text-xs font-medium text-[var(--color-app-muted)] uppercase tracking-wider flex items-center gap-2 mb-4">
                        <Gauge
                            size={14}
                            className="text-[var(--color-app-muted)]/70 group-hover:text-[var(--color-app-accent)] transition-colors"
                        />{' '}
                        System Info
                    </h3>

                    <div className="grid grid-cols-2 gap-4">
                        <div className="space-y-1">
                            <span className="text-xs text-[var(--color-app-muted)] uppercase">
                                Kernel
                            </span>
                            <div className="font-mono text-sm text-[var(--color-app-text)]">
                                {metrics.info.kernel || '-'}
                            </div>
                        </div>
                        <div className="space-y-1">
                            <span className="text-xs text-[var(--color-app-muted)] uppercase">
                                Architecture
                            </span>
                            <div className="font-mono text-sm text-[var(--color-app-text)]">
                                {metrics.info.arch || '-'}
                            </div>
                        </div>
                    </div>
                </div>
            </div>

            {/* Quick Actions */}
            <div className="pb-8">
                <QuickActionsWidget connectionId={activeConnectionId} />
            </div>
        </div>
    );
}
