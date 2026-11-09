import { ChevronRight, Layers } from 'lucide-react';

import { cn, formatBytes } from '../../lib/utils';
import { Select } from '../ui/Select';
import type { DashboardProcessSample, DashboardProcessSort } from './dashboardDetails';

interface ProcessWidgetProps {
    count: number | null;
    loading: boolean;
    className?: string;
}

/** Display the sampled process count without decorative bars that resemble measured history. */
export function ProcessWidget({ count, loading, className }: ProcessWidgetProps) {
    const available = count !== null && Number.isFinite(count) && count >= 0;
    const missingCount = loading ? 'Waiting for sample' : 'Unavailable';
    return (
        <section
            aria-label="Processes"
            className={cn(
                'min-w-0 rounded-lg border border-app-border bg-app-panel p-4',
                className,
            )}
        >
            <h3 className="flex items-center gap-2 text-xs font-medium text-app-muted">
                <Layers
                    size={14}
                    className="shrink-0"
                    aria-hidden="true"
                />
                Processes
            </h3>
            <p className="mt-2 text-sm font-medium text-app-text tabular-nums">
                {available ? Math.round(count).toLocaleString() : missingCount}
            </p>
        </section>
    );
}

interface ProcessDetailsWidgetProps {
    count: number | null;
    countLoading: boolean;
    open: boolean;
    onOpenChange(open: boolean): void;
    requestedSort: DashboardProcessSort;
    onSortChange(sort: DashboardProcessSort): void;
    sample: DashboardProcessSample | null;
    error: string | null;
    loading: boolean;
    stale?: boolean;
}

/** Present the sampler's selected process rows without changing commands or polling ownership. */
export function ProcessDetailsWidget({
    count,
    countLoading,
    open,
    onOpenChange,
    requestedSort,
    onSortChange,
    sample,
    error,
    loading,
    stale = false,
}: ProcessDetailsWidgetProps) {
    const availableCount = count !== null && Number.isFinite(count) && count >= 0;
    const usesMemoryFallback =
        sample?.sort === 'cpu' &&
        sample.items.length > 0 &&
        sample.items.every((process) => process.cpu === null);
    const appliedSortLabel =
        sample?.sort === 'cpu' && !usesMemoryFallback ? 'CPU usage' : 'memory usage';
    return (
        <section
            aria-label="Process details"
            className="min-w-0 rounded-lg border border-app-border bg-app-panel"
        >
            <details
                open={open}
                onToggle={(event) => {
                    if (event.currentTarget.open !== open) {
                        onOpenChange(event.currentTarget.open);
                    }
                }}
            >
                <summary className="flex cursor-pointer list-none items-center gap-2 rounded-lg p-4 text-sm focus-visible:outline focus-visible:outline-2 focus-visible:outline-app-accent [&::-webkit-details-marker]:hidden">
                    <ChevronRight
                        size={14}
                        className={cn('shrink-0 text-app-muted', open && 'rotate-90')}
                        aria-hidden
                    />
                    <Layers
                        size={14}
                        className="shrink-0 text-app-muted"
                        aria-hidden
                    />
                    <span className="min-w-0 flex-1">
                        <span className="block font-medium">Processes</span>
                        {!open && (
                            <span className="block text-xs text-app-muted">
                                Expand to inspect sampled processes
                            </span>
                        )}
                    </span>
                    <span className="text-xs text-app-muted tabular-nums">
                        {availableCount
                            ? `${Math.round(count).toLocaleString()} total`
                            : countLoading
                              ? 'Waiting for sample'
                              : 'Unavailable'}
                    </span>
                    <span className="sr-only">
                        {open ? 'Collapse process details' : 'Expand process details'}
                    </span>
                </summary>
                {open && (
                    <div className="min-w-0 space-y-3 border-t border-app-border p-4">
                        <div className="flex flex-wrap items-end justify-between gap-3">
                            <Select
                                ariaLabel="Sort process sample"
                                label="Sort process sample"
                                value={requestedSort}
                                options={[
                                    { value: 'cpu', label: 'CPU usage' },
                                    { value: 'memory', label: 'Memory usage' },
                                ]}
                                showSearch={false}
                                className="w-44 max-w-full"
                                onChange={(value) => {
                                    if (value === 'cpu' || value === 'memory') {
                                        onSortChange(value);
                                    }
                                }}
                            />
                            {sample && (
                                <time
                                    className="text-xs text-app-muted"
                                    dateTime={new Date(sample.sampledAt).toISOString()}
                                >
                                    Last updated {new Date(sample.sampledAt).toLocaleTimeString()}
                                </time>
                            )}
                        </div>
                        {loading && (
                            <p
                                role="status"
                                className="text-xs text-app-muted"
                            >
                                {sample ? 'Updating process sample…' : 'Collecting process sample…'}
                            </p>
                        )}
                        {stale && !error && sample && (
                            <p
                                role="status"
                                className="text-xs text-app-muted"
                            >
                                Process readings are out of date. Waiting for a fresh sample.
                            </p>
                        )}
                        {error && (
                            <div
                                role="alert"
                                className="rounded-md border border-app-border bg-app-surface/40 p-3 text-xs"
                            >
                                <p className="font-medium">Process update failed</p>
                                <p className="mt-1 text-app-muted">
                                    {sample
                                        ? 'Showing the last successful process sample; these readings may be out of date.'
                                        : 'No process sample has been received yet.'}
                                </p>
                                <details className="mt-2">
                                    <summary className="cursor-pointer rounded focus-visible:outline focus-visible:outline-2 focus-visible:outline-app-accent">
                                        Collection details
                                    </summary>
                                    <pre className="mt-2 whitespace-pre-wrap break-all text-app-muted">
                                        {error}
                                    </pre>
                                </details>
                            </div>
                        )}
                        {sample?.supported ? (
                            <>
                                <p className="text-xs text-app-muted">
                                    {sample.truncated
                                        ? 'The process scan was limited. These rows may omit busier processes elsewhere on the host.'
                                        : 'Processes selected from the collected sample.'}
                                </p>
                                {sample.sort !== requestedSort && sample.items.length > 0 && (
                                    <p
                                        role="status"
                                        className="text-xs text-app-muted"
                                    >
                                        Showing rows sorted by {appliedSortLabel}.
                                    </p>
                                )}
                                {usesMemoryFallback && (
                                    <p className="text-xs text-app-muted">
                                        CPU rates need consecutive valid samples. Until then, CPU
                                        sorting uses memory order.
                                    </p>
                                )}
                                {sample.items.length > 0 ? (
                                    <div
                                        role="region"
                                        aria-label="Process table"
                                        tabIndex={0}
                                        className="max-h-72 max-w-full overflow-auto rounded focus-visible:outline focus-visible:outline-2 focus-visible:outline-app-accent"
                                    >
                                        <table className="w-full min-w-[26rem] text-left text-xs">
                                            <caption className="sr-only">
                                                Sampled processes sorted by {appliedSortLabel}
                                            </caption>
                                            <thead className="text-app-muted">
                                                <tr>
                                                    <th
                                                        scope="col"
                                                        className="px-2 py-2 font-medium"
                                                    >
                                                        PID
                                                    </th>
                                                    <th
                                                        scope="col"
                                                        className="px-2 py-2 font-medium"
                                                    >
                                                        Process
                                                    </th>
                                                    <th
                                                        scope="col"
                                                        className="px-2 py-2 text-right font-medium"
                                                        title="CPU utilization as a percentage of all host CPUs"
                                                    >
                                                        CPU % of host
                                                    </th>
                                                    <th
                                                        scope="col"
                                                        className="px-2 py-2 text-right font-medium"
                                                    >
                                                        Memory
                                                    </th>
                                                </tr>
                                            </thead>
                                            <tbody>
                                                {sample.items.map((process) => (
                                                    <tr
                                                        key={process.pid}
                                                        className="border-t border-app-border"
                                                    >
                                                        <td className="px-2 py-2 font-mono tabular-nums">
                                                            {process.pid}
                                                        </td>
                                                        <td
                                                            className="max-w-64 break-all px-2 py-2"
                                                            title={process.name}
                                                        >
                                                            {process.name}
                                                        </td>
                                                        <td className="px-2 py-2 text-right tabular-nums">
                                                            {process.cpu === null
                                                                ? 'Waiting for CPU sample'
                                                                : `${process.cpu.toFixed(1)}%`}
                                                        </td>
                                                        <td className="whitespace-nowrap px-2 py-2 text-right tabular-nums">
                                                            {process.memoryBytes === null
                                                                ? 'Unavailable'
                                                                : formatBytes(process.memoryBytes)}
                                                        </td>
                                                    </tr>
                                                ))}
                                            </tbody>
                                        </table>
                                    </div>
                                ) : (
                                    <p className="text-xs text-app-muted">
                                        No process rows were returned.
                                    </p>
                                )}
                            </>
                        ) : (
                            !loading &&
                            !error && (
                                <p className="text-xs text-app-muted">
                                    {sample
                                        ? 'Process details are unavailable on this system.'
                                        : 'No process sample is available.'}
                                </p>
                            )
                        )}
                    </div>
                )}
            </details>
        </section>
    );
}
