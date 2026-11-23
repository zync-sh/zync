import { Settings, Unplug } from 'lucide-react';
import { memo, useRef, useState } from 'react';

import { resolveHostIcon } from '../../../features/connections/domain/hostAppearance';
import type { HostLocationTag } from '../../../features/connections/domain/hostCatalog';
import { useConnectionDisplayLabels } from '../../../features/connections/presentation/useConnectionDisplayLabels';
import { getCurrentDragSource } from '../../../lib/dragDrop';
import { cn } from '../../../lib/utils';
import { Connection, Tab, useAppStore } from '../../../store/useAppStore';
import { OSIcon } from '../../icons/OSIcon';
import { CONTROL_INSET_FOCUS_CLASSES } from '../../ui/controlStyles';
import { IconButton } from '../../ui/IconButton';
import { Tooltip } from '../../ui/Tooltip';
import { HostLocationChips } from './HostLocationChips';

interface ConnectionItemComponentProps {
    conn: Connection;
    isCollapsed: boolean;
    onEdit: (c: Connection) => void;
    onOpenContextMenu: (c: Connection, x: number, y: number) => void;
    /** Multi-location chips (local / google / …). Optional for callers that do not load catalog yet. */
    locations?: HostLocationTag[];
}

export const ConnectionItem = memo(function ConnectionItem({
    conn,
    isCollapsed,
    onEdit,
    onOpenContextMenu,
    locations,
}: ConnectionItemComponentProps) {
    // Selective subscriptions — only re-render when relevant values change
    const isActive = useAppStore((state) => state.activeConnectionId === conn.id);
    const hasTab = useAppStore((state) => state.tabs.some((t: Tab) => t.connectionId === conn.id));
    const compactMode = useAppStore((state) => state.settings.compactMode);
    const { primary, secondary, ariaLabel } = useConnectionDisplayLabels(conn);

    // Actions (stable references from zustand, don't cause re-renders)
    const openTab = useAppStore((state) => state.openTab);
    const disconnect = useAppStore((state) => state.disconnect);
    const showToast = useAppStore((state) => state.showToast);
    const addTransfer = useAppStore((state) => state.addTransfer);
    const failTransfer = useAppStore((state) => state.failTransfer);

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
                        const rawHomeDir = await window.ipcRenderer.invoke('sftp:cwd', {
                            id: conn.id,
                        });
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
                        destinationPath: destPath,
                    });

                    showToast('info', `Copying to ${conn.name || conn.host}...`);

                    (async () => {
                        try {
                            await window.ipcRenderer.invoke('sftp:copyToServer', {
                                sourceConnectionId: dragData.connectionId,
                                sourcePath: dragData.path,
                                destinationConnectionId: conn.id,
                                destinationPath: destPath,
                                transferId,
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
            showToast(
                'error',
                `Drag & drop failed: ${err instanceof Error ? err.message : String(err)}`,
            );
        }
    };

    const handleDragOver = (e: React.DragEvent) => {
        const draggingConnection = e.dataTransfer.types.includes('connection-id');
        const draggingFolder = e.dataTransfer.types.includes('folder-path');
        if (draggingConnection || draggingFolder) {
            e.preventDefault();
            return;
        }

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
                    'group relative flex cursor-pointer items-center select-none rounded-lg transition-colors',
                    CONTROL_INSET_FOCUS_CLASSES,
                    isCollapsed
                        ? 'mx-auto h-10 w-10 justify-center p-2'
                        : compactMode
                          ? 'gap-2 px-2 py-1.5'
                          : 'gap-2.5 px-2.5 py-2',
                    'hover:bg-app-surface/40',
                    isActive
                        ? 'bg-app-surface/65 text-app-text'
                        : 'text-app-muted hover:text-app-text',
                    dropTargetId === conn.id && 'bg-app-accent/15 ring-1 ring-app-accent/25',
                )}
                onClick={(e) => {
                    e.preventDefault();
                    openTab(conn.id);
                }}
                role="button"
                tabIndex={0}
                aria-label={ariaLabel}
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
                draggable
                onDragStart={(e) => {
                    e.dataTransfer.setData('connection-id', conn.id);
                    e.dataTransfer.effectAllowed = 'move';
                }}
                onDragOver={handleDragOver}
                onDragLeave={() => setDropTargetId(null)}
                onDrop={handleDrop}
            >
                {isActive && (
                    <div
                        className="absolute left-0 top-1/2 h-4 w-0.5 -translate-y-1/2 rounded-full bg-app-accent/80"
                        aria-hidden
                    />
                )}

                <div
                    className={cn(
                        'relative flex shrink-0 items-center justify-center',
                        compactMode ? 'h-7 w-7' : 'h-8 w-8',
                    )}
                >
                    <OSIcon
                        icon={resolveHostIcon(conn)}
                        className={cn(
                            'h-4 w-4 transition-colors',
                            isActive ? 'text-app-text' : 'text-app-muted group-hover:text-app-text',
                        )}
                    />

                    {(conn.status === 'connected' ||
                        conn.status === 'connecting' ||
                        conn.status === 'error') && (
                        <Tooltip
                            content={
                                conn.status === 'connected'
                                    ? hasTab
                                        ? 'Connected'
                                        : 'Connected (background)'
                                    : conn.status === 'connecting'
                                      ? 'Connecting…'
                                      : 'Connection error'
                            }
                        >
                            <div
                                className={cn(
                                    'absolute -bottom-0.5 -right-0.5 h-2 w-2 rounded-full ring-2 ring-app-panel',
                                    conn.status === 'connected' &&
                                        (hasTab ? 'bg-app-success' : 'bg-app-success/70'),
                                    conn.status === 'connecting' && 'bg-amber-400',
                                    conn.status === 'error' && 'bg-app-danger',
                                )}
                            />
                        </Tooltip>
                    )}
                </div>

                {!isCollapsed && (
                    <div className="flex min-w-0 flex-1 flex-col gap-0.5 overflow-hidden">
                        <div className="flex min-w-0 items-center justify-between gap-2">
                            <span
                                data-zync-color-label
                                className={cn(
                                    'min-w-0 truncate text-[13px] font-medium leading-tight',
                                    isActive
                                        ? 'text-app-text'
                                        : 'text-app-text/90 group-hover:text-app-text',
                                )}
                            >
                                {primary}
                            </span>

                            <div className="flex shrink-0 items-center gap-0.5 opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100">
                                {conn.status === 'connected' && (
                                    <Tooltip content="Disconnect">
                                        <IconButton
                                            label="Disconnect"
                                            icon={<Unplug size={12} />}
                                            className={cn(
                                                'h-5 w-5 rounded-md p-1 text-app-muted hover:bg-app-surface hover:text-red-400',
                                                CONTROL_INSET_FOCUS_CLASSES,
                                            )}
                                            onKeyDown={(e) => e.stopPropagation()}
                                            onClick={(e) => {
                                                e.stopPropagation();
                                                void disconnect(conn.id);
                                            }}
                                        />
                                    </Tooltip>
                                )}
                                <Tooltip content="Edit connection">
                                    <IconButton
                                        label="Edit connection"
                                        icon={<Settings size={12} />}
                                        className={cn(
                                            'h-5 w-5 rounded-md p-1 text-app-muted hover:bg-app-surface hover:text-app-text',
                                            CONTROL_INSET_FOCUS_CLASSES,
                                        )}
                                        onKeyDown={(e) => e.stopPropagation()}
                                        onClick={(e) => {
                                            e.stopPropagation();
                                            onEdit(conn);
                                        }}
                                    />
                                </Tooltip>
                            </div>
                        </div>
                        <div className="flex min-w-0 items-center gap-1.5">
                            <span className="min-w-0 truncate text-[11px] leading-tight text-app-muted/50 group-hover:text-app-muted/65">
                                {secondary}
                            </span>
                            {locations && locations.length > 0 && (
                                <HostLocationChips
                                    locations={locations}
                                    compact
                                    hideLocalOnly
                                    className="ml-auto"
                                />
                            )}
                        </div>
                    </div>
                )}
            </div>
        </>
    );
});
