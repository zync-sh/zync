import { Clock } from 'lucide-react';

import { cn } from '../../lib/utils';

interface UptimeWidgetProps {
    uptime: string;
    loading: boolean;
    className?: string;
}

/** Show the reported uptime as metadata without implying a separate progress measurement. */
export function UptimeWidget({ uptime, loading, className }: UptimeWidgetProps) {
    return (
        <section
            aria-label="System uptime"
            className={cn(
                'min-w-0 rounded-lg border border-app-border bg-app-panel p-4',
                className,
            )}
        >
            <h3 className="flex items-center gap-2 text-xs font-medium text-app-muted">
                <Clock
                    size={14}
                    className="shrink-0"
                    aria-hidden="true"
                />
                System uptime
            </h3>
            <p className="mt-2 break-words text-sm font-medium text-app-text tabular-nums">
                {uptime || (loading ? 'Waiting for sample' : 'Unavailable')}
            </p>
        </section>
    );
}
