import type { ReactNode } from 'react';

export function TabButton({
    active,
    onClick,
    icon,
    label,
    dimmed = false,
    badge = false
}: {
    active: boolean;
    onClick: () => void;
    icon: ReactNode;
    label: string;
    dimmed?: boolean;
    badge?: boolean;
}) {
    return (
        <button
            onClick={onClick}
            aria-current={active && !dimmed ? 'true' : undefined}
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
                <div className="absolute right-2 top-1/2 -translate-y-1/2">
                    <span className="sr-only">New notifications</span>
                    <div
                        aria-hidden="true"
                        className="w-2 h-2 bg-[var(--color-app-accent)] rounded-full motion-safe:animate-pulse motion-reduce:animate-none shadow-[0_0_8px_var(--color-app-accent)]"
                    />
                </div>
            )}
        </button>
    );
}
