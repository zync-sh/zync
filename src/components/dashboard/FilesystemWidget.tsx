import { ChevronRight, HardDrive } from 'lucide-react';

import { cn, formatBytes } from '../../lib/utils';
import type { DashboardDetailSample, DashboardFilesystem } from './dashboardDetails';

interface FilesystemWidgetProps {
    open: boolean;
    onOpenChange(open: boolean): void;
    sample: DashboardDetailSample<DashboardFilesystem> | null;
    error: string | null;
    loading: boolean;
    stale?: boolean;
}

/** Keep unavailable filesystem percentages distinct from a valid empty or idle reading. */
function percentage(value: number | null): string {
    return value === null || !Number.isFinite(value) ? 'Unavailable' : `${value.toFixed(1)}%`;
}

/** Render the on-demand filesystem sample only while its controlled disclosure is open. */
export function FilesystemWidget({
    open,
    onOpenChange,
    sample,
    error,
    loading,
    stale = false,
}: FilesystemWidgetProps) {
    return (
        <section
            aria-label="Filesystems"
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
                    <HardDrive
                        size={14}
                        className="shrink-0 text-app-muted"
                        aria-hidden
                    />
                    <span className="min-w-0 flex-1 font-medium">Filesystems</span>
                    <span className="text-xs text-app-muted">
                        {sample?.supported ? `${sample.items.length} sampled` : 'Expand to inspect'}
                    </span>
                    <span className="sr-only">
                        {open ? 'Collapse filesystems' : 'Expand filesystems'}
                    </span>
                </summary>
                {open && (
                    <div className="min-w-0 space-y-3 border-t border-app-border p-4">
                        {sample && (
                            <time
                                className="block text-xs text-app-muted"
                                dateTime={new Date(sample.sampledAt).toISOString()}
                            >
                                Last updated {new Date(sample.sampledAt).toLocaleTimeString()}
                            </time>
                        )}
                        {loading && (
                            <p
                                role="status"
                                className="text-xs text-app-muted"
                            >
                                {sample
                                    ? 'Updating filesystem sample…'
                                    : 'Collecting filesystem sample…'}
                            </p>
                        )}
                        {stale && !error && sample && (
                            <p
                                role="status"
                                className="text-xs text-app-muted"
                            >
                                Filesystem readings are out of date. Waiting for a fresh sample.
                            </p>
                        )}
                        {error && (
                            <div
                                role="alert"
                                className="rounded-md border border-app-border bg-app-surface/40 p-3 text-xs"
                            >
                                <p className="font-medium">Filesystem update failed</p>
                                <p className="mt-1 text-app-muted">
                                    {sample
                                        ? 'Showing the last successful filesystem sample; these readings may be out of date.'
                                        : 'No filesystem sample has been received yet.'}
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
                                {sample.truncated && (
                                    <p className="text-xs text-app-muted">
                                        The filesystem scan was limited. Some mounts may not be
                                        included.
                                    </p>
                                )}
                                {sample.items.length > 0 ? (
                                    <div
                                        role="region"
                                        aria-label="Filesystem table"
                                        tabIndex={0}
                                        className="max-h-80 max-w-full overflow-auto rounded focus-visible:outline focus-visible:outline-2 focus-visible:outline-app-accent"
                                    >
                                        <table className="w-full min-w-[48rem] text-left text-xs">
                                            <caption className="sr-only">
                                                Sampled local filesystem space and inode usage
                                            </caption>
                                            <thead className="text-app-muted">
                                                <tr>
                                                    <th
                                                        scope="col"
                                                        className="px-2 py-2 font-medium"
                                                    >
                                                        Mount
                                                    </th>
                                                    <th
                                                        scope="col"
                                                        className="px-2 py-2 font-medium"
                                                    >
                                                        Source
                                                    </th>
                                                    <th
                                                        scope="col"
                                                        className="px-2 py-2 font-medium"
                                                    >
                                                        Type
                                                    </th>
                                                    <th
                                                        scope="col"
                                                        className="px-2 py-2 text-right font-medium"
                                                    >
                                                        Used
                                                    </th>
                                                    <th
                                                        scope="col"
                                                        className="px-2 py-2 text-right font-medium"
                                                    >
                                                        Total
                                                    </th>
                                                    <th
                                                        scope="col"
                                                        className="px-2 py-2 text-right font-medium"
                                                    >
                                                        Available
                                                    </th>
                                                    <th
                                                        scope="col"
                                                        className="px-2 py-2 text-right font-medium"
                                                    >
                                                        Usage
                                                    </th>
                                                    <th
                                                        scope="col"
                                                        className="px-2 py-2 text-right font-medium"
                                                    >
                                                        Inodes
                                                    </th>
                                                </tr>
                                            </thead>
                                            <tbody>
                                                {sample.items.map((filesystem) => (
                                                    <tr
                                                        key={filesystem.key}
                                                        className="border-t border-app-border"
                                                    >
                                                        <th
                                                            scope="row"
                                                            className="max-w-64 break-all px-2 py-2 font-medium"
                                                            title={filesystem.mount}
                                                        >
                                                            {filesystem.mount}
                                                        </th>
                                                        <td
                                                            className="max-w-64 break-all px-2 py-2"
                                                            title={filesystem.source}
                                                        >
                                                            {filesystem.source}
                                                        </td>
                                                        <td className="px-2 py-2">
                                                            {filesystem.type || 'Unavailable'}
                                                        </td>
                                                        <td className="whitespace-nowrap px-2 py-2 text-right tabular-nums">
                                                            {filesystem.usedBytes === null
                                                                ? 'Unavailable'
                                                                : formatBytes(filesystem.usedBytes)}
                                                        </td>
                                                        <td className="whitespace-nowrap px-2 py-2 text-right tabular-nums">
                                                            {filesystem.totalBytes === null
                                                                ? 'Unavailable'
                                                                : formatBytes(
                                                                      filesystem.totalBytes,
                                                                  )}
                                                        </td>
                                                        <td className="whitespace-nowrap px-2 py-2 text-right tabular-nums">
                                                            {filesystem.availableBytes === null
                                                                ? 'Unavailable'
                                                                : formatBytes(
                                                                      filesystem.availableBytes,
                                                                  )}
                                                        </td>
                                                        <td className="whitespace-nowrap px-2 py-2 text-right tabular-nums">
                                                            {percentage(filesystem.percent)}
                                                        </td>
                                                        <td className="whitespace-nowrap px-2 py-2 text-right tabular-nums">
                                                            {percentage(filesystem.inodePercent)}
                                                        </td>
                                                    </tr>
                                                ))}
                                            </tbody>
                                        </table>
                                    </div>
                                ) : (
                                    <p className="text-xs text-app-muted">
                                        No eligible local filesystems were returned.
                                    </p>
                                )}
                            </>
                        ) : (
                            !loading &&
                            !error && (
                                <p className="text-xs text-app-muted">
                                    {sample
                                        ? 'Filesystem details are unavailable on this system.'
                                        : 'No filesystem sample is available.'}
                                </p>
                            )
                        )}
                    </div>
                )}
            </details>
        </section>
    );
}
