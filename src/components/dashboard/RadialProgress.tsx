import { HardDrive } from 'lucide-react';

import { cn } from '../../lib/utils';

interface RadialProgressProps {
    value: number | null;
    label: string;
    subtext: string;
    loading: boolean;
    className?: string;
}

/** Present disk usage in a compact meter and distinguish pending, missing, and measured readings. */
export function RadialProgress({ value, label, subtext, loading, className }: RadialProgressProps) {
    const percentage =
        value !== null && Number.isFinite(value) ? Math.min(100, Math.max(0, value)) : null;
    const reading = loading ? 'Waiting for sample' : 'Unavailable';
    const description = loading ? 'Used space / total space' : 'No reading available';
    return (
        <section
            aria-label="Disk usage"
            className={cn(
                'min-w-0 rounded-lg border border-app-border bg-app-panel p-4',
                className,
            )}
        >
            <h3 className="flex items-center gap-2 text-xs font-medium text-app-muted">
                <HardDrive
                    size={14}
                    className="shrink-0"
                    aria-hidden="true"
                />
                Disk usage
            </h3>
            <div className="mt-2 flex flex-wrap items-baseline gap-x-2 gap-y-1">
                <span className="text-2xl font-semibold tracking-tight text-app-text tabular-nums">
                    {percentage === null ? reading : `${Math.round(percentage)}%`}
                </span>
                <span className="text-xs text-app-muted">
                    {percentage === null ? description : `${label} of ${subtext}`}
                </span>
            </div>
            <div className="mt-4 flex h-10 items-center">
                {percentage !== null && (
                    <div
                        role="meter"
                        aria-label="Disk usage"
                        aria-valuemin={0}
                        aria-valuemax={100}
                        aria-valuenow={percentage}
                        aria-valuetext={`${Math.round(percentage)} percent, ${label} of ${subtext}`}
                        className="h-1.5 w-full overflow-hidden rounded-full bg-app-surface"
                    >
                        <div
                            className="h-full rounded-full bg-app-accent"
                            style={{ width: `${percentage}%` }}
                        />
                    </div>
                )}
            </div>
        </section>
    );
}
