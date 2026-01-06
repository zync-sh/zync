import { cn } from '../../lib/utils';
import { HardDrive } from 'lucide-react';

interface RadialProgressProps {
    value: number;
    label: string;
    subtext: string;
    color?: string;
    className?: string;
}

export function RadialProgress({ value, label, subtext, color = '#3b82f6', className }: RadialProgressProps) {
    // Circle math
    const radius = 34;
    const circumference = 2 * Math.PI * radius;
    const offset = circumference - (value / 100) * circumference;

    return (
        <div className={cn(
            'bg-app-panel border border-[var(--color-app-border)] rounded-2xl p-5 flex items-center justify-between shadow-sm transition-all hover:border-[var(--color-app-accent)]/50 hover:shadow-md group relative overflow-hidden backdrop-blur-xl bg-opacity-60',
            className
        )}>
            <div className='flex flex-col z-10'>
                <h3 className="text-xs font-medium text-[var(--color-app-muted)] uppercase tracking-wider flex items-center gap-2 mb-1">
                    <HardDrive size={14} className={cn("text-[var(--color-app-muted)]/70 group-hover:text-[var(--color-app-accent)] transition-colors")} />
                    Disk Usage
                </h3>
                <span className="text-3xl font-bold text-[var(--color-app-text)] tracking-tight">{value}%</span>
                <span className="text-xs text-[var(--color-app-muted)]/70">{label} / {subtext}</span>
            </div>

            <div className="relative w-20 h-20 flex items-center justify-center shrink-0">
                {/* Background Circle */}
                <svg className="transform -rotate-90 w-full h-full">
                    <circle
                        cx="40"
                        cy="40"
                        r={radius}
                        stroke="currentColor"
                        strokeWidth="8"
                        fill="transparent"
                        className="text-[var(--color-app-surface)]"
                    />
                    {/* Progress Circle */}
                    <circle
                        cx="40"
                        cy="40"
                        r={radius}
                        stroke={color}
                        strokeWidth="8"
                        fill="transparent"
                        strokeDasharray={circumference}
                        strokeDashoffset={offset}
                        strokeLinecap="round"
                        className="transition-all duration-1000 ease-out"
                    />
                </svg>
            </div>
        </div>
    );
}
