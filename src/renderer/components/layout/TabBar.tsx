import { X, Settings as SettingsIcon, PanelLeftOpen, Network } from 'lucide-react';
import { OSIcon } from '../icons/OSIcon';
import { useAppStore, Tab, Connection } from '../../store/useAppStore'; // Updated Import
import { cn } from '../../lib/utils';
import { WindowControls } from './WindowControls';
import { useState, useEffect } from 'react';
import { Modal } from '../ui/Modal';
import { matchShortcut } from '../managers/ShortcutManager';

export function TabBar() {
    // Zustand Integrations
    const tabs = useAppStore(state => state.tabs);
    const activeTabId = useAppStore(state => state.activeTabId);
    const activateTab = useAppStore(state => state.activateTab);
    const closeTab = useAppStore(state => state.closeTab);
    const connections = useAppStore(state => state.connections);

    // Settings Slice
    const settings = useAppStore(state => state.settings);
    const updateSettings = useAppStore(state => state.updateSettings);

    const [tabToClose, setTabToClose] = useState<string | null>(null);

    const handleCloseTab = (id: string, e?: React.MouseEvent) => {
        e?.stopPropagation();

        // Use fresh state
        const state = useAppStore.getState();
        const tab = state.tabs.find((t: Tab) => t.id === id);
        if (!tab) return;

        // Check if it's an active host connection (not Settings, Tunnels, or Local)
        if (tab.type === 'connection' && tab.connectionId && tab.connectionId !== 'local') {
            const conn = state.connections.find((c: Connection) => c.id === tab.connectionId);
            if (conn && conn.status === 'connected') {
                setTabToClose(id);
                return;
            }
        }

        // Otherwise close immediately using store action
        state.closeTab(id);
    };

    const confirmClose = () => {
        if (tabToClose) {
            closeTab(tabToClose);
            setTabToClose(null);
        }
    };

    // Handle Ctrl+W (or configured keybinding) to close active tab
    useEffect(() => {
        const handleKeyDown = (e: KeyboardEvent) => {
            const state = useAppStore.getState();
            const closeTabShortcut = state.settings.keybindings?.closeTab || 'Mod+W';

            if (matchShortcut(e, closeTabShortcut)) {
                e.preventDefault();
                e.stopPropagation(); // Stop terminal from receiving it
                const activeId = state.activeTabId;
                if (activeId) {
                    handleCloseTab(activeId);
                }
            }
        };

        window.addEventListener('keydown', handleKeyDown, true); // Use capture phase
        return () => window.removeEventListener('keydown', handleKeyDown, true);
    }, []);

    return (
        <>
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
                    {tabs.map((tab: Tab) => (
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

                                const conn = connections.find((c: Connection) => c.id === tab.connectionId);
                                // Only use OSIcon for connection tabs
                                return <OSIcon icon={conn?.icon || 'Server'} className="w-[13px] h-[13px]" />;
                            })()}

                            <span className="truncate max-w-[120px]">{tab.title}</span>

                            <button
                                onClick={(e) => handleCloseTab(tab.id, e)}
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

            <Modal
                isOpen={!!tabToClose}
                onClose={() => setTabToClose(null)}
                title="Disconnect & Close?"
            >
                <div className="space-y-4">
                    <p className="text-sm text-app-muted">
                        This will disconnect the active SSH session.
                    </p>
                    <div className="flex justify-end gap-2 text-sm">
                        <button
                            onClick={() => setTabToClose(null)}
                            className="px-3 py-1.5 hover:bg-app-surface rounded text-app-text transition-colors"
                        >
                            Cancel
                        </button>
                        <button
                            onClick={confirmClose}
                            className="px-3 py-1.5 bg-red-500/10 text-red-500 hover:bg-red-500/20 rounded font-medium transition-colors"
                        >
                            Disconnect
                        </button>
                    </div>
                </div>
            </Modal>
        </>
    );
}
