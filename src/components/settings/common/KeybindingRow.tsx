import { useEffect, useRef, useState } from 'react';

export function KeybindingRow({
    label,
    binding,
    onChange
}: {
    label: string;
    binding: string;
    onChange: (val: string) => void;
}) {
    const isMac = typeof navigator !== 'undefined' && navigator.platform.toUpperCase().includes('MAC');
    const [isRecording, setIsRecording] = useState(false);
    const onChangeRef = useRef(onChange);
    const displayBinding = binding || '';
    const bindingParts = displayBinding
        ? displayBinding.split('+').map((part) => part === 'Plus' ? '+' : part)
        : [];
    const displayText = isRecording
        ? 'Recording...'
        : bindingParts.length === 0
            ? 'Not set'
            : bindingParts.join('+');

    useEffect(() => {
        onChangeRef.current = onChange;
    }, [onChange]);

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
            if ((isMac && e.metaKey) || (!isMac && e.ctrlKey)) parts.push('Mod');
            if (isMac && e.ctrlKey && !e.metaKey) parts.push('Ctrl');
            if (e.altKey) parts.push('Alt');
            if (e.shiftKey) parts.push('Shift');

            if (['Control', 'Meta', 'Alt', 'Shift'].includes(e.key)) return;

            let key = e.key;
            if (key === ' ') key = 'Space';
            if (key === '+') key = 'Plus';
            if (key.length === 1) key = key.toUpperCase();
            parts.push(key);

            onChangeRef.current(parts.join('+'));
            setIsRecording(false);
        };

        const stopRecording = () => setIsRecording(false);
        const handleVisibilityChange = () => {
            if (document.visibilityState !== 'visible') {
                setIsRecording(false);
            }
        };
        const timeoutId = window.setTimeout(() => setIsRecording(false), 8000);

        window.addEventListener('keydown', handleKeyDown, { capture: true });
        window.addEventListener('blur', stopRecording);
        document.addEventListener('visibilitychange', handleVisibilityChange);
        return () => {
            window.removeEventListener('keydown', handleKeyDown, { capture: true });
            window.removeEventListener('blur', stopRecording);
            document.removeEventListener('visibilitychange', handleVisibilityChange);
            window.clearTimeout(timeoutId);
        };
    }, [isRecording]);

    return (
        <div className="flex items-center justify-between p-3 bg-[var(--color-app-bg)]/30 rounded-lg border border-[var(--color-app-border)] hover:border-[var(--color-app-accent)]/50 transition-colors">
            <span className="text-[var(--color-app-text)] font-medium">{label}</span>
            <button
                type="button"
                onClick={() => setIsRecording(true)}
                aria-label={`${label}: ${displayText}`}
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
