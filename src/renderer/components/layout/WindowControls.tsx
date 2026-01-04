import { Minus, Square, X, Copy } from 'lucide-react';
import { useState, useEffect } from 'react';

export function WindowControls() {
    const [isMaximized, setIsMaximized] = useState(false);

    useEffect(() => {
        const checkMaximized = async () => {
            const max = await window.ipcRenderer.invoke('window:is-maximized');
            setIsMaximized(max);
        };
        
        checkMaximized();
        window.addEventListener('resize', checkMaximized);
        return () => window.removeEventListener('resize', checkMaximized);
    }, []);

    const minimize = () => window.ipcRenderer.send('window:minimize');
    const toggleMaximize = () => {
        window.ipcRenderer.send('window:maximize');
        setIsMaximized(!isMaximized);
    };
    const close = () => window.ipcRenderer.send('window:close');

    return (
        <div className="flex items-center h-full -mr-2 drag-none z-50">
            <button 
                onClick={minimize}
                className="h-8 w-10 flex items-center justify-center text-app-muted hover:text-white hover:bg-white/10 transition-colors"
                title="Minimize"
            >
                <Minus size={16} />
            </button>
            <button 
                onClick={toggleMaximize}
                className="h-8 w-10 flex items-center justify-center text-app-muted hover:text-white hover:bg-white/10 transition-colors"
                title={isMaximized ? "Restore" : "Maximize"}
            >
                {isMaximized ? <Copy size={14} className="rotate-180" /> : <Square size={14} />}
            </button>
            <button 
                onClick={close}
                className="h-8 w-10 flex items-center justify-center text-app-muted hover:text-white hover:bg-red-500 hover:text-white transition-colors"
                title="Close"
            >
                <X size={16} />
            </button>
        </div>
    );
}
