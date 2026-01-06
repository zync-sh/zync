import { cn } from '../../lib/utils';
import { Clock } from 'lucide-react';

interface UptimeWidgetProps {
    uptime: string;
    className?: string;
}

export function UptimeWidget({ uptime, className }: UptimeWidgetProps) {
    // Format uptime nicely if possible (assuming 'up X days, Y hours, ...')
    // Let's just display it prominently

    return (
        <div className={cn(
            'bg-app-panel border border-[var(--color-app-border)] rounded-2xl p-5 flex flex-col justify-between shadow-sm transition-all hover:border-[var(--color-app-accent)]/50 hover:shadow-md group relative overflow-hidden backdrop-blur-xl bg-opacity-60',
            className
        )}>
            <h3 className="text-xs font-medium text-[var(--color-app-muted)] uppercase tracking-wider flex items-center gap-2 mb-1">
                <Clock size={14} className={cn("text-[var(--color-app-muted)]/70 group-hover:text-[var(--color-app-accent)] transition-colors")} />
                System Uptime
            </h3>

            <div className="flex-1 flex items-center">
                <span className="text-xl font-bold text-[var(--color-app-text)] tracking-tight line-clamp-2 leading-relaxed">
                    {uptime || "Calculating..."}
                </span>
            </div>

            <div className="w-full h-1 bg-[var(--color-app-surface)] rounded-full mt-2 overflow-hidden">
                <div className="h-full bg-[var(--color-app-accent)]/50 w-full animate-pulse"></div>
            </div>
        </div>
    );
}
