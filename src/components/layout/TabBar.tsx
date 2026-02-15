import { X, Settings as SettingsIcon, PanelLeftOpen, Network } from 'lucide-react';
import { OSIcon } from '../icons/OSIcon';
import { useAppStore, Tab, Connection } from '../../store/useAppStore'; // Updated Import
import { cn } from '../../lib/utils';
import { WindowControls } from './WindowControls';
import { useState, useEffect, useRef } from 'react';
import { ConfirmModal } from '../ui/ConfirmModal';
import { matchShortcut } from '../../lib/shortcuts';
import { useWindowDrag } from '../../hooks/useWindowDrag';
import {
    DndContext,
    closestCenter,
    PointerSensor,
    useSensor,
    useSensors,
    DragOverlay,
    DragStartEvent,
    DragEndEvent
} from '@dnd-kit/core';
import {
    SortableContext,
    useSortable,
    horizontalListSortingStrategy,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';

// Extract SortableTab component
function SortableTab({
    tab,
    isActive,
    onActivate,
    onClose,
    connections
}: {
    tab: Tab;
    isActive: boolean;
    onActivate: (id: string) => void;
    onClose: (id: string, e: React.MouseEvent) => void;
    connections: Connection[];
}) {
    const {
        attributes,
        listeners,
        setNodeRef,
        transform,
        transition,
        isDragging
    } = useSortable({ id: tab.id });

    const style = {
        transform: CSS.Transform.toString(transform),
        transition,
        zIndex: isDragging ? 10 : 'auto',
        opacity: isDragging ? 0.3 : 1
    };

    return (
        <div
            ref={setNodeRef}
            style={style}
            {...attributes}
            {...listeners}
            onClick={() => onActivate(tab.id)}
            className={cn(
                "group flex items-center gap-2 px-2.5 py-1.5 h-8 text-sm rounded-md cursor-pointer select-none border border-transparent shrink-0 outline-none drag-none",
                isActive
                    ? "bg-app-surface text-app-text shadow-sm font-medium"
                    : "text-app-muted hover:bg-app-surface hover:text-app-text border-transparent"
            )}
            title={tab.title}
        >
            {/* Icon based on type */}
            {(() => {
                if (tab.type === 'port-forwarding') return <Network size={13} />;
                if (tab.type === 'settings') return <SettingsIcon size={13} />;

                const conn = connections.find((c: Connection) => c.id === tab.connectionId);
                return <OSIcon icon={conn?.icon || 'Server'} className="w-[13px] h-[13px]" />;
            })()}

            <span className="truncate max-w-[120px]">{tab.title}</span>

            <button
                onClick={(e) => onClose(tab.id, e)}
                // Prevent drag on close button
                onPointerDown={(e) => e.stopPropagation()}
                className={cn(
                    "p-0.5 rounded-sm hover:bg-black/10 dark:hover:bg-white/10 transition-colors",
                    isActive ? "opacity-100" : "opacity-0 group-hover:opacity-100"
                )}
            >
                <X size={12} />
            </button>
        </div>
    );
}

export function TabBar() {
    // Zustand Integrations
    const tabs = useAppStore(state => state.tabs);
    const activeTabId = useAppStore(state => state.activeTabId);
    const activateTab = useAppStore(state => state.activateTab);
    const closeTab = useAppStore(state => state.closeTab);
    const connections = useAppStore(state => state.connections);
    const reorderTabs = useAppStore(state => state.reorderTabs);

    // Settings Slice
    const settings = useAppStore(state => state.settings);
    const updateSettings = useAppStore(state => state.updateSettings);

    const [tabToClose, setTabToClose] = useState<string | null>(null);

    // Window drag hook for Linux compatibility
    const dragRegionRef = useRef<HTMLDivElement>(null);
    useWindowDrag(dragRegionRef, true);

    const handleCloseTab = (id: string, e?: React.MouseEvent) => {
        e?.stopPropagation();

        // Use fresh state
        const state = useAppStore.getState();
        const tab = state.tabs.find((t: Tab) => t.id === id);
        if (!tab) return;

        // Check if it's an active host connection (not Settings, Port Forwarding, or Local)
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


    const [activeDragId, setActiveDragId] = useState<string | null>(null);

    const sensors = useSensors(
        useSensor(PointerSensor, {
            activationConstraint: {
                distance: 8,
            },
        })
    );

    const handleDragStart = (event: DragStartEvent) => {
        setActiveDragId(event.active.id as string);
    };

    const handleDragEnd = (event: DragEndEvent) => {
        const { active, over } = event;

        if (over && active.id !== over.id) {
            const oldIndex = tabs.findIndex(t => t.id === active.id);
            const newIndex = tabs.findIndex(t => t.id === over.id);
            reorderTabs(oldIndex, newIndex);
        }
        setActiveDragId(null);
    };

    const platform = window.electronUtils?.platform || 'linux';
    const isMac = platform === 'darwin';

    return (
        <>
            <div ref={dragRegionRef} className={cn(
                "flex h-12 bg-app-bg items-center pr-1 gap-2 app-drag-region shrink-0 select-none",
                isMac && settings.sidebarCollapsed ? "pl-4" : "pl-1"
            )} data-tauri-drag-region>

                {/* macOS Controls on Left (Only when sidebar is collapsed) */}
                {isMac && settings.sidebarCollapsed && (
                    <div className="shrink-0 flex items-center pr-2">
                        <WindowControls />
                    </div>
                )}

                {/* Show Sidebar Toggle (Shift left if Mac) */}
                {settings.sidebarCollapsed && (
                    <button
                        onClick={() => updateSettings({ sidebarCollapsed: false })}
                        className={cn(
                            "p-1.5 text-app-muted hover:text-app-text hover:bg-app-surface rounded-md transition-colors drag-none",
                            isMac ? "ml-0" : "ml-3"
                        )}
                        title="Show Sidebar"
                    >
                        <PanelLeftOpen size={16} />
                    </button>
                )}

                <DndContext
                    sensors={sensors}
                    collisionDetection={closestCenter}
                    onDragStart={handleDragStart}
                    onDragEnd={handleDragEnd}
                >
                    <div
                        className="flex items-center gap-2 flex-1 overflow-x-auto no-scrollbar min-w-0 h-full"
                        onDoubleClick={() => {
                            window.ipcRenderer?.send('window:maximize');
                        }}
                        data-tauri-drag-region
                    >
                        <SortableContext
                            items={tabs.map(t => t.id)}
                            strategy={horizontalListSortingStrategy}
                        >
                            {tabs.map((tab) => (
                                <SortableTab
                                    key={tab.id}
                                    tab={tab}
                                    isActive={activeTabId === tab.id}
                                    onActivate={activateTab}
                                    onClose={handleCloseTab}
                                    connections={connections}
                                />
                            ))}
                        </SortableContext>
                    </div>

                    <DragOverlay>
                        {activeDragId ? (
                            <div className="opacity-80">
                                {(() => {
                                    const tab = tabs.find(t => t.id === activeDragId);
                                    if (!tab) return null;
                                    return (
                                        <div className="flex items-center gap-2 px-2.5 py-1.5 h-8 text-sm rounded-md bg-app-surface text-app-text shadow-lg font-medium border border-app-border/50">
                                            {(() => {
                                                if (tab.type === 'port-forwarding') return <Network size={13} />;
                                                if (tab.type === 'settings') return <SettingsIcon size={13} />;
                                                const conn = connections.find((c: Connection) => c.id === tab.connectionId);
                                                return <OSIcon icon={conn?.icon || 'Server'} className="w-[13px] h-[13px]" />;
                                            })()}
                                            <span className="truncate max-w-[120px]">{tab.title}</span>
                                            <div className="p-0.5">
                                                <X size={12} />
                                            </div>
                                        </div>
                                    );
                                })()}
                            </div>
                        ) : null}
                    </DragOverlay>
                </DndContext>

                {/* Windows/Linux Controls on Right */}
                {!isMac && (
                    <div className="shrink-0 pl-1 self-stretch flex flex-col justify-center">
                        <WindowControls />
                    </div>
                )}

            </div>

            <ConfirmModal
                isOpen={!!tabToClose}
                onClose={() => setTabToClose(null)}
                onConfirm={confirmClose}
                title="Disconnect & Close?"
                message="This will disconnect the active SSH session."
                confirmLabel="Disconnect"
                variant="danger"
            />
        </>
    );
}
