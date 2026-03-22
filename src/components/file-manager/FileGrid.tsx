import {
  Database,
  File,
  FileArchive,
  FileAudio,
  FileCode,
  FileImage,
  FileJson,
  FileSpreadsheet,
  FileTerminal,
  FileText,
  FileType,
  FileVideo,
  Folder,
  Lock,
} from 'lucide-react';
import type React from 'react';
import { cn, formatBytes, formatDate } from '../../lib/utils';
import type { FileEntry } from './types';
import { useAppStore } from '../../store/useAppStore';
import { useState, useMemo, useEffect, memo } from 'react';
import { ArrowDown, ArrowUp, ArrowUpDown } from 'lucide-react';
import { convertFileSrc } from '@tauri-apps/api/core';
import { setCurrentDragSource } from '../../lib/dragDrop';
import { motion, AnimatePresence } from 'framer-motion';

// Extended Icon Selector with Colors
const FileIcon = memo(function FileIcon({ file, size }: { file: FileEntry; size: number }) {
  if (file.type === 'd') {
    // Theme-based: Solid Accent Folder
    return (
      <div className="relative flex items-center justify-center">
        <Folder
          size={size}
          fill="currentColor"
          className="text-app-accent drop-shadow-sm transition-colors"
          strokeWidth={0.5}
        />
      </div>
    );
  }

  const ext = file.name.split('.').pop()?.toLowerCase() || '';

  // Minimalist File Icons - Theme Muted Color
  const fileColor = "text-app-muted/80";
  const strokeWidth = 1.5;

  // Code / Config
  if (
    ['js', 'ts', 'jsx', 'tsx', 'css', 'html', 'py', 'go', 'rb', 'php', 'java', 'c', 'cpp', 'rs', 'lua'].includes(ext)
  ) {
    return <FileCode size={size} className={fileColor} strokeWidth={strokeWidth} />;
  }
  if (['json', 'yml', 'yaml', 'xml', 'toml', 'ini', 'env'].includes(ext)) {
    return <FileJson size={size} className={fileColor} strokeWidth={strokeWidth} />;
  }
  if (['sh', 'bash', 'zsh', 'bat', 'cmd', 'ps1'].includes(ext)) {
    return <FileTerminal size={size} className={fileColor} strokeWidth={strokeWidth} />;
  }

  // Media
  if (['png', 'jpg', 'jpeg', 'gif', 'svg', 'webp', 'ico', 'bmp', 'tiff'].includes(ext)) {
    return <FileImage size={size} className={fileColor} strokeWidth={strokeWidth} />;
  }
  if (['mp3', 'wav', 'ogg', 'm4a', 'flac'].includes(ext)) {
    return <FileAudio size={size} className={fileColor} strokeWidth={strokeWidth} />;
  }
  if (['mp4', 'mkv', 'avi', 'mov', 'webm'].includes(ext)) {
    return <FileVideo size={size} className={fileColor} strokeWidth={strokeWidth} />;
  }

  // Archives
  if (['zip', 'rar', '7z', 'tar', 'gz', 'bz2', 'xz'].includes(ext)) {
    return <FileArchive size={size} className={fileColor} strokeWidth={strokeWidth} />;
  }

  // Data / Docs
  if (['csv', 'xlsx', 'xls', 'ods'].includes(ext)) {
    return <FileSpreadsheet size={size} className={fileColor} strokeWidth={strokeWidth} />;
  }
  if (['sql', 'db', 'sqlite', 'mdb'].includes(ext)) {
    return <Database size={size} className={fileColor} strokeWidth={strokeWidth} />;
  }
  if (['pdf'].includes(ext)) {
    return <FileType size={size} className={fileColor} strokeWidth={strokeWidth} />;
  }
  if (['txt', 'md', 'log', 'rtf'].includes(ext)) {
    return <FileText size={size} className={fileColor} strokeWidth={strokeWidth} />;
  }
  if (['pem', 'key', 'crt', 'cer'].includes(ext)) {
    return <Lock size={size} className={fileColor} strokeWidth={strokeWidth} />;
  }

  // Default
  return <File size={size} className={fileColor} strokeWidth={strokeWidth} />;
});

// Memoized File Item Component
const FileGridItem = memo(({
  file,
  viewMode,
  compactMode,
  isSelected,
  selectedFiles,
  isFocused,
  connectionId,
  currentPath,
  onSelect,
  onNavigate,
  onContextMenu,
  onMove
}: {
  file: FileEntry;
  viewMode: 'grid' | 'list';
  compactMode: boolean;
  isSelected: boolean;
  selectedFiles: string[];
  isFocused: boolean;
  connectionId?: string;
  currentPath?: string;
  onSelect: (name: string, multi: boolean) => void;
  onNavigate: (name: string) => void;
  onContextMenu: (e: React.MouseEvent, file?: FileEntry) => void;
  onMove?: (moves: { source: string; target: string; sourceConnectionId?: string }[]) => void;
}) => {
  const isFolder = file.type === 'd';
  const [imageError, setImageError] = useState(false);

  const isImage = useMemo(() => {
    return false; // DISABLED: Performance issues reported by user
  }, [file.name, isFolder]);

  // Reset error state if file changes
  useEffect(() => {
    setImageError(false);
  }, [file.path]);

  return (
    <motion.div
      initial={{ opacity: 0, scale: 0.98 }}
      animate={{ opacity: 1, scale: 1 }}
      exit={{ opacity: 0, scale: 0.98 }}
      transition={{ duration: 0.2 }}
      id={`file-item-${file.name}`}
      draggable={connectionId !== undefined}
      onDragStart={(e: any) => {
        if (!connectionId || !currentPath) return;
        const fullPath = currentPath === '/' ? `/${file.name}` : `${currentPath}/${file.name}`;

        let draggedFiles: { name: string; path: string }[] = [];
        if (isSelected && selectedFiles.length > 0) {
          draggedFiles = selectedFiles.map(name => ({
            name,
            path: currentPath === '/' ? `/${name}` : `${currentPath}/${name}`
          }));
        } else {
          draggedFiles = [{ name: file.name, path: fullPath }];
        }

        const dragData = {
          type: 'server-file',
          connectionId,
          path: fullPath,
          paths: draggedFiles.map(f => f.path),
          names: draggedFiles.map(f => f.name),
          name: file.name,
          size: file.size,
        };

        setCurrentDragSource({ connectionId, path: fullPath });

        const dragPreview = document.createElement('div');
        dragPreview.style.cssText = `
          position: absolute; top: -1000px; padding: 8px; border-radius: 8px;
          background-color: var(--color-app-surface); border: 1px solid var(--color-app-border);
          display: flex; align-items: center; gap: 8px; z-index: 1000; width: fit-content;
        `;

        const iconClone = document.createElement('div');
        iconClone.innerHTML = draggedFiles.length > 1 ? '📚' : (isFolder ? '📁' : '📄');
        dragPreview.appendChild(iconClone);

        const nameNode = document.createElement('span');
        nameNode.textContent = draggedFiles.length > 1 ? `${draggedFiles.length} items` : file.name;
        nameNode.style.cssText = 'font-size: 12px; line-height: 1; font-weight: 500; color: var(--color-app-text); white-space: nowrap; max-width: 150px; overflow: hidden; text-overflow: ellipsis; display: block;';
        dragPreview.appendChild(nameNode);

        document.body.appendChild(dragPreview);
        e.dataTransfer.setDragImage(dragPreview, 20, 20);
        // Remove the preview element from DOM after the drag has started
        setTimeout(() => {
          if (dragPreview.parentNode) {
            dragPreview.parentNode.removeChild(dragPreview);
          }
        }, 0);

        e.dataTransfer.setData('application/json', JSON.stringify(dragData));
        e.dataTransfer.effectAllowed = 'copyMove';
        if (e.currentTarget instanceof HTMLElement) e.currentTarget.style.opacity = '0.5';
      }}
      onDragEnd={(e: any) => {
        setCurrentDragSource(null);
        if (e.currentTarget instanceof HTMLElement) e.currentTarget.style.opacity = '1';
      }}
      onDragOver={(e: any) => {
        if (!isFolder || !onMove) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = 'move';
        if (e.currentTarget instanceof HTMLElement) {
          e.currentTarget.style.outline = '2px dashed var(--color-app-accent)';
          e.currentTarget.style.outlineOffset = '-2px';
        }
      }}
      onDragLeave={(e: any) => {
        if (!isFolder || !onMove) return;
        if (e.currentTarget instanceof HTMLElement) {
          e.currentTarget.style.outline = 'none';
        }
      }}
      onDrop={(e: any) => {
        if (!isFolder || !onMove || !currentPath) return;
        e.preventDefault();
        e.stopPropagation();
        if (e.currentTarget instanceof HTMLElement) e.currentTarget.style.outline = 'none';

        try {
          const data = JSON.parse(e.dataTransfer.getData('application/json'));
          if (data && onMove) {
            if (data.paths && Array.isArray(data.paths) && data.paths.length > 0) {
              const targetFolder = currentPath === '/' ? `/${file.name}` : `${currentPath}/${file.name}`;
              const moves: { source: string; target: string; sourceConnectionId?: string }[] = [];
              data.paths.forEach((sourcePath: string) => {
                const sourceName = sourcePath.split(/[/\\]/).pop();
                if (!sourceName || sourcePath === targetFolder) return;
                moves.push({ 
                  source: sourcePath, 
                  target: `${targetFolder}/${sourceName}`,
                  sourceConnectionId: data.connectionId
                });
              });
              if (moves.length > 0) onMove(moves);
            } else if (data.path) {
              const sourceFileName = data.name || data.path.split(/[/\\]/).pop();
              const targetFolder = currentPath === '/' ? `/${file.name}` : `${currentPath}/${file.name}`;
              if (data.path !== `${currentPath}/${file.name}`) {
                onMove([{ 
                  source: data.path, 
                  target: `${targetFolder}/${sourceFileName}`,
                  sourceConnectionId: data.connectionId
                }]);
              }
            }
          }
        } catch (err) {
          console.error('Failed to parse drag data', err);
        }
      }}
      onClick={(e) => {
        e.stopPropagation();
        const isMulti = e.ctrlKey || e.metaKey || e.shiftKey;
        onSelect(file.name, isMulti);
      }}
      onDoubleClick={(e) => {
        e.stopPropagation();
        onNavigate(file.name);
      }}
      onContextMenu={(e) => {
        e.stopPropagation();
        if (!isSelected) onSelect(file.name, false);
        onContextMenu(e, file);
      }}
      className={cn(
        'group relative cursor-pointer select-none overflow-hidden transition-all duration-200',
        'active:scale-95 duration-75',
        viewMode === 'grid'
          ? cn(
            "flex flex-col items-center justify-start rounded-xl border border-transparent",
            "hover:bg-app-surface/50",
            // Nautilus/GNOME Style: Taller aspect ratio, cleaner padding
            compactMode ? "w-[100px] h-[120px] p-2 gap-1" : "w-[120px] h-[140px] p-3 gap-2"
          )
          : cn(
            "flex items-center rounded-lg border border-transparent hover:bg-app-surface/50",
            compactMode ? "p-1.5" : "p-2"
          ),
        isSelected && (
          'bg-app-accent/20 text-app-accent shadow-sm'
        ),
        isFocused && !isSelected && 'ring-1 ring-app-accent/40',
        isFocused && isSelected && 'ring-1 ring-app-accent/60',
        // GNOME-like hover only on non-selected
        !isSelected && viewMode === 'grid' && "hover:bg-app-surface/60"
      )}
    >
      <div className={cn(
        'flex items-center justify-center transition-transform duration-300',
        viewMode === 'grid' ? 'w-full h-[64px] mb-1' : 'w-10 mr-4', // Fixed height for icon area
        isFolder ? 'drop-shadow-sm' : 'text-app-muted/80 group-hover:text-app-text',
        isSelected && !isFolder && 'text-app-accent',
      )}>
        {isImage && !imageError && viewMode === 'grid' ? (
          <img
            src={convertFileSrc(file.path)}
            alt={file.name}
            className={cn(
              "object-contain max-h-full max-w-full rounded-md shadow-sm transition-opacity duration-300",
              isFocused ? "opacity-90" : "opacity-100"
            )}
            onError={() => setImageError(true)}
            loading="lazy"
          />
        ) : (
          <FileIcon file={file} size={viewMode === 'grid' ? (compactMode ? 48 : 64) : (compactMode ? 16 : 22)} />
        )}
      </div>

      <div className="w-full text-center px-1 z-10">
        <div
          className={cn(
            'truncate font-medium leading-tight transition-colors select-text',
            viewMode === 'grid' ? (compactMode ? 'text-[11px]' : 'text-xs') : 'text-sm',
            isSelected ? 'text-app-accent font-semibold' : 'text-app-text/90 group-hover:text-app-text',
          )}
          title={file.name}
        >
          {file.name}
        </div>

        {viewMode === 'grid' && !compactMode && (
          <div className="text-[10px] text-app-muted/50 truncate opacity-0 group-hover:opacity-100 transition-opacity duration-200">
            {formatBytes(file.size)}
          </div>
        )}
      </div>
    </motion.div>
  );
});

const FileListItem = memo(({
  file,
  isSelected,
  selectedFiles,
  isFocused,
  connectionId,
  currentPath,
  onSelect,
  onNavigate,
  onContextMenu,
  onMove
}: {
  file: FileEntry;
  isSelected: boolean;
  selectedFiles: string[];
  isFocused: boolean;
  connectionId?: string;
  currentPath?: string;
  onSelect: (name: string, multi: boolean) => void;
  onNavigate: (name: string) => void;
  onContextMenu: (e: React.MouseEvent, file?: FileEntry) => void;
  onMove?: (moves: { source: string; target: string; sourceConnectionId?: string }[]) => void;
}) => {
  const isFolder = file.type === 'd';

  return (
    <motion.tr
      initial={{ opacity: 0, x: -10 }}
      animate={{ opacity: 1, x: 0 }}
      exit={{ opacity: 0, x: 10 }}
      transition={{ duration: 0.2 }}
      id={`file-item-${file.name}`}
      draggable={connectionId !== undefined}
      onDragStart={(e: any) => {
        if (!connectionId || !currentPath) return;
        const fullPath = currentPath === '/' ? `/${file.name}` : `${currentPath}/${file.name}`;
        
        // Multi-file drag logic for list view
        let draggedFiles: { name: string; path: string }[] = [];
        if (isSelected && selectedFiles.length > 0) {
          draggedFiles = selectedFiles.map(name => ({
            name,
            path: currentPath === '/' ? `/${name}` : `${currentPath}/${name}`
          }));
        } else {
          draggedFiles = [{ name: file.name, path: fullPath }];
        }

        const dragData = {
          type: 'server-file',
          connectionId,
          path: fullPath,
          paths: draggedFiles.map(f => f.path),
          names: draggedFiles.map(f => f.name),
          name: file.name,
          size: file.size,
        };
        e.dataTransfer.setData('application/json', JSON.stringify(dragData));
        e.dataTransfer.effectAllowed = 'copyMove';

        setCurrentDragSource({ connectionId, path: fullPath });

        const dragPreview = document.createElement('div');
        dragPreview.innerHTML = isFolder ? `📁 ${file.name}` : `📄 ${file.name}`;
        dragPreview.style.cssText = 'position: absolute; top: -1000px; padding: 8px; background: var(--color-app-surface); border: 1px solid var(--color-app-border); border-radius: 8px; font-weight: 500; font-size: 14px;';
        document.body.appendChild(dragPreview);
        e.dataTransfer.setDragImage(dragPreview, 20, 20);
        // Remove the preview element from DOM after the drag has started
        setTimeout(() => {
          if (dragPreview.parentNode) {
            dragPreview.parentNode.removeChild(dragPreview);
          }
        }, 0);
        if (e.currentTarget instanceof HTMLElement) e.currentTarget.style.opacity = '0.5';
      }}
      onDragEnd={(e: any) => {
        setCurrentDragSource(null);
        if (e.currentTarget instanceof HTMLElement) e.currentTarget.style.opacity = '1';
      }}
      onDragOver={(e) => {
        if (!isFolder || !onMove) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = 'move';
        e.currentTarget.style.outline = '2px dashed var(--color-app-accent)';
      }}
      onDragLeave={(e) => {
        e.currentTarget.style.outline = 'none';
      }}
      onDrop={(e: any) => {
        if (!isFolder || !onMove || !currentPath) return;
        e.preventDefault();
        e.stopPropagation();
        if (e.currentTarget instanceof HTMLElement) e.currentTarget.style.outline = 'none';

        try {
          const data = JSON.parse(e.dataTransfer.getData('application/json'));
          if (data && onMove) {
            const targetFolder = currentPath === '/' ? `/${file.name}` : `${currentPath}/${file.name}`;
            
            // Handle multi-file paths (same logic as FileGridItem)
            if (data.paths && Array.isArray(data.paths) && data.paths.length > 0) {
              const moves: { source: string; target: string; sourceConnectionId?: string }[] = [];
              data.paths.forEach((sourcePath: string) => {
                const sourceName = sourcePath.split(/[/\\]/).pop();
                if (!sourceName || sourcePath === targetFolder) return;
                moves.push({ 
                  source: sourcePath, 
                  target: `${targetFolder}/${sourceName}`,
                  sourceConnectionId: data.connectionId
                });
              });
              if (moves.length > 0) onMove(moves);
            } else if (data.path && data.path !== `${currentPath}/${file.name}`) {
              const sourceName = data.name || data.path.split(/[/\\]/).pop();
              onMove([{ 
                source: data.path, 
                target: `${targetFolder}/${sourceName}`,
                sourceConnectionId: data.connectionId
              }]);
            }
          }
        } catch (err) {
          console.error('Failed to parse drag data', err);
        }
      }}
      onClick={(e) => {
        e.stopPropagation();
        const isMulti = e.ctrlKey || e.metaKey || e.shiftKey;
        onSelect(file.name, isMulti);
      }}
      onDoubleClick={(e) => {
        e.stopPropagation();
        onNavigate(file.name);
      }}
      onContextMenu={(e) => {
        e.stopPropagation();
        if (!isSelected) onSelect(file.name, false);
        onContextMenu(e, file);
      }}
      className={cn(
        'border-b border-app-border/20 cursor-pointer transition-colors outline-none',
        'hover:bg-app-surface/40',
        isSelected && 'bg-app-accent/10 hover:bg-app-accent/15',
        isFocused && !isSelected && 'ring-1 ring-inset ring-app-accent/50 bg-app-surface/60',
        isFocused && isSelected && 'ring-1 ring-inset ring-app-accent',
      )}
    >
      <td className="py-2 px-4">
        <div className="flex items-center gap-3">
          <FileIcon file={file} size={20} />
          <span className={cn('font-medium truncate', isSelected ? 'text-app-accent' : 'text-app-text')}>
            {file.name}
          </span>
        </div>
      </td>
      <td className="py-2 px-4 text-sm text-app-muted font-mono">
        {isFolder ? '—' : formatBytes(file.size)}
      </td>
      <td className="py-2 px-4 text-sm text-app-muted">
        {isFolder ? 'Folder' : (file.name.split('.').pop()?.toUpperCase() || '—')}
      </td>
      <td className="py-2 px-4 text-sm text-app-muted">
        {formatDate(file.lastModified)}
      </td>
    </motion.tr>
  );
});

FileGridItem.displayName = 'FileGridItem';

interface FileGridProps {
  files: FileEntry[];
  selectedFiles: string[];
  onSelect: (name: string, multi: boolean) => void;
  onNavigate: (name: string) => void;
  onContextMenu: (e: React.MouseEvent, file?: FileEntry) => void;
  viewMode: 'grid' | 'list';
  isLoading: boolean;
  connectionId?: string;
  currentPath?: string;
  focusedFile?: string | null;
  onMove?: (moves: { source: string; target: string; sourceConnectionId?: string }[]) => void;
}

type SortColumn = 'name' | 'size' | 'type' | 'modified';
type SortDirection = 'asc' | 'desc';

export function FileGrid({
  files,
  selectedFiles,
  onSelect,
  onNavigate,
  onContextMenu,
  viewMode,
  isLoading,
  connectionId,
  currentPath,
  focusedFile,
  onMove,
}: FileGridProps) {
  const settings = useAppStore(state => state.settings);
  const compactMode = settings.compactMode;
  const [sortColumn, setSortColumn] = useState<SortColumn>('name');
  const [sortDirection, setSortDirection] = useState<SortDirection>('asc');

  useEffect(() => {
    if (focusedFile) {
      const element = document.getElementById(`file-item-${focusedFile}`);
      if (element) {
        element.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
      }
    }
  }, [focusedFile]);

  const handleSort = (column: SortColumn) => {
    if (sortColumn === column) {
      setSortDirection(sortDirection === 'asc' ? 'desc' : 'asc');
    } else {
      setSortColumn(column);
      setSortDirection('asc');
    }
  };

  const sortedFiles = useMemo(() => {
    return [...files].sort((a, b) => {
      if (a.type === 'd' && b.type !== 'd') return -1;
      if (a.type !== 'd' && b.type === 'd') return 1;

      let comparison = 0;
      switch (sortColumn) {
        case 'name':
          comparison = a.name.localeCompare(b.name);
          break;
        case 'size':
          comparison = a.size - b.size;
          break;
        case 'type':
          const extA = a.name.split('.').pop()?.toLowerCase() || '';
          const extB = b.name.split('.').pop()?.toLowerCase() || '';
          comparison = extA.localeCompare(extB);
          break;
        case 'modified':
          comparison = a.lastModified - b.lastModified;
          break;
      }
      return sortDirection === 'asc' ? comparison : -comparison;
    });
  }, [files, sortColumn, sortDirection]);




  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: <explanation>
    <div
      className="flex-1 overflow-y-auto p-4 relative"
      onClick={() => onSelect('', false)}
      onContextMenu={(e) => {
        e.preventDefault();
        onContextMenu(e);
      }}
      onDrop={(e) => {
        // Always prevent default to stop WebView from navigating to dropped file URL
        e.preventDefault();
        
        const types = Array.from(e.dataTransfer.types || []);
        const isExternal = types.includes('Files') || types.includes('text/uri-list');
        if (isExternal) {
            e.stopPropagation();
            useAppStore.getState().showToast('info', 'External drop here is currently disabled. We are working to bring this feature to Zync soon!');
            return;
        }
        // Internal drag - let the event bubble up to parents (like FileManager) 
        // if they have registered handlers for background drops.
    }}
    >
      {/* Smooth Native Progress Bar */}
      <AnimatePresence>
        {isLoading && (
          <motion.div
            initial={{ opacity: 0, scaleX: 0 }}
            animate={{ opacity: 1, scaleX: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.3 }}
            className="absolute top-0 left-0 right-0 h-0.5 bg-app-accent origin-left z-50 overflow-hidden shadow-[0_0_8px_rgba(var(--color-app-accent-rgb),0.5)]"
          >
            <motion.div
               animate={{ x: ['-100%', '200%'] }}
               transition={{ duration: 1.5, repeat: Infinity, ease: "linear" }}
               className="h-full w-1/3 bg-white/30"
            />
          </motion.div>
        )}
      </AnimatePresence>

      <div className={cn(
        "flex-1 h-full transition-all duration-500",
        isLoading && "opacity-40 grayscale-[0.3] scale-[0.99] pointer-events-none cursor-wait"
      )}>
        {files.length === 0 ? (
          <motion.div
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            className="flex-1 flex flex-col items-center justify-center text-app-muted opacity-50 select-none pb-20 h-full"
            onContextMenu={(e) => onContextMenu(e)}
          >
            <Folder size={64} className="mb-4 stroke-1" />
            <p className="text-lg font-medium opacity-80">Empty directory</p>
            <p className="text-sm opacity-50">Drag files here to upload</p>
          </motion.div>
        ) : viewMode === 'list' ? (
        <table className="w-full border-collapse">
          <thead className="sticky top-0 bg-app-panel/95 backdrop-blur-sm z-10 border-b border-app-border/40">
            <tr className="text-left text-xs text-app-muted uppercase tracking-wider">
              <th className="py-3 px-4 cursor-pointer hover:bg-app-surface/30 transition-colors group" onClick={() => handleSort('name')}>
                <div className="flex items-center gap-2">
                  Name
                  {sortColumn === 'name' && (sortDirection === 'asc' ? <ArrowUp size={14} /> : <ArrowDown size={14} />)}
                  {sortColumn !== 'name' && <ArrowUpDown size={14} className="opacity-0 group-hover:opacity-40" />}
                </div>
              </th>
              <th className="py-3 px-4 cursor-pointer hover:bg-app-surface/30 transition-colors group w-24" onClick={() => handleSort('size')}>
                <div className="flex items-center gap-2">
                  Size
                  {sortColumn === 'size' && (sortDirection === 'asc' ? <ArrowUp size={14} /> : <ArrowDown size={14} />)}
                  {sortColumn !== 'size' && <ArrowUpDown size={14} className="opacity-0 group-hover:opacity-40" />}
                </div>
              </th>
              <th className="py-3 px-4 cursor-pointer hover:bg-app-surface/30 transition-colors group w-32" onClick={() => handleSort('type')}>
                <div className="flex items-center gap-2">
                  Type
                  {sortColumn === 'type' && (sortDirection === 'asc' ? <ArrowUp size={14} /> : <ArrowDown size={14} />)}
                  {sortColumn !== 'type' && <ArrowUpDown size={14} className="opacity-0 group-hover:opacity-40" />}
                </div>
              </th>
              <th className="py-3 px-4 cursor-pointer hover:bg-app-surface/30 transition-colors group w-40" onClick={() => handleSort('modified')}>
                <div className="flex items-center gap-2">
                  Modified
                  {sortColumn === 'modified' && (sortDirection === 'asc' ? <ArrowUp size={14} /> : <ArrowDown size={14} />)}
                  {sortColumn !== 'modified' && <ArrowUpDown size={14} className="opacity-0 group-hover:opacity-40" />}
                </div>
              </th>
            </tr>
          </thead>
          <tbody className="relative">
            <AnimatePresence mode="popLayout">
              {sortedFiles.map((file) => (
                <FileListItem
                  key={file.name}
                  file={file}
                  isSelected={selectedFiles.includes(file.name)}
                  selectedFiles={selectedFiles}
                  isFocused={focusedFile === file.name}
                  connectionId={connectionId}
                  currentPath={currentPath}
                  onSelect={onSelect}
                  onNavigate={onNavigate}
                  onContextMenu={onContextMenu}
                  onMove={onMove}
                />
              ))}
            </AnimatePresence>
          </tbody>
        </table>
      ) : (
        <div
          key={currentPath}
          className={cn(
            'animate-in slide-in-from-bottom-2 fade-in duration-300 ease-out',
            viewMode === 'grid'
              ? cn(
                "grid content-start w-full",
                compactMode
                  ? "grid-cols-[repeat(auto-fill,minmax(100px,1fr))] gap-2"
                  : "grid-cols-[repeat(auto-fill,minmax(120px,1fr))] gap-4"
              )
              : 'flex flex-col gap-1',
          )}
        >
          <AnimatePresence mode="popLayout">
            {sortedFiles.map((file) => (
              <FileGridItem
                key={file.name}
                file={file}
                viewMode={viewMode}
                compactMode={compactMode}
                isSelected={selectedFiles.includes(file.name)}
                selectedFiles={selectedFiles}
                isFocused={focusedFile === file.name}
                connectionId={connectionId}
                currentPath={currentPath}
                onSelect={onSelect}
                onNavigate={onNavigate}
                onContextMenu={onContextMenu}
                onMove={onMove}
              />
            ))}
          </AnimatePresence>
        </div>
      )}
      </div>
    </div>
  );
}

