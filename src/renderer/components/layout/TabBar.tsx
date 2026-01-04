import { X, Globe, Settings as SettingsIcon } from 'lucide-react';
import { useConnections } from '../../context/ConnectionContext';
import { cn } from '../../lib/utils';
import { WindowControls } from './WindowControls';

export function TabBar() {
    const { tabs, activeTabId, activateTab, closeTab } = useConnections();

    // if (tabs.length === 0) return null; // Logic change: We ALWAYS want the bar for dragging and controls, even if no tabs?
    // Actually if no tabs, we just show empty bar with controls.
    
    return (
        <div className="flex h-9 bg-app-panel border-b border-app-border overflow-x-auto no-scrollbar app-drag-region items-center pr-2">
            {tabs.map(tab => (
                <div
                    key={tab.id}
                    onClick={() => activateTab(tab.id)}
                    className={cn(
                        "group flex items-center gap-2 px-3 py-1 min-w-[120px] max-w-[200px] text-sm border-r border-app-border cursor-pointer select-none transition-colors drag-none",
                        activeTabId === tab.id
                            ? "bg-app-panel text-app-accent border-t-2 border-t-app-accent font-medium shadow-sm"
                            : "text-app-muted hover:bg-app-surface border-t-2 border-t-transparent"
                    )}
                >
                    {/* Icon based on type */}
                    {tab.type === 'connection' ? <Globe size={13} /> : <SettingsIcon size={13} />}

                    <span className="truncate flex-1">{tab.title}</span>

                    <button
                        onClick={(e) => { e.stopPropagation(); closeTab(tab.id); }}
                        className="opacity-0 group-hover:opacity-100 hover:bg-app-bg p-0.5 rounded text-app-muted hover:text-white transition-all"
                    >
                        <X size={12} />
                    </button>
                </div>
            ))}
            
            <div className="flex-1" />
            
            <WindowControls />
        </div>
    );
}
