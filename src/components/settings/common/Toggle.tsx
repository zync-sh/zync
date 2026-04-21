import { useId } from 'react';

export function Toggle({
    label,
    description,
    checked,
    onChange,
    disabled = false,
}: {
    label: string;
    description: string;
    checked: boolean;
    onChange: (v: boolean) => void;
    disabled?: boolean;
}) {
    const descriptionId = useId();
    const containerClass = `w-full text-left flex items-center justify-between py-3 px-4 rounded-lg transition-colors group ${disabled ? 'opacity-50 cursor-not-allowed' : 'hover:bg-[var(--color-app-surface)]/30 focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-app-accent)] focus-visible:bg-[var(--color-app-surface)]/30 cursor-pointer'}`;

    return (
        <button
            type="button"
            role="switch"
            aria-checked={checked}
            aria-describedby={descriptionId}
            aria-disabled={disabled}
            disabled={disabled}
            onClick={() => onChange(!checked)}
            className={containerClass}
        >
            <div className="flex-1">
                <div className="text-sm font-medium text-[var(--color-app-text)]">{label}</div>
                <div id={descriptionId} className="text-xs text-[var(--color-app-muted)] mt-0.5">{description}</div>
            </div>
            <div
                className={`shrink-0 w-11 h-6 rounded-full transition-all relative ${checked ? 'bg-[var(--color-app-accent)]' : 'bg-[var(--color-app-surface)] border border-[var(--color-app-border)]'
                    }`}
            >
                <div className={`absolute top-0.5 left-0.5 w-5 h-5 rounded-full bg-white shadow-sm transition-transform ${checked ? 'translate-x-5' : 'translate-x-0'}`} />
            </div>
        </button>
    );
}
