import { useState, useEffect } from 'react';
import { Minus, Square, X, Copy } from 'lucide-react';

export function WindowControls() {
    const [isMaximized, setIsMaximized] = useState(false);
    const [isFocused, setIsFocused] = useState(true);

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
        // State update will happen via resize listener or we can toggle conservatively
    };

    const close = () => {
        window.ipcRenderer?.send('window:close');
    };

    return (
        <div className={`flex items-center h-full drag-none z-50 transition-opacity duration-200 ${isFocused ? 'opacity-100' : 'opacity-40'}`}>
            <button
                onClick={minimize}
                className="h-full w-9 flex items-center justify-center hover:bg-white/10 transition-colors focus:outline-none text-app-muted hover:text-white"
                title="Minimize"
            >
                <Minus size={14} strokeWidth={2} />
            </button>
            <button
                onClick={maximize}
                className="h-full w-9 flex items-center justify-center hover:bg-white/10 transition-colors focus:outline-none text-app-muted hover:text-white"
                title="Maximize"
            >
                {isMaximized ? (
                    <Copy size={12} strokeWidth={2} className="rotate-180" />
                ) : (
                    <Square size={11} strokeWidth={2} />
                )}
            </button>
            <button
                onClick={close}
                className="h-full w-9 flex items-center justify-center hover:bg-red-500 hover:text-white transition-colors focus:outline-none text-app-muted"
                title="Close"
            >
                <X size={14} strokeWidth={2} />
            </button>
        </div>
    );
}
