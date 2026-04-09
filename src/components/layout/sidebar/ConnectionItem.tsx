import { useRef, useState, memo } from 'react';
import { useAppStore, Connection, Tab } from '../../../store/useAppStore';
import { getCurrentDragSource } from '../../../lib/dragDrop';
import { Settings } from 'lucide-react';
import { OSIcon } from '../../icons/OSIcon';
import { cn } from '../../../lib/utils';

interface ConnectionItemComponentProps {
    conn: Connection;
    isCollapsed: boolean;
    onEdit: (c: Connection) => void;
    onOpenContextMenu: (c: Connection, x: number, y: number) => void;
}

export const ConnectionItem = memo(function ConnectionItem({ conn, isCollapsed, onEdit, onOpenContextMenu }: ConnectionItemComponentProps) {
    // Selective subscriptions — only re-render when relevant values change
    const isActive = useAppStore(state => state.activeConnectionId === conn.id);
    const hasTab = useAppStore(state => state.tabs.some((t: Tab) => t.connectionId === conn.id));
    const compactMode = useAppStore(state => state.settings.compactMode);

    // Actions (stable references from zustand, don't cause re-renders)
    const openTab = useAppStore(state => state.openTab);
    const showToast = useAppStore(state => state.showToast);
    const addTransfer = useAppStore(state => state.addTransfer);
    const failTransfer = useAppStore(state => state.failTransfer);

    const [dropTargetId, setDropTargetId] = useState<string | null>(null);
    const rowRef = useRef<HTMLDivElement>(null);

    const handleDrop = async (e: React.DragEvent) => {
        e.preventDefault();
        setDropTargetId(null);
        try {
            const jsonData = e.dataTransfer.getData('application/json');
            if (jsonData) {
                const dragData = JSON.parse(jsonData);
                if (dragData.type === 'server-file' && dragData.connectionId !== conn.id) {
                    let destPath: string;
                    try {
                        const rawHomeDir = await window.ipcRenderer.invoke('sftp:cwd', { id: conn.id });
                        const homeDir = rawHomeDir === '/' ? '' : rawHomeDir.replace(/\/+$/, '');
                        const fileName = dragData.name;
                        destPath = `${homeDir}/${fileName}`;
                    } catch (err) {
                        showToast('error', 'Failed to get home directory');
                        return;
                    }

                    const transferId = addTransfer({
                        sourceConnectionId: dragData.connectionId,
                        sourcePath: dragData.path,
                        destinationConnectionId: conn.id,
                        destinationPath: destPath
                    });

                    showToast('info', `Copying to ${conn.name || conn.host}...`);

                    (async () => {
                        try {
                            await window.ipcRenderer.invoke('sftp:copyToServer', {
                                sourceConnectionId: dragData.connectionId,
                                sourcePath: dragData.path,
                                destinationConnectionId: conn.id,
                                destinationPath: destPath,
                                transferId
                            });
                        } catch (error: any) {
                            failTransfer(transferId, error?.message || String(error));
                            if (error.message && !error.message.includes('destroy')) {
                                showToast('error', `Transfer failed: ${error.message}`);
                            }
                        }
                    })();
                }
            }
        } catch (err) {
            console.error('Drop handling failed:', err);
            showToast('error', `Drag & drop failed: ${err instanceof Error ? err.message : String(err)}`);
        }
    };

    const handleDragOver = (e: React.DragEvent) => {
        const dragSource = getCurrentDragSource();
        if (dragSource && dragSource.connectionId !== conn.id && conn.status === 'connected') {
            e.preventDefault();
            setDropTargetId(conn.id);
        }
    };

    return (
        <>
            <div
                ref={rowRef}
                className={cn(
                    "group relative flex items-center transition-all cursor-pointer border select-none",
                    isCollapsed
                        ? "justify-center p-2 rounded-xl mx-auto w-12 h-12"
                        : compactMode
                            ? "gap-2 p-1.5 rounded-lg mx-1"
                            : "gap-3 p-3 rounded-xl mx-2",
                    "border-transparent hover:bg-app-surface/50",
                    isActive
                        ? "bg-app-accent/5"
                        : "text-app-muted hover:text-app-text",
                    dropTargetId === conn.id && "bg-app-accent/20 border-app-accent ring-2 ring-app-accent/30"
                )}
                onClick={(e) => {
                    e.preventDefault();
                }}
                role="button"
                tabIndex={0}
                aria-label={`Connection ${conn.name || conn.host}`}
                onContextMenu={(e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    onOpenContextMenu(conn, e.clientX, e.clientY);
                }}
                onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault();
                        openTab(conn.id);
                        return;
                    }

                    const isContextMenuKey =
                        (e.shiftKey && e.key === 'F10') ||
                        e.key === 'ContextMenu' ||
                        e.code === 'ContextMenu';

                    if (isContextMenuKey) {
                        e.preventDefault();
                        const rect = rowRef.current?.getBoundingClientRect();
                        const x = rect ? rect.left + rect.width / 2 : 0;
                        const y = rect ? rect.top + rect.height / 2 : 0;
                        onOpenContextMenu(conn, x, y);
                    }
                }}
                onDoubleClick={() => openTab(conn.id)}
                draggable
                onDragStart={(e) => {
                    e.dataTransfer.setData('connection-id', conn.id);
                    e.dataTransfer.effectAllowed = 'move';
                }}
                onDragOver={handleDragOver}
                onDragLeave={() => setDropTargetId(null)}
                onDrop={handleDrop}
            >
                {/* Active Marker Line (Left) */}
                {isActive && (
                    <div className="absolute left-0 top-1/2 -translate-y-1/2 h-6 w-1 bg-app-accent shadow-[0_0_12px_rgba(var(--color-app-accent),0.6)] rounded-r-full" />
                )}

                {/* Icon */}
                <div className={cn(
                    "relative shrink-0 flex items-center justify-center transition-all duration-300",
                    compactMode ? "h-7 w-7" : "h-9 w-9",
                    "bg-transparent"
                )}>
                    <OSIcon
                        icon={conn.icon || 'Server'}
                        className={cn(
                            "transition-transform duration-500",
                            compactMode ? "w-4 h-4" : "w-4.5 h-4.5",
                            isActive ? "text-app-accent" : "text-app-muted group-hover:text-app-text group-hover:scale-110"
                        )}
                    />

                    {/* Status Dot */}
                    {conn.status === 'connected' && (
                        <div className={cn(
                            "absolute -bottom-1 -right-1 h-3 w-3 rounded-full shadow-sm",
                            hasTab
                                ? "bg-app-success border-2 border-app-panel animate-pulse-slow"
                                : "bg-transparent border-2 border-app-accent/60"
                        )} title={hasTab ? "Connected" : "Tunnel/Background Active"} />
                    )}
                </div>

                {!isCollapsed && (
                    <div className="flex flex-col overflow-hidden min-w-0 flex-1">
                        <div className="flex items-center justify-between gap-2">
                            <span className={cn(
                                "truncate font-medium leading-tight transition-colors",
                                compactMode ? "text-sm" : "text-[14px]",
                                isActive ? "text-app-text font-semibold" : "text-app-text/80 group-hover:text-app-text"
                            )}>
                                {conn.name || conn.host}
                            </span>

                            {/* Hover Actions */}
                            <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                                <button
                                    className="p-1 rounded hover:bg-app-surface hover:text-app-text text-app-muted transition-colors"
                                    onClick={(e) => {
                                        e.stopPropagation();
                                        onEdit(conn);
                                    }}
                                    aria-label="Edit connection"
                                    title="Edit Connection"
                                >
                                    <Settings size={10} />
                                </button>
                            </div>
                        </div>
                        <span className={cn(
                            "truncate leading-tight",
                            compactMode ? "text-[10px] mt-0.5" : "text-xs mt-0.5",
                            "text-app-muted/50 font-mono group-hover:text-app-muted/70 transition-colors"
                        )}>
                            {conn.username}@{conn.host}
                        </span>
                    </div>
                )}
            </div>

        </>
    );
});
