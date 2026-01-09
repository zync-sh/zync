import { X, Settings as SettingsIcon, PanelLeftOpen, Network } from 'lucide-react';
import { OSIcon } from '../icons/OSIcon';
import { useConnections } from '../../context/ConnectionContext';
import { useSettings } from '../../context/SettingsContext';
import { cn } from '../../lib/utils';
import { WindowControls } from './WindowControls';

export function TabBar() {
    const { tabs, activeTabId, activateTab, closeTab, connections } = useConnections();
    const { settings, updateSettings } = useSettings();

    // if (tabs.length === 0) return null; // Logic change: We ALWAYS want the bar for dragging and controls, even if no tabs?
    // Actually if no tabs, we just show empty bar with controls.

    return (
        <div className="flex h-12 bg-app-bg items-center pl-4 pr-1 gap-2 app-drag-region">
            {/* Show Sidebar Toggle */}
            {settings.sidebarCollapsed && (
                <button
                    onClick={() => updateSettings({ sidebarCollapsed: false })}
                    className="mr-2 p-1.5 text-app-muted hover:text-app-text hover:bg-app-surface rounded-md transition-colors drag-none"
                    title="Show Sidebar"
                >
                    <PanelLeftOpen size={16} />
                </button>
            )}

            <div className="flex items-center gap-2 flex-1 overflow-x-auto no-scrollbar min-w-0">
                {tabs.map(tab => (
                    <div
                        key={tab.id}
                        onClick={() => activateTab(tab.id)}
                        className={cn(
                            "group flex items-center gap-2 px-2.5 py-1.5 h-8 text-sm rounded-md cursor-pointer select-none transition-all drag-none border border-transparent shrink-0",
                            activeTabId === tab.id
                                ? "bg-app-surface text-app-text shadow-sm font-medium"
                                : "text-app-muted hover:bg-app-surface hover:text-app-text border-transparent"
                        )}
                        title={tab.title}
                    >
                        {/* Icon based on type */}
                        {(() => {
                            if (tab.type === 'tunnels') return <Network size={13} />;
                            if (tab.type === 'settings') return <SettingsIcon size={13} />;

                            const conn = connections.find(c => c.id === tab.connectionId);
                            // Only use OSIcon for connection tabs
                            return <OSIcon icon={conn?.icon || 'Server'} className="w-[13px] h-[13px]" />;
                        })()}

                        <span className="truncate max-w-[120px]">{tab.title}</span>

                        <button
                            onClick={(e) => { e.stopPropagation(); closeTab(tab.id); }}
                            className={cn(
                                "p-0.5 rounded-sm hover:bg-black/10 dark:hover:bg-white/10 transition-colors",
                                activeTabId === tab.id ? "opacity-100" : "opacity-0 group-hover:opacity-100"
                            )}
                        >
                            <X size={12} />
                        </button>
                    </div>
                ))}
            </div>

            <div className="shrink-0 pl-2 border-l border-app-border/20">
                <WindowControls />
            </div>
        </div>
    );
}
