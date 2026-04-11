import { useState, memo } from 'react';
import { useAppStore, Connection } from '../../../store/useAppStore';
import { Pencil, ChevronRight, Folder as FolderIcon, Trash2, FolderOpen } from 'lucide-react';
import { cn } from '../../../lib/utils';
import { Button } from '../../ui/Button';
import { ConnectionItem } from './ConnectionItem';
import type { TreeNode, ConnectionItemProps } from './types';

interface FolderItemProps {
    node: TreeNode;
    isCollapsed: boolean;
    compactMode: boolean;
    expandedFolders: Set<string>;
    toggleFolder: (p: string) => void;
    updateConnectionFolder: (id: string, f: string) => void;
    onDeleteFolder: (f: string) => void;
    onRenameFolder: (f: string) => void;
    onMoveFolder: (oldName: string, newName: string) => void;
    onOpenContextMenu: (folderPath: string, x: number, y: number) => void;
    connectionItemProps: ConnectionItemProps;
}

export const FolderItem = memo(function FolderItem({
    node,
    isCollapsed,
    compactMode,
    expandedFolders,
    toggleFolder,
    updateConnectionFolder,
    onDeleteFolder,
    onRenameFolder,
    onMoveFolder,
    onOpenContextMenu,
    connectionItemProps
}: FolderItemProps) {
    const isExpanded = expandedFolders.has(node.path);
    const [isDragOver, setIsDragOver] = useState(false);
    const normalizePath = (path: string) => path.replace(/\/+$/, '');

    const handleDrop = (e: React.DragEvent) => {
        e.preventDefault();
        e.stopPropagation();
        setIsDragOver(false);

        const connId = e.dataTransfer.getData('connection-id');
        const srcFolderPath = e.dataTransfer.getData('folder-path');

        const types = Array.from(e.dataTransfer.types);
        if (!connId && !srcFolderPath && (types.includes('Files') || types.includes('text/uri-list'))) {
            useAppStore.getState().showToast('info', 'External file drop into sidebar is currently disabled. We are working to bring this feature soon!');
            return;
        }

        if (connId) {
            updateConnectionFolder(connId, node.path);
        } else if (srcFolderPath) {
            const normalizedSource = normalizePath(srcFolderPath);
            const normalizedTargetFolder = normalizePath(node.path);

            if (normalizedSource === normalizedTargetFolder) return;
            if (normalizedTargetFolder.startsWith(`${normalizedSource}/`)) return;

            const sourceBaseName = normalizedSource.split('/').pop();
            if (!sourceBaseName) return;

            const newName = normalizePath(`${normalizedTargetFolder}/${sourceBaseName}`);
            if (newName === normalizedSource) return;

            onMoveFolder(normalizedSource, newName);
        }
    };

    return (
        <div className={cn("select-none transition-all duration-200", isExpanded && isCollapsed && "bg-app-surface/30 rounded-2xl pb-1 mb-2 border border-app-border/20")}>
            <div
                className={cn(
                    "flex items-center group cursor-pointer transition-colors mb-1 rounded-lg relative select-none",
                    isCollapsed
                        ? "justify-center mx-auto w-10 h-10 hover:bg-app-surface/50 my-1"
                        : cn(compactMode ? "px-2 py-1 text-xs gap-2" : "px-4 py-1.5 text-sm gap-2", "text-app-muted hover:text-app-text hover:bg-app-surface/30"),
                    isDragOver && "bg-app-accent/10"
                )}
                onClick={() => toggleFolder(node.path)}
                role="button"
                tabIndex={0}
                aria-expanded={isExpanded}
                aria-label={`Folder ${node.name}`}
                onKeyDown={(e) => {
                    if (e.key === 'ContextMenu' || (e.shiftKey && e.key === 'F10')) {
                        e.preventDefault();
                        e.stopPropagation();
                        const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
                        onOpenContextMenu(node.path, rect.left + 10, rect.top + 10);
                        return;
                    }
                    if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault();
                        toggleFolder(node.path);
                    }
                }}
                draggable
                onDragStart={(e) => {
                    e.dataTransfer.setData('folder-path', node.path);
                    e.dataTransfer.effectAllowed = 'move';
                }}
                onDragOver={(e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    setIsDragOver(true);
                }}
                onDragLeave={() => setIsDragOver(false)}
                onDrop={handleDrop}
                onContextMenu={(event) => {
                    event.preventDefault();
                    event.stopPropagation();
                    onOpenContextMenu(node.path, event.clientX, event.clientY);
                }}
            >
                {isCollapsed ? (
                    <div className={cn(
                        "flex items-center justify-center w-8 h-8 rounded-lg border text-app-muted font-bold shadow-sm transition-all",
                        isExpanded
                            ? "bg-app-accent/20 border-app-accent/50 text-app-accent shadow-md"
                            : "bg-app-surface/50 border-app-border/30 group-hover:border-app-accent/30 group-hover:text-app-text"
                    )} title={node.name}>
                        {node.name.charAt(0).toUpperCase()}
                    </div>
                ) : (
                    <>
                        <div className={cn("transition-transform duration-200", isExpanded ? "rotate-90" : "")}>
                            <ChevronRight size={compactMode ? 12 : 14} />
                        </div>
                        {isExpanded ? <FolderOpen size={compactMode ? 14 : 16} className="text-app-accent/80" /> : <FolderIcon size={compactMode ? 14 : 16} />}
                        <span className="font-semibold truncate flex-1 flex items-center gap-2">
                            {node.name}
                        </span>
                        <span className="ml-auto text-[10px] opacity-0 group-hover:opacity-60 mr-2">{node.connections.length}</span>

                        <div className="flex opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 transition-opacity">
                            <Button
                                variant="ghost"
                                size="icon"
                                aria-label="Rename folder"
                                className="h-5 w-5 hover:text-app-text"
                                onClick={(e) => {
                                    e.stopPropagation();
                                    onRenameFolder(node.path);
                                }}
                            >
                                <Pencil className="h-3 w-3" />
                            </Button>
                            <Button
                                variant="ghost"
                                size="icon"
                                aria-label="Delete folder"
                                className="h-5 w-5 hover:text-red-400"
                                onClick={(e) => {
                                    e.stopPropagation();
                                    onDeleteFolder(node.path);
                                }}
                            >
                                <Trash2 className="h-3 w-3" />
                            </Button>
                        </div>
                    </>
                )}
            </div>

            {isExpanded && (
                <div className={cn(
                    "space-y-1",
                    !isCollapsed && "border-l border-app-border/30 ml-4 pl-1",
                    compactMode ? "mb-1" : "mb-2",
                    isCollapsed && "flex flex-col items-center gap-1"
                )}>
                    {Object.keys(node.children).sort().map(key => (
                        <FolderItem
                            key={key}
                            node={node.children[key]}
                            isCollapsed={isCollapsed}
                            compactMode={compactMode}
                            expandedFolders={expandedFolders}
                            toggleFolder={toggleFolder}
                            updateConnectionFolder={updateConnectionFolder}
                            onRenameFolder={onRenameFolder}
                            onMoveFolder={onMoveFolder}
                            onOpenContextMenu={onOpenContextMenu}
                            connectionItemProps={connectionItemProps}
                            onDeleteFolder={onDeleteFolder}
                        />
                    ))}
                    {node.connections.map((conn: Connection) => (
                        <ConnectionItem
                            key={conn.id}
                            conn={conn}
                            isCollapsed={isCollapsed}
                            onEdit={connectionItemProps.onEdit}
                            onOpenContextMenu={connectionItemProps.onOpenContextMenu}
                        />
                    ))}
                </div>
            )}
        </div>
    );
});
