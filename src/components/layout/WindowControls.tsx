import { useState, useEffect } from 'react';
import { Minus, X, Square, Copy } from 'lucide-react';
import { cn } from '../../lib/utils';

export function WindowControls({ className }: { className?: string }) {
    const [isMaximized, setIsMaximized] = useState(false);
    const [isFocused, setIsFocused] = useState(true);
    const platform = window.electronUtils?.platform || 'linux';
    const isMac = platform === 'darwin';

    useEffect(() => {
        // Check initial state
        const checkMaximized = async () => {
            const max = await window.ipcRenderer?.invoke('window:is-maximized');
            setIsMaximized(!!max);
        };
        checkMaximized();
        setIsFocused(document.hasFocus());

        // Focus listeners
        const onFocus = () => setIsFocused(true);
        const onBlur = () => setIsFocused(false);

        // Listen for resize/maximize events
        const onResize = () => {
            checkMaximized();
        };

        window.addEventListener('resize', onResize);
        window.addEventListener('focus', onFocus);
        window.addEventListener('blur', onBlur);

        return () => {
            window.removeEventListener('resize', onResize);
            window.removeEventListener('focus', onFocus);
            window.removeEventListener('blur', onBlur);
        };
    }, []);

    const minimize = () => {
        window.ipcRenderer?.send('window:minimize');
    };

    const maximize = () => {
        window.ipcRenderer?.send('window:maximize');
    };

    const close = () => {
        window.ipcRenderer?.send('window:close');
    };

    if (isMac) {
        return (
            <div className={cn(
                "flex items-center gap-2 px-3 h-full drag-none z-50 transition-all duration-300",
                isFocused ? 'opacity-100' : 'opacity-40 grayscale-[0.5]',
                className
            )}>
                {/* macOS Close (Red) */}
                <button
                    onClick={close}
                    className="h-3 w-3 rounded-full bg-[#ff5f56] border border-[#e0443e] hover:brightness-90 active:brightness-75 transition-all focus:outline-none flex items-center justify-center group"
                    title="Close"
                >
                    <X size={8} className="text-black/30 opacity-0 group-hover:opacity-100 transition-opacity" strokeWidth={3} />
                </button>

                {/* macOS Minimize (Yellow) */}
                <button
                    onClick={minimize}
                    className="h-3 w-3 rounded-full bg-[#ffbd2e] border border-[#dea123] hover:brightness-90 active:brightness-75 transition-all focus:outline-none flex items-center justify-center group"
                    title="Minimize"
                >
                    <Minus size={8} className="text-black/30 opacity-0 group-hover:opacity-100 transition-opacity" strokeWidth={3} />
                </button>

                {/* macOS Maximize (Green) */}
                <button
                    onClick={maximize}
                    className="h-3 w-3 rounded-full bg-[#27c93f] border border-[#1aab29] hover:brightness-90 active:brightness-75 transition-all focus:outline-none flex items-center justify-center group"
                    title={isMaximized ? "Restore" : "Maximize"}
                >
                    {isMaximized ? (
                        <div className="w-1.5 h-1.5 border border-black/30 opacity-0 group-hover:opacity-100 transition-opacity" />
                    ) : (
                        <PlusIcon size={8} /> // Internal helper for better green dot look
                    )}
                </button>
            </div>
        );
    }

    return (
        <div className={cn(
            "flex items-center gap-1.5 px-3 h-full drag-none z-50 transition-all duration-300",
            isFocused ? 'opacity-100' : 'opacity-40 grayscale-[0.2]',
            className
        )}>
            {/* Minimize */}
            <button
                onClick={minimize}
                className="h-7 w-7 rounded-full flex items-center justify-center hover:bg-app-surface active:bg-app-surface/50 transition-all focus:outline-none group"
                title="Minimize"
            >
                <Minus size={14} className="text-app-muted group-hover:text-app-text transition-colors" strokeWidth={2} />
            </button>

            {/* Maximize / Restore */}
            <button
                onClick={maximize}
                className="h-7 w-7 rounded-full flex items-center justify-center hover:bg-app-surface active:bg-app-surface/50 transition-all focus:outline-none group"
                title={isMaximized ? "Restore" : "Maximize"}
            >
                {isMaximized ? (
                    <Copy size={11} className="text-app-muted group-hover:text-app-text transition-colors" strokeWidth={2} />
                ) : (
                    <Square size={11} className="text-app-muted group-hover:text-app-text transition-colors" strokeWidth={2} />
                )}
            </button>

            {/* Close */}
            <button
                onClick={close}
                className="h-7 w-7 rounded-full flex items-center justify-center hover:bg-red-500 active:bg-red-600 transition-all focus:outline-none group"
                title="Close"
            >
                <X size={14} className="text-app-muted group-hover:text-white transition-colors" strokeWidth={2} />
            </button>
        </div>
    );
}

// Helper for macOS maximize icon
function PlusIcon({ size }: { size: number }) {
    return (
        <svg width={size} height={size} viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" className="text-black/30 opacity-0 group-hover:opacity-100 transition-opacity">
            <path d="M12 5V19M5 12H19" stroke="currentColor" strokeWidth="4" strokeLinecap="round" />
        </svg>
    );
}
