import { useEffect, useState } from 'react';

export function KeybindingRow({
    label,
    binding,
    onChange
}: {
    label: string;
    binding: string;
    onChange: (val: string) => void;
}) {
    const [isRecording, setIsRecording] = useState(false);
    const displayBinding = binding || '';
    const bindingParts = displayBinding ? displayBinding.split('+') : [];

    useEffect(() => {
        if (!isRecording) return;

        const handleKeyDown = (e: KeyboardEvent) => {
            e.preventDefault();
            e.stopPropagation();

            if (e.key === 'Escape') {
                setIsRecording(false);
                return;
            }

            const parts: string[] = [];
            if (e.ctrlKey) parts.push('Ctrl');
            if (e.metaKey) parts.push('Mod');
            if (e.altKey) parts.push('Alt');
            if (e.shiftKey) parts.push('Shift');

            if (['Control', 'Meta', 'Alt', 'Shift'].includes(e.key)) return;

            let key = e.key;
            if (key === ' ') key = 'Space';
            if (key.length === 1) key = key.toUpperCase();
            parts.push(key);

            onChange(parts.join('+'));
            setIsRecording(false);
        };

        window.addEventListener('keydown', handleKeyDown, { capture: true });
        return () => window.removeEventListener('keydown', handleKeyDown, { capture: true });
    }, [isRecording, onChange]);

    return (
        <div className="flex items-center justify-between p-3 bg-[var(--color-app-bg)]/30 rounded-lg border border-[var(--color-app-border)] hover:border-[var(--color-app-accent)]/50 transition-colors">
            <span className="text-[var(--color-app-text)] font-medium">{label}</span>
            <button
                onClick={() => setIsRecording(true)}
                className={`flex items-center gap-1 px-3 py-1.5 rounded-md text-xs font-mono border transition-all min-w-[100px] justify-center
                    ${isRecording
                        ? 'bg-[var(--color-app-accent)] text-white border-[var(--color-app-accent)] animate-pulse'
                        : 'bg-[var(--color-app-surface)] border-[var(--color-app-border)] text-[var(--color-app-text)] hover:border-[var(--color-app-accent)]'
                    }`}
            >
                {isRecording
                    ? 'Recording...'
                    : bindingParts.length === 0
                        ? 'Not set'
                        : bindingParts.map((k, i) => (
                            <span key={i} className="flex items-center">
                                {k}
                                {i < bindingParts.length - 1 && <span className="mx-1 opacity-50">+</span>}
                            </span>
                        ))}
            </button>
        </div>
    );
}
