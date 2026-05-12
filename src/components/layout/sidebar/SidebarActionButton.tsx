import type { ReactNode } from 'react';
import { cn } from '../../../lib/utils';

export interface SidebarActionButtonProps {
    icon: ReactNode;
    label: string;
    onClick: () => void;
    active?: boolean;
    nested?: boolean;
    trailing?: ReactNode;
}

export function SidebarActionButton({
    icon,
    label,
    onClick,
    active = false,
    nested = false,
    trailing,
}: SidebarActionButtonProps) {
    return (
        <button
            type="button"
            className={cn(
                "group relative flex items-center transition-all cursor-pointer select-none outline-none w-full rounded-lg border border-transparent",
                "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-app-accent focus-visible:ring-offset-2 focus-visible:ring-offset-app-bg",
                nested ? "py-1.5 px-3" : "py-2 px-3",
                nested
                    ? "bg-app-surface/20 hover:bg-app-surface/40 hover:border-app-border/20"
                    : "bg-app-surface/30 hover:bg-app-surface hover:border-app-border/30",
                "text-app-muted hover:text-app-text",
                active && (nested ? "bg-app-surface/40 text-app-text" : "text-app-text")
            )}
            onClick={onClick}
        >
            <span className={cn("shrink-0 opacity-70 group-hover:opacity-100", nested && "ml-3")}>
                {icon}
            </span>
            <span className="ml-3 truncate font-medium text-[10px] uppercase tracking-wider opacity-80 group-hover:opacity-100">
                {label}
            </span>
            {trailing && (
                <span className="ml-auto shrink-0 opacity-60 group-hover:opacity-100">
                    {trailing}
                </span>
            )}
        </button>
    );
}
