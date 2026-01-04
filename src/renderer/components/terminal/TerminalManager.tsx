import { useState, useEffect } from 'react';
import { TerminalComponent } from '../Terminal';
import { Plus, X, Terminal as TerminalIcon } from 'lucide-react';
import { cn } from '../../lib/utils';
import { useConnections } from '../../context/ConnectionContext';

interface TerminalTab {
    id: string;
    title: string;
}

export function TerminalManager({ connectionId }: { connectionId?: string }) {
    const { activeConnectionId: globalActiveId } = useConnections();
    const activeConnectionId = connectionId || globalActiveId;

    // We maintain a list of tabs. 
    // Initial state: One tab.
    const [tabs, setTabs] = useState<TerminalTab[]>([]);
    const [activeTabId, setActiveTabId] = useState<string | null>(null);

    // Initialize/Reset when connection changes
    useEffect(() => {
        if (activeConnectionId) {
            const initialTabId = `term-${Date.now()}`;
            setTabs([{ id: initialTabId, title: 'Terminal 1' }]);
            setActiveTabId(initialTabId);
        } else {
            setTabs([]);
            setActiveTabId(null);
        }
    }, [activeConnectionId]);

    const handleNewTab = () => {
        const newId = `term-${Date.now()}`;
        const newTab = { id: newId, title: `Terminal ${tabs.length + 1}` };
        setTabs(prev => [...prev, newTab]);
        setActiveTabId(newId);
    };

    const handleCloseTab = (id: string, e: React.MouseEvent) => {
        e.stopPropagation();

        // Kill backend process
        window.ipcRenderer.send('terminal:kill', { termId: id });

        setTabs(prev => {
            const newTabs = prev.filter(t => t.id !== id);
            if (newTabs.length === 0) {
                // If last tab closed, maybe create a new empty one or just leave empty?
                // Let's create a new one to mimic standard behavior
                /* 
                const newId = `term-${Date.now()}`;
                setActiveTabId(newId);
                return [{ id: newId, title: 'Terminal 1' }];
                */
                // Or just empty state
                setActiveTabId(null);
                return newTabs;
            }

            // If we closed the active tab, switch to the last one
            if (id === activeTabId) {
                setActiveTabId(newTabs[newTabs.length - 1].id);
            }
            return newTabs;
        });
    };

    if (!activeConnectionId) {
        return (
            <div className="h-full flex items-center justify-center text-app-muted">
                <p>Select a connection to view terminals</p>
            </div>
        );
    }

    return (
        <div className="flex flex-col h-full bg-app-bg">
            {/* Tab Bar */}
            <div className="flex items-center bg-app-panel border-b border-app-border">
                <div className="flex-1 flex overflow-x-auto scrollbar-hide">
                    {tabs.map(tab => (
                        <div
                            key={tab.id}
                            onClick={() => setActiveTabId(tab.id)}
                            className={cn(
                                "flex items-center gap-2 px-4 py-2 text-sm border-r border-app-border cursor-pointer min-w-[120px] max-w-[200px] group select-none",
                                activeTabId === tab.id
                                    ? "bg-app-bg text-white border-t-2 border-t-app-accent"
                                    : "text-app-muted hover:bg-app-surface hover:text-app-text border-t-2 border-t-transparent"
                            )}
                        >
                            <TerminalIcon size={14} />
                            <span className="truncate flex-1">{tab.title}</span>
                            <button
                                onClick={(e) => handleCloseTab(tab.id, e)}
                                className="opacity-0 group-hover:opacity-100 p-0.5 rounded hover:bg-white/10 text-app-muted hover:text-white transition-all"
                            >
                                <X size={12} />
                            </button>
                        </div>
                    ))}
                </div>

                <button
                    onClick={handleNewTab}
                    className="p-2 text-app-muted hover:text-white hover:bg-app-surface border-l border-app-border transition-colors h-full aspect-square flex items-center justify-center"
                    title="New Terminal Tab"
                >
                    <Plus size={16} />
                </button>
            </div>

            {/* Terminal Content Area */}
            <div className="flex-1 overflow-hidden relative bg-[#0f172a]">
                {tabs.length === 0 ? (
                    <div className="h-full flex flex-col items-center justify-center text-app-muted">
                        <TerminalIcon size={48} className="mb-4 opacity-20" />
                        <p>No active terminals</p>
                        <button onClick={handleNewTab} className="mt-4 text-app-accent hover:underline">Open New Terminal</button>
                    </div>
                ) : (
                    tabs.map(tab => (
                        <div
                            key={tab.id}
                            className={cn("absolute inset-0", activeTabId === tab.id ? "z-10" : "z-0 invisible")}
                        >
                            {/* We keep the component mounted but use CSS visibility to hide it.
                                This perserves the XTerm state/buffer but stops it from rendering.
                                Note: 'invisible' is better than display:none for some canvas sizing reasons in xterm potentially,
                                but display:none is safer for layout. Let's try display:none via 'hidden' class if visibility fails sizing.
                            */}
                            <div className={cn("h-full w-full", activeTabId !== tab.id && "hidden")}>
                                <TerminalComponent connectionId={activeConnectionId} termId={tab.id} />
                            </div>
                        </div>
                    ))
                )}
            </div>
        </div>
    );
}
