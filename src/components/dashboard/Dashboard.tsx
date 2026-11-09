import { Activity, Cpu, Gauge, LayoutDashboard, Search } from 'lucide-react';
import { useState } from 'react';

import { getConnectionDisplayLabels } from '../../features/connections/domain/connectionDisplay';
import { useAppStore } from '../../store/useAppStore';
import { HostConnectionNotice } from '../connections/HostConnectionNotice';
import { Button } from '../ui/Button';
import { PanelHeader } from '../ui/PanelHeader';
import type { DashboardProcessSort } from './dashboardDetails';
import { FilesystemWidget } from './FilesystemWidget';
import { NetworkWidget } from './NetworkWidget';
import { ProcessDetailsWidget, ProcessWidget } from './ProcessWidget';
import { QuickActionsWidget } from './QuickActionsWidget';
import { RadialProgress } from './RadialProgress';
import { ResourceWidget } from './ResourceWidget';
import { UptimeWidget } from './UptimeWidget';
import { useDashboardDetails } from './useDashboardDetails';
import { useDashboardMetrics } from './useDashboardMetrics';

/** Label the binary memory units returned by free/CIM without oversized raw MiB counts. */
function formatMemory(mib: number | null | undefined, fallback = 'Not available'): string {
    if (mib === null || mib === undefined || !Number.isFinite(mib) || mib < 0) {
        return fallback;
    }
    return mib >= 1024 ? `${(mib / 1024).toFixed(1)} GiB` : `${Math.round(mib)} MiB`;
}

/** Own one visible host's readings while sharing acquisition across matching dashboard panes. */
export function Dashboard({
    connectionId,
    isVisible = true,
}: {
    connectionId?: string;
    isVisible?: boolean;
}) {
    const globalId = useAppStore((state) => state.activeConnectionId);
    const connections = useAppStore((state) => state.connections);
    const enableVibrancy = useAppStore((state) => state.settings.enableVibrancy);
    const showAddresses = useAppStore((state) => state.settings.privacy?.showHostAddressesInLists);
    const activeConnectionId = connectionId || globalId;
    const isLocal = activeConnectionId === 'local';
    const connection = isLocal
        ? undefined
        : connections.find((item) => item.id === activeConnectionId);
    const isConnected = isLocal || connection?.status === 'connected';
    const [processesOpen, setProcessesOpen] = useState(false);
    const [filesystemsOpen, setFilesystemsOpen] = useState(false);
    const [processSort, setProcessSort] = useState<DashboardProcessSort>('cpu');
    const {
        reading: currentReading,
        issue: currentIssue,
        loading: metricsLoading,
        stale,
    } = useDashboardMetrics({
        connectionId: activeConnectionId,
        isConnected,
        isVisible,
    });
    const detailResources = useDashboardDetails({
        connectionId: activeConnectionId,
        isConnected,
        isVisible,
        processesOpen,
        filesystemsOpen,
        processSort,
    });

    if (!activeConnectionId) {
        const platform =
            (navigator as Navigator & { userAgentData?: { platform?: string } }).userAgentData
                ?.platform ?? navigator.userAgent;
        return (
            <div className="flex h-full flex-col items-center justify-center gap-3 px-6 text-center">
                <LayoutDashboard
                    className="h-8 w-8 text-app-muted"
                    aria-hidden
                />
                <h2 className="text-base font-medium text-app-text">Welcome to Zync</h2>
                <p className="max-w-sm text-sm text-app-muted">
                    Select a connection from the sidebar to view its system overview.
                </p>
                <Button
                    type="button"
                    variant="secondary"
                    className="gap-2"
                    onClick={() =>
                        window.dispatchEvent(new CustomEvent('zync:open-command-palette'))
                    }
                >
                    <Search
                        size={14}
                        aria-hidden
                    />{' '}
                    Search servers and settings{' '}
                    <kbd className="text-xs text-app-muted">
                        {/mac/i.test(platform) ? 'Cmd' : 'Ctrl'}+P
                    </kbd>
                </Button>
            </div>
        );
    }

    const metrics = currentReading?.metrics;
    const memory = metrics?.ram;
    const systemInfo = [metrics?.info.os, metrics?.info.arch].filter(Boolean).join(' ');
    const summaryFallback = metricsLoading ? 'Waiting for sample' : 'Not available';
    const state = metricsLoading ? 'loading' : !metrics ? 'unavailable' : stale ? 'stale' : 'live';
    const labels = connection ? getConnectionDisplayLabels(connection, showAddresses) : null;
    const status = !isConnected
        ? 'Disconnected'
        : !isVisible
          ? 'Monitoring paused'
          : currentIssue
            ? currentIssue.saturated
                ? 'Metrics delayed'
                : 'Metrics update failed'
            : !metrics
              ? 'Collecting metrics…'
              : stale
                ? 'Metrics out of date'
                : 'Live Monitoring';
    return (
        <section
            aria-label="System overview"
            data-dashboard-state={state}
            className={`h-full min-h-0 overflow-auto bg-app-bg text-app-text ${enableVibrancy ? 'dashboard-vibrancy' : ''}`}
        >
            <PanelHeader
                title="System overview"
                icon={<LayoutDashboard size={16} />}
                description={labels ? `${labels.primary} · ${labels.secondary}` : 'Local machine'}
                actions={
                    <div className="flex flex-col items-end gap-1 text-xs text-app-muted">
                        <span
                            role="status"
                            className="flex items-center gap-1.5"
                        >
                            <span
                                aria-hidden
                                className={`h-1.5 w-1.5 rounded-full ${isConnected && !stale && metrics ? 'bg-app-accent' : 'bg-app-muted'}`}
                            />
                            {status}
                        </span>
                        {currentReading && isConnected && (
                            <time dateTime={new Date(currentReading.updatedAt).toISOString()}>
                                Last updated{' '}
                                {new Date(currentReading.updatedAt).toLocaleTimeString()}
                            </time>
                        )}
                    </div>
                }
            />
            {!isConnected ? (
                <div className="mx-auto max-w-5xl p-4">
                    <HostConnectionNotice
                        connectionId={activeConnectionId}
                        description="Connect to view live system metrics."
                    />
                </div>
            ) : (
                <div className="mx-auto grid max-w-[90rem] gap-3 p-3">
                    {currentIssue && (
                        <div
                            className="rounded-lg border border-app-border bg-app-surface/40 p-3 text-sm"
                            role="alert"
                        >
                            <h3 className="font-medium">
                                {currentIssue.saturated
                                    ? 'The server is busy'
                                    : 'Metrics update failed'}
                            </h3>
                            <p className="mt-1 text-xs text-app-muted">
                                {metrics
                                    ? 'Showing the last successful readings.'
                                    : 'No metrics have been received yet.'}{' '}
                                Zync will retry while this dashboard is visible.
                            </p>
                            <details className="mt-2 text-xs">
                                <summary className="cursor-pointer rounded focus-visible:outline focus-visible:outline-2 focus-visible:outline-app-accent">
                                    Metric details
                                </summary>
                                <pre className="mt-2 whitespace-pre-wrap break-all font-mono text-app-muted">
                                    {currentIssue.message}
                                </pre>
                            </details>
                        </div>
                    )}
                    <div
                        role="group"
                        aria-label="Resource metrics"
                        className="grid grid-cols-[repeat(auto-fit,minmax(min(100%,15rem),1fr))] gap-3"
                    >
                        <ResourceWidget
                            title="CPU Usage"
                            value={
                                metrics?.cpu == null
                                    ? summaryFallback
                                    : `${metrics.cpu.toFixed(1)}%`
                            }
                            subtext={
                                metrics?.cpu === null
                                    ? 'No valid CPU reading yet'
                                    : 'Utilization across all CPUs'
                            }
                            icon={Cpu}
                            data={currentReading?.history.cpu ?? []}
                        >
                            <dl className="grid grid-cols-2 gap-x-3 gap-y-2 text-xs">
                                <div>
                                    <dt className="text-app-muted">Logical CPUs</dt>
                                    <dd className="mt-1 tabular-nums">
                                        {metrics?.cpuDetails.cores?.toLocaleString() ??
                                            summaryFallback}
                                    </dd>
                                </div>
                                <div>
                                    <dt className="text-app-muted">I/O wait</dt>
                                    <dd className="mt-1 tabular-nums">
                                        {metrics?.cpuDetails.iowait == null
                                            ? summaryFallback
                                            : `${metrics.cpuDetails.iowait.toFixed(1)}%`}
                                    </dd>
                                </div>
                                <div className="col-span-2">
                                    <dt className="text-app-muted">
                                        Load average · 1 / 5 / 15 min
                                    </dt>
                                    <dd className="mt-1 tabular-nums">
                                        {metrics?.cpuDetails.loadAverage
                                            ?.map((value) => value.toFixed(2))
                                            .join(' / ') ?? summaryFallback}
                                    </dd>
                                </div>
                            </dl>
                        </ResourceWidget>
                        <ResourceWidget
                            title="Memory Usage"
                            value={
                                memory?.percent == null
                                    ? summaryFallback
                                    : `${memory.percent.toFixed(1)}%`
                            }
                            subtext={
                                memory?.used != null && memory.total != null
                                    ? `${formatMemory(memory.used)} of ${formatMemory(memory.total)}`
                                    : 'Used memory / total memory'
                            }
                            icon={Activity}
                            data={currentReading?.history.ram ?? []}
                        >
                            <dl className="grid grid-cols-2 gap-x-3 gap-y-2 text-xs">
                                <div>
                                    <dt className="text-app-muted">Available</dt>
                                    <dd className="mt-1 tabular-nums">
                                        {formatMemory(memory?.available, summaryFallback)}
                                    </dd>
                                </div>
                                <div>
                                    <dt className="text-app-muted">Cached</dt>
                                    <dd className="mt-1 tabular-nums">
                                        {formatMemory(memory?.cached, summaryFallback)}
                                    </dd>
                                </div>
                                <div className="col-span-2">
                                    <dt className="text-app-muted">
                                        Swap / page file · used / total
                                    </dt>
                                    <dd className="mt-1 tabular-nums">
                                        {!memory?.swap
                                            ? summaryFallback
                                            : memory.swap.total === 0
                                              ? 'Not configured'
                                              : `${formatMemory(memory.swap.used)} / ${formatMemory(memory.swap.total)}`}
                                    </dd>
                                </div>
                            </dl>
                        </ResourceWidget>
                        <RadialProgress
                            value={metrics?.disk.percent ?? null}
                            label={metrics?.disk.used ?? 'Not available'}
                            subtext={metrics?.disk.total ?? 'Not available'}
                            loading={metricsLoading}
                        />
                    </div>
                    <NetworkWidget
                        interfaces={metrics?.network ?? null}
                        loading={metricsLoading}
                    />
                    <div className="grid grid-cols-[repeat(auto-fit,minmax(min(100%,13rem),1fr))] gap-3">
                        <UptimeWidget
                            uptime={metrics?.uptime ?? ''}
                            loading={metricsLoading}
                        />
                        <ProcessWidget
                            count={metrics?.processes ?? null}
                            loading={metricsLoading}
                        />
                        <section
                            aria-label="System Info"
                            className="min-w-0 rounded-lg border border-app-border bg-app-panel p-4"
                        >
                            <h3 className="flex items-center gap-2 text-xs font-medium text-app-muted">
                                <Gauge
                                    size={14}
                                    aria-hidden
                                />
                                System Info
                            </h3>
                            <p className="mt-3 break-words text-sm font-medium">
                                {systemInfo || summaryFallback}
                            </p>
                            <dl className="mt-2 text-xs">
                                <dt className="text-app-muted">Kernel</dt>
                                <dd className="mt-1 break-all font-mono">
                                    {metrics?.info.kernel || summaryFallback}
                                </dd>
                            </dl>
                        </section>
                    </div>
                    <ProcessDetailsWidget
                        count={metrics?.processes ?? null}
                        countLoading={metricsLoading}
                        open={processesOpen}
                        onOpenChange={setProcessesOpen}
                        requestedSort={processSort}
                        onSortChange={setProcessSort}
                        sample={detailResources.processes.reading?.sample ?? null}
                        error={detailResources.processes.issue?.message ?? null}
                        stale={detailResources.processes.stale}
                        loading={detailResources.processes.loading}
                    />
                    <FilesystemWidget
                        open={filesystemsOpen}
                        onOpenChange={setFilesystemsOpen}
                        sample={detailResources.filesystems.reading?.sample ?? null}
                        error={detailResources.filesystems.issue?.message ?? null}
                        stale={detailResources.filesystems.stale}
                        loading={detailResources.filesystems.loading}
                    />
                    <QuickActionsWidget connectionId={activeConnectionId} />
                </div>
            )}
        </section>
    );
}
