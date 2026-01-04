import { X, Globe, Settings as SettingsIcon } from 'lucide-react';
import { useConnections } from '../../context/ConnectionContext';
import { cn } from '../../lib/utils';

export function TabBar() {
    const { tabs, activeTabId, activateTab, closeTab } = useConnections();

    if (tabs.length === 0) return null;

    return (
        <div className="flex h-9 bg-app-bg border-b border-app-border overflow-x-auto no-scrollbar">
            {tabs.map(tab => (
                <div
                    key={tab.id}
                    onClick={() => activateTab(tab.id)}
                    className={cn(
                        "group flex items-center gap-2 px-3 py-1 min-w-[120px] max-w-[200px] text-sm border-r border-app-border cursor-pointer select-none transition-colors",
                        activeTabId === tab.id
                            ? "bg-app-panel text-white border-t-2 border-t-app-accent"
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
        </div>
    );
}
