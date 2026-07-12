import type { ReactNode } from 'react';
import { ChevronDown } from 'lucide-react';
import { cn } from '../../../lib/utils';

export interface SplitSidebarActionButtonProps {
    icon: ReactNode;
    label: string;
    expanded: boolean;
    active?: boolean;
    /** Soft attention treatment — notice without shouting. */
    attention?: 'none' | 'setup' | 'secure' | 'locked' | 'ready';
    /** Optional compact badge (e.g. unsecured host count). */
    badge?: string | number | null;
    badgeTitle?: string;
    onPrimaryClick: () => void;
    onToggleClick: () => void;
    toggleAriaLabel?: string;
}

export function SplitSidebarActionButton({
    icon,
    label,
    expanded,
    active = false,
    attention = 'none',
    badge = null,
    badgeTitle,
    onPrimaryClick,
    onToggleClick,
    toggleAriaLabel = 'Toggle section menu',
}: SplitSidebarActionButtonProps) {
    const shellClassName = cn(
        'flex w-full overflow-hidden rounded-lg border',
        'bg-app-surface/30',
        active && 'text-app-text',
        attention === 'none' && (active ? 'border-app-border/30' : 'border-transparent'),
        attention === 'setup' && 'border-app-accent/25 bg-app-accent/[0.04]',
        attention === 'secure' && 'border-amber-500/25 bg-amber-500/[0.05]',
        attention === 'locked' && 'border-amber-500/20 bg-amber-500/[0.04]',
        attention === 'ready' && (active ? 'border-emerald-500/25' : 'border-transparent'),
    );

    const segmentClassName = cn(
        'group transition-all cursor-pointer select-none outline-none',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-app-accent focus-visible:ring-offset-2 focus-visible:ring-offset-app-bg',
        'text-app-muted hover:text-app-text hover:bg-app-surface/60',
    );

    const badgeClassName = cn(
        'ml-2 shrink-0 rounded-full px-1.5 py-0.5 text-[9px] font-semibold tabular-nums leading-none',
        attention === 'setup' && 'bg-app-accent/15 text-app-accent',
        attention === 'secure' && 'bg-amber-500/15 text-amber-900 dark:text-amber-200',
        attention === 'locked' && 'bg-amber-500/12 text-amber-900 dark:text-amber-200',
        attention === 'ready' && 'bg-emerald-500/15 text-emerald-800 dark:text-emerald-300',
        attention === 'none' && 'bg-app-muted/15 text-app-muted',
    );

    return (
        <div className={shellClassName}>
            <button
                type="button"
                title={badgeTitle}
                className={cn(
                    segmentClassName,
                    'flex flex-1 items-center py-2 px-3 min-w-0',
                    active && 'text-app-text',
                    attention === 'setup' && 'text-app-text/90',
                    attention === 'secure' && 'text-app-text/90',
                )}
                onClick={onPrimaryClick}
            >
                <span
                    className={cn(
                        'shrink-0 opacity-70 group-hover:opacity-100',
                        attention === 'setup' && 'text-app-accent opacity-90',
                        attention === 'secure' && 'text-[var(--color-app-warning)] opacity-90',
                        attention === 'locked' && 'text-[var(--color-app-warning)] opacity-85',
                        attention === 'ready' && 'text-emerald-600 dark:text-emerald-400 opacity-90',
                    )}
                >
                    {icon}
                </span>
                <span className="ml-3 truncate font-medium text-[10px] uppercase tracking-wider opacity-80 group-hover:opacity-100">
                    {label}
                </span>
                {badge != null && badge !== '' && (
                    <span className={badgeClassName} title={badgeTitle}>
                        {badge}
                    </span>
                )}
            </button>
            <button
                type="button"
                aria-expanded={expanded}
                aria-label={toggleAriaLabel}
                className={cn(
                    segmentClassName,
                    'flex w-8 shrink-0 items-center justify-center border-l border-app-border/25',
                )}
                onClick={onToggleClick}
            >
                <ChevronDown
                    size={12}
                    className={cn(
                        'opacity-60 transition-transform duration-200 group-hover:opacity-100',
                        expanded && 'rotate-180',
                    )}
                />
            </button>
        </div>
    );
}