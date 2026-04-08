import { X, Settings as SettingsIcon, PanelLeft, Network, Gift, Plus, Laptop, FolderPlus, Sparkles } from 'lucide-react';
import { OSIcon } from '../icons/OSIcon';
import { useAppStore, Tab, Connection } from '../../store/useAppStore'; // Updated Import
import { cn } from '../../lib/utils';
import { WindowControls } from './WindowControls';
import { useState, useEffect, useRef } from 'react';
import { Button } from '../ui/Button';
import { Tooltip } from '../ui/Tooltip';
import { ConfirmModal } from '../ui/ConfirmModal';
import { matchShortcut } from '../../lib/shortcuts';
import { useWindowDrag } from '../../hooks/useWindowDrag';
import { isEditorOverlayOpen } from '../editor/overlayState';
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
                "group flex items-center gap-1 px-2 py-1 h-7 text-[11px] rounded-md cursor-pointer select-none border border-transparent shrink-0 outline-none drag-none transition-all duration-200",
                isActive
                    ? "bg-app-surface text-app-text shadow-sm font-semibold"
                    : "text-app-muted hover:bg-app-surface/60 hover:text-app-text border-transparent"
            )}
            title={tab.title}
        >
            {/* Icon based on type */}
            {(() => {
                if (tab.type === 'port-forwarding') return <Network size={12} />;
                if (tab.type === 'settings') return <SettingsIcon size={12} />;
                if (tab.type === 'release-notes') return <Gift size={12} className="text-[var(--color-app-accent)]" />;

                const conn = connections.find((c: Connection) => c.id === tab.connectionId);
                return <OSIcon icon={conn?.icon || 'Server'} className="w-[12px] h-[12px]" />;
            })()}

            <span className="truncate max-w-[90px]">{tab.title}</span>

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
    const openSettings = useAppStore(state => state.openSettings);
    const setAddConnectionModalOpen = useAppStore(state => state.setAddConnectionModalOpen);
    const toggleAiSidebar = useAppStore(state => state.toggleAiSidebar);
    const isAiSidebarOpen = useAppStore(state => state.isAiSidebarOpen);


    const [tabToClose, setTabToClose] = useState<string | null>(null);

    // Add menu state
    const [isAddMenuOpen, setIsAddMenuOpen] = useState(false);
    const addMenuRef = useRef<HTMLDivElement>(null);

    // Click outside to close the Add menu
    useEffect(() => {
        if (!isAddMenuOpen) return;

        const handleClickOutside = (event: MouseEvent) => {
            if (addMenuRef.current && !addMenuRef.current.contains(event.target as Node)) {
                setIsAddMenuOpen(false);
            }
        };
        document.addEventListener('mousedown', handleClickOutside);
        return () => document.removeEventListener('mousedown', handleClickOutside);
    }, [isAddMenuOpen]);

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
            if (isEditorOverlayOpen()) {
                return;
            }

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
                "relative z-[60] flex h-10 bg-app-bg items-center pr-1 gap-1 app-drag-region shrink-0 select-none",
                isMac ? "pl-2" : "pl-1"
            )} data-tauri-drag-region>

                {/* macOS Controls on Left (Always at far edge) */}
                {isMac && (
                    <div className="shrink-0 flex items-center pr-2 pl-1">
                        <WindowControls />
                    </div>
                )}

                {/* Brand & Add (Now back on left) */}
                <div className="flex items-center gap-1.5 shrink-0 drag-none px-1">
                    {/* Zync Icon */}
                    <Tooltip content="Zync" position="bottom">
                        <div className="shrink-0 flex items-center opacity-80 hover:opacity-100 transition-opacity cursor-default px-2">
                            <svg width="20" height="20" viewBox="0 0 512 512" fill="none" xmlns="http://www.w3.org/2000/svg">
                                <rect width="512" height="512" rx="128" className="fill-app-accent/20" />
                                <path d="M128 170.667L213.333 256L128 341.333" className="stroke-app-accent" strokeWidth="64" strokeLinecap="round" strokeLinejoin="round" />
                                <path d="M256 341.333H384" className="stroke-app-accent" strokeWidth="64" strokeLinecap="round" strokeLinejoin="round" />
                            </svg>
                        </div>
                    </Tooltip>

                    {/* Add New Button */}
                    <div className="relative shrink-0" ref={addMenuRef}>
                        <Tooltip content="Add New..." position="bottom" disabled={isAddMenuOpen}>
                            <Button
                                variant="ghost"
                                size="icon"
                                onClick={() => setIsAddMenuOpen(!isAddMenuOpen)}
                                className={cn(
                                    "h-7 w-7 rounded-md transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-app-accent/60 focus-visible:ring-offset-0",
                                    isAddMenuOpen
                                        ? "bg-app-accent/20 text-app-text"
                                        : "text-app-muted hover:bg-app-surface hover:text-app-text"
                                )}
                            >
                                <Plus className="h-4 w-4" />
                            </Button>
                        </Tooltip>

                        {isAddMenuOpen && (
                            <div className="absolute top-full left-0 mt-2 w-48 bg-app-panel border border-app-border rounded-xl shadow-2xl z-50 overflow-hidden animate-in fade-in slide-in-from-top-2 duration-200 p-1">
                                <button
                                    onClick={() => { setAddConnectionModalOpen(true); setIsAddMenuOpen(false); }}
                                    className="w-full text-left px-3 py-2 text-xs font-medium text-app-text hover:bg-black/5 dark:hover:bg-white/10 rounded-lg flex items-center gap-2 transition-colors"
                                >
                                    <Laptop size={13} className="text-app-muted" />
                                    <span>New Host</span>
                                </button>
                                <button
                                    onClick={() => { window.dispatchEvent(new Event('ssh-ui:open-folder-modal')); setIsAddMenuOpen(false); }}
                                    className="w-full text-left px-3 py-2 text-xs font-medium text-app-text hover:bg-black/5 dark:hover:bg-white/10 rounded-lg flex items-center gap-2 transition-colors"
                                >
                                    <FolderPlus size={13} className="text-app-muted" />
                                    <span>New Folder</span>
                                </button>
                                
                                <div className="h-px bg-app-border/40 my-1 mx-2" />
                                
                                <button
                                    onClick={() => { window.dispatchEvent(new Event('ssh-ui:open-new-tunnel')); setIsAddMenuOpen(false); }}
                                    className="w-full text-left px-3 py-2 text-xs font-medium text-app-text hover:bg-black/5 dark:hover:bg-white/10 rounded-lg flex items-center gap-2 transition-colors"
                                >
                                    <Network size={13} className="text-app-muted" />
                                    <span>New Tunnel</span>
                                </button>
                            </div>
                        )}
                    </div>
                </div>

                <DndContext
                    sensors={sensors}
                    collisionDetection={closestCenter}
                    onDragStart={handleDragStart}
                    onDragEnd={handleDragEnd}
                >
                    <div
                        className="flex items-center gap-1 flex-1 overflow-x-auto no-scrollbar min-w-0 h-full"
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

                    <div className="flex items-center gap-1 shrink-0 drag-none px-1">
                        {/* Header Actions */}
                        <div className="flex items-center gap-1">
                            {/* Left Panel Toggle */}
                            <Tooltip content={settings.sidebarCollapsed ? "Show Sidebar" : "Hide Sidebar"} position="bottom">
                                <button
                                    onClick={() => {
                                        window.dispatchEvent(new CustomEvent('zync:layout-transition-start'));
                                        updateSettings({ sidebarCollapsed: !settings.sidebarCollapsed });
                                        setTimeout(() => {
                                            window.dispatchEvent(new CustomEvent('zync:layout-transition-end'));
                                        }, 320);
                                    }}
                                    className={cn(
                                        "h-7 w-7 shrink-0 rounded-md text-app-muted hover:text-app-text hover:bg-app-surface border border-transparent hover:border-app-border/40 transition-colors drag-none focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-app-accent/60 focus-visible:ring-offset-0 flex items-center justify-center",
                                        !settings.sidebarCollapsed && "text-app-accent bg-app-accent/10 border-app-accent/20"
                                    )}
                                    aria-label={settings.sidebarCollapsed ? "Show Sidebar" : "Hide Sidebar"}
                                >
                                    <PanelLeft size={16} />
                                </button>
                            </Tooltip>

                            {/* AI Panel Toggle */}
                            <Tooltip content={`AI Assistant (${isMac ? '⌘I' : 'Ctrl+I'})`} position="bottom">
                                <button
                                    onClick={toggleAiSidebar}
                                    className={cn(
                                        "h-7 w-7 shrink-0 rounded-md text-app-muted hover:text-app-text hover:bg-app-surface border border-transparent hover:border-app-border/40 transition-colors drag-none focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-app-accent/60 focus-visible:ring-offset-0 flex items-center justify-center",
                                        isAiSidebarOpen && "text-app-accent bg-app-accent/10 border-app-accent/20"
                                    )}
                                    aria-label="Toggle AI Sidebar"
                                >
                                    <Sparkles size={14} />
                                </button>
                            </Tooltip>

                            {/* Separator */}
                            <div className="h-4 w-[1px] bg-app-border/40 mx-0.5" />

                            {/* Settings */}
                            <Tooltip content="Settings" position="bottom">
                                <button
                                    onClick={openSettings}
                                    className="h-7 w-7 shrink-0 rounded-md text-app-muted hover:text-app-text hover:bg-app-surface border border-transparent hover:border-app-border/40 transition-colors drag-none focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-app-accent/60 focus-visible:ring-offset-0 flex items-center justify-center group"
                                >
                                    <SettingsIcon size={14} />
                                </button>
                            </Tooltip>
                        </div>
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
                                                if (tab.type === 'release-notes') return <Gift size={13} className="text-[var(--color-app-accent)]" />;
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
