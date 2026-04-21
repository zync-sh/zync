import type { ReactNode } from 'react';

export function TabButton({
    active,
    onClick,
    icon,
    label,
    dimmed = false,
    badge = false,
    badgeLabel,
    tabIndex = 0,
}: {
    active: boolean;
    onClick: () => void;
    icon: ReactNode;
    label: string;
    dimmed?: boolean;
    badge?: boolean;
    badgeLabel?: string;
    tabIndex?: number;
}) {
    return (
        <button
            type="button"
            onClick={onClick}
            role="tab"
            aria-selected={active && !dimmed}
            tabIndex={tabIndex}
            className={`w-full relative flex items-center gap-2.5 px-3 py-2 rounded-md text-sm transition-all ${dimmed ? 'opacity-30 cursor-default' :
                active
                    ? 'bg-[var(--color-app-surface)] text-[var(--color-app-text)] font-medium shadow-sm'
                    : 'text-[var(--color-app-muted)] hover:text-[var(--color-app-text)] hover:bg-[var(--color-app-surface)]/50'
                }`}
            disabled={dimmed}
        >
            {icon}
            <span>{label}</span>
            {badge && !active && (
                <span className="absolute right-2 top-1/2 -translate-y-1/2">
                    <span className="sr-only">{badgeLabel || 'New notifications'}</span>
                    <span
                        aria-hidden="true"
                        className="block w-2 h-2 bg-[var(--color-app-accent)] rounded-full motion-safe:animate-pulse motion-reduce:animate-none shadow-[0_0_8px_var(--color-app-accent)]"
                    />
                </span>
            )}
        </button>
    );
}
