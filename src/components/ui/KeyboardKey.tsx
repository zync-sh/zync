interface KeyboardKeyProps {
    children: string;
    className?: string;
}

export function KeyboardKey({ children, className = '' }: KeyboardKeyProps) {
    return (
        <kbd className={`inline-flex h-5 items-center justify-center px-1.5 min-w-[20px] text-[9px] font-semibold text-[var(--color-app-text)] bg-[var(--color-app-surface)] border border-[var(--color-app-border)] rounded ${className}`}>
            {children}
        </kbd>
    );
}
