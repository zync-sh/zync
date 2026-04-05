import {
  Folder,
} from 'lucide-react';
import { DynamicIcon } from '../ui/DynamicIcon';
import type React from 'react';
import { cn, formatBytes, formatDate } from '../../lib/utils';
import type { FileEntry } from './types';
import { useAppStore } from '../../store/useAppStore';
import { useState, useMemo, useEffect, memo } from 'react';
import { ArrowDown, ArrowUp, ArrowUpDown } from 'lucide-react';
import { convertFileSrc } from '@tauri-apps/api/core';

import { setCurrentDragSource } from '../../lib/dragDrop';
import { motion, AnimatePresence } from 'framer-motion';
import { forwardRef } from 'react';
import { buildDragData, startInternalDrag, validateAndBuildMoves } from './dragDropUtils';
import { Tooltip } from '../ui/Tooltip';

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

  // Use the new DynamicIcon engine for files
  return (
    <DynamicIcon 
        type={file.name} 
        size={size} 
        className="drop-shadow-sm group-hover:scale-110 transition-transform duration-300" 
    />
  );
});

// Memoized File Item Component
const FileGridItem = memo(forwardRef<HTMLDivElement, {
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
}>(({
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
}, ref) => {
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
      ref={ref}
      initial={{ opacity: 0, scale: 0.98 }}
      animate={{ opacity: 1, scale: 1 }}
      exit={{ opacity: 0, scale: 0.98 }}
      transition={{ duration: 0.2 }}
      id={`file-item-${file.name}`}
      draggable={connectionId !== undefined}
      onDragStart={(e: any) => {
        if (!connectionId || !currentPath) return;
        const dragData = buildDragData(file, isSelected, selectedFiles, connectionId, currentPath);
        const count = isSelected && selectedFiles.length > 0 ? selectedFiles.length : 1;
        startInternalDrag(e, dragData, isFolder, count);
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

        // Only handle internal drops, let external drops bubble up
        if (!e.dataTransfer.types.includes('application/json')) return;
        
        e.preventDefault();
        e.stopPropagation();
        if (e.currentTarget instanceof HTMLElement) e.currentTarget.style.outline = 'none';

        try {
          const data = JSON.parse(e.dataTransfer.getData('application/json'));
          if (data && onMove) {
            const targetFolder = currentPath === '/' ? `/${file.name}` : `${currentPath}/${file.name}`;
            const moves = validateAndBuildMoves(data, targetFolder);
            if (moves.length > 0) onMove(moves);
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
        !isSelected && viewMode === 'grid' && "hover:bg-app-surface/60"
      )}
    >
      <div className={cn(
        'flex items-center justify-center transition-transform duration-300',
        viewMode === 'grid' ? 'w-full h-[64px] mb-1' : 'w-10 mr-4',
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
        <Tooltip content={file.name} position="bottom" className="w-full">
          <div
            className={cn(
              'truncate font-medium leading-tight transition-colors select-text',
              viewMode === 'grid' ? (compactMode ? 'text-[11px]' : 'text-xs') : 'text-sm',
              isSelected ? 'text-app-accent font-semibold' : 'text-app-text/90 group-hover:text-app-text',
            )}
          >
            {file.name}
          </div>
        </Tooltip>

        {viewMode === 'grid' && !compactMode && (
          <div className="text-[10px] text-app-muted/50 truncate opacity-0 group-hover:opacity-100 transition-opacity duration-200">
            {formatBytes(file.size)}
          </div>
        )}
      </div>
    </motion.div>
  );
}));

// Memoized File List Item Component
const FileListItem = memo(forwardRef<HTMLTableRowElement, {
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
}>(({
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
}, ref) => {
  const isFolder = file.type === 'd';

  return (
    <motion.tr
      ref={ref}
      initial={{ opacity: 0, x: -10 }}
      animate={{ opacity: 1, x: 0 }}
      exit={{ opacity: 0, x: 10 }}
      transition={{ duration: 0.2 }}
      id={`file-item-${file.name}`}
      draggable={connectionId !== undefined}
      onDragStart={(e: any) => {
        if (!connectionId || !currentPath) return;
        const dragData = buildDragData(file, isSelected, selectedFiles, connectionId, currentPath);
        const count = isSelected && selectedFiles.length > 0 ? selectedFiles.length : 1;
        startInternalDrag(e, dragData, isFolder, count);
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
        }
      }}
      onDragLeave={(e: any) => {
        if (e.currentTarget instanceof HTMLElement) {
          e.currentTarget.style.outline = 'none';
        }
      }}
      onDrop={(e: any) => {
        if (!isFolder || !onMove || !currentPath) return;

        // Only handle internal drops, let external drops bubble up
        if (!e.dataTransfer.types.includes('application/json')) return;

        e.preventDefault();
        e.stopPropagation();
        if (e.currentTarget instanceof HTMLElement) e.currentTarget.style.outline = 'none';

        try {
          const data = JSON.parse(e.dataTransfer.getData('application/json'));
          if (data && onMove) {
            const targetFolder = currentPath === '/' ? `/${file.name}` : `${currentPath}/${file.name}`;
            const moves = validateAndBuildMoves(data, targetFolder);
            if (moves.length > 0) onMove(moves);
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
          <Tooltip content={file.name} position="right">
            <span className={cn('font-medium truncate', isSelected ? 'text-app-accent' : 'text-app-text')}>
              {file.name}
            </span>
          </Tooltip>
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
}));

FileGridItem.displayName = 'FileGridItem';
FileListItem.displayName = 'FileListItem';

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
      onDragOver={(e) => {
        const types = Array.from(e.dataTransfer.types || []);
        const isInternal = types.includes('application/json');
        const isExternal = types.includes('Files') || types.includes('text/uri-list');

        if (isInternal || isExternal) {
          e.preventDefault();
          e.dataTransfer.dropEffect = 'copy';
          e.currentTarget.style.backgroundColor = 'var(--color-app-accent-transparent, rgba(var(--color-app-accent-rgb), 0.05))';
        }
      }}
      onDragLeave={(e) => {
        e.currentTarget.style.backgroundColor = '';
      }}
      onDrop={(e) => {
        e.currentTarget.style.backgroundColor = '';
        // Always prevent default to stop WebView from navigating to dropped file URL
        e.preventDefault();
        
        const types = Array.from(e.dataTransfer.types || []);
        const isExternal = types.includes('Files') || types.includes('text/uri-list');
        if (isExternal) {
            e.stopPropagation();
            useAppStore.getState().showToast('info', 'External drop here is currently disabled. We are working to bring this feature to Zync soon!');
            return;
        }
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
            {(() => {
              // Only show upload prompt if user is actually dragging external files
              // OR if nothing is being dragged (default state)
              return <p className="text-sm opacity-50">Drag files here to upload</p>;
            })()}
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

