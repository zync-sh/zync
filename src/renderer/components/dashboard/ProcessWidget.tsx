import { cn } from '../../lib/utils';
import { Layers } from 'lucide-react';

interface ProcessWidgetProps {
    count: number;
    className?: string;
}

export function ProcessWidget({ count, className }: ProcessWidgetProps) {
    return (
        <div className={cn(
            'bg-app-panel border border-[var(--color-app-border)] rounded-2xl p-5 flex items-center justify-between shadow-sm transition-all hover:border-[var(--color-app-accent)]/50 hover:shadow-md group relative overflow-hidden backdrop-blur-xl bg-opacity-60',
            className
        )}>
            <div className='flex flex-col z-10'>
                <h3 className="text-xs font-medium text-[var(--color-app-muted)] uppercase tracking-wider flex items-center gap-2 mb-1">
                    <Layers size={14} className={cn("text-[var(--color-app-muted)]/70 group-hover:text-[var(--color-app-accent)] transition-colors")} />
                    Processes
                </h3>
                <span className="text-3xl font-bold text-[var(--color-app-text)] tracking-tight">{count}</span>
                <span className="text-xs text-[var(--color-app-muted)]/70">Active Tasks</span>
            </div>

            <div className="flex gap-1 items-end h-16 w-16 opacity-50 group-hover:opacity-80 transition-opacity">
                {[40, 70, 45, 90, 60].map((h, i) => (
                    <div
                        key={i}
                        className="w-2 rounded-t bg-[var(--color-app-accent)] transition-all duration-500"
                        style={{ height: `${h}%` }}
                    />
                ))}
            </div>
        </div>
    );
}
