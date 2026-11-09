import { Network } from 'lucide-react';

import { formatBytes } from '../../lib/utils';
import type { DashboardMetrics } from './dashboardMetrics';

interface NetworkWidgetProps {
    interfaces: DashboardMetrics['network'];
    loading: boolean;
}

/** Format measured rates independently; a missing baseline is not an idle interface. */
function transferRate(value: number | null): string {
    if (value === null) {
        return 'Waiting for rate sample';
    }
    if (!Number.isFinite(value) || value < 0) {
        return 'Unavailable';
    }
    const bytes = value > 0 && value < 1 ? `${value.toPrecision(2)} B` : formatBytes(value);
    return `${bytes}/s`;
}

/** Show each interface separately so virtual and physical links are never added twice. */
export function NetworkWidget({ interfaces, loading }: NetworkWidgetProps) {
    return (
        <section
            aria-label="Network interfaces"
            className="min-w-0 rounded-lg border border-app-border bg-app-panel p-4"
        >
            <h3 className="flex items-center gap-2 text-xs font-medium text-app-muted">
                <Network
                    size={14}
                    className="shrink-0"
                    aria-hidden
                />
                Network activity
            </h3>
            <p className="mt-2 text-xs text-app-muted">Receive and transmit rates per interface.</p>
            {interfaces === null ? (
                <p
                    role="status"
                    className="mt-3 text-sm text-app-muted"
                >
                    {loading ? 'Waiting for network sample' : 'Network readings are unavailable.'}
                </p>
            ) : interfaces.length === 0 ? (
                <p className="mt-3 text-sm text-app-muted">No network interfaces were returned.</p>
            ) : (
                <div
                    role="region"
                    aria-label="Network interface table"
                    tabIndex={0}
                    className="mt-3 max-h-64 max-w-full overflow-auto rounded focus-visible:outline focus-visible:outline-2 focus-visible:outline-app-accent"
                >
                    <table className="w-full min-w-[22rem] text-left text-xs">
                        <caption className="sr-only">
                            Measured receive and transmit rates for each network interface
                        </caption>
                        <thead className="text-app-muted">
                            <tr>
                                <th
                                    scope="col"
                                    className="px-2 py-2 font-medium"
                                >
                                    Interface
                                </th>
                                <th
                                    scope="col"
                                    className="px-2 py-2 text-right font-medium"
                                >
                                    Receive
                                </th>
                                <th
                                    scope="col"
                                    className="px-2 py-2 text-right font-medium"
                                >
                                    Transmit
                                </th>
                            </tr>
                        </thead>
                        <tbody>
                            {interfaces.map((entry) => (
                                <tr
                                    key={entry.name}
                                    className="border-t border-app-border"
                                >
                                    <th
                                        scope="row"
                                        className="max-w-56 break-all px-2 py-2 font-medium"
                                        title={entry.name}
                                    >
                                        {entry.name}
                                    </th>
                                    <td className="px-2 py-2 text-right tabular-nums">
                                        {transferRate(entry.receiveBytesPerSecond)}
                                    </td>
                                    <td className="px-2 py-2 text-right tabular-nums">
                                        {transferRate(entry.transmitBytesPerSecond)}
                                    </td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                </div>
            )}
        </section>
    );
}
