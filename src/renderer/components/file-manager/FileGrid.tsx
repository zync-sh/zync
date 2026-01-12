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
import { cn } from '../../lib/utils';
import { Skeleton } from '../ui/Skeleton';
import type { FileEntry } from './types';
import { useAppStore } from '../../store/useAppStore'; // Updated Import

// Global drag state (shared across all FileGrid instances)
let currentDragSource: { connectionId: string; path: string } | null = null;

// ... (inside props interface)
interface FileGridProps {
  files: FileEntry[];
  selectedFiles: string[];
  onSelect: (name: string, multi: boolean) => void;
  onNavigate: (name: string) => void;
  onContextMenu: (e: React.MouseEvent, file?: FileEntry) => void;
  viewMode: 'grid' | 'list';
  isLoading: boolean;
  connectionId?: string; // For drag & drop source identification
  currentPath?: string; // For building full file path
}

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
}: FileGridProps) {
  const settings = useAppStore(state => state.settings);
  const compactMode = settings.compactMode;

  if (isLoading) {
    return (
      <div className="p-4 grid grid-cols-4 lg:grid-cols-6 xl:grid-cols-8 gap-4 animate-in fade-in duration-500">
        {[...Array(16)].map((_, i) => (
          <div
            key={i}
            className="flex flex-col aspect-[4/3] p-3 gap-2 border border-app-border/30 rounded-2xl bg-app-surface/10"
            style={{ animationDelay: `${i * 50}ms` }}
          >
            <Skeleton className="w-full flex-1 rounded-xl bg-app-border/20" />
            <Skeleton className="h-3 w-2/3 mx-auto rounded bg-app-border/20" />
          </div>
        ))}
      </div>
    );
  }

  if (files.length === 0) {
    return (
      // biome-ignore lint/a11y/noStaticElementInteractions: <explanation>
      <div
        className="flex-1 flex flex-col items-center justify-center text-app-muted opacity-50 select-none pb-20"
        onContextMenu={(e) => onContextMenu(e)}
      >
        <Folder size={64} className="mb-4 stroke-1" />
        <p>Empty directory</p>
      </div>
    );
  }

  // sort folders first
  const sortedFiles = [...files].sort((a, b) => {
    if (a.type === 'd' && b.type !== 'd') return -1;
    if (a.type !== 'd' && b.type === 'd') return 1;
    return a.name.localeCompare(b.name);
  });

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: <explanation>
    <div
      className="flex-1 overflow-y-auto p-4"
      onClick={() => onSelect('', false)}
      onContextMenu={(e) => {
        // Prevent default browser menu
        e.preventDefault();
        // Only trigger if we are clicking the background (target === currentTarget or similar check might be needed if bubbling, but here we rely on children stopping propagation)
        onContextMenu(e);
      }}
    >
      <div
        key={currentPath} // Trigger animation on path change
        className={cn(
          'animate-in slide-in-from-bottom-2 fade-in duration-300 ease-out', // Page transition
          viewMode === 'grid'
            ? cn(
              "grid content-start",
              compactMode
                ? "grid-cols-5 sm:grid-cols-6 md:grid-cols-8 lg:grid-cols-10 xl:grid-cols-12 gap-2"
                : "grid-cols-4 lg:grid-cols-6 xl:grid-cols-8 gap-3"
            )
            : 'flex flex-col gap-1',
        )}
      >
        {sortedFiles.map((file) => {
          const isSelected = selectedFiles.includes(file.name);
          const isFolder = file.type === 'd';

          return (
            // biome-ignore lint/a11y/noStaticElementInteractions: <explanation>
            <div
              key={file.name}
              draggable={!isFolder && connectionId !== undefined}
              // ... drag handlers (keep existing logic) ...
              onDragStart={(e) => {
                if (isFolder || !connectionId || !currentPath) return;
                const fullPath = currentPath === '/' ? `/${file.name}` : `${currentPath}/${file.name}`;
                const dragData = {
                  type: 'server-file',
                  connectionId,
                  path: fullPath,
                  name: file.name,
                  size: file.size,
                };
                currentDragSource = { connectionId, path: fullPath };
                e.dataTransfer.setData('application/json', JSON.stringify(dragData));
                e.dataTransfer.effectAllowed = 'copy';
                if (e.currentTarget instanceof HTMLElement) e.currentTarget.style.opacity = '0.5';
              }}
              onDragEnd={(e) => {
                currentDragSource = null;
                if (e.currentTarget instanceof HTMLElement) e.currentTarget.style.opacity = '1';
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
                e.stopPropagation(); // Stop bubbling to background
                onContextMenu(e, file);
              }}
              className={cn(
                'group relative transition-all duration-200 cursor-pointer select-none overflow-hidden isolate',
                'active:scale-95 active:duration-75', // Click feedback
                viewMode === 'grid'
                  ? cn(
                    "flex flex-col items-center justify-between rounded-2xl border bg-app-surface/30 border-app-border/40 hover:bg-app-surface hover:shadow-lg hover:shadow-black/20 hover:-translate-y-1 hover:border-app-border",
                    compactMode ? "aspect-square p-2 text-[10px]" : "aspect-[4/3] p-4"
                  )
                  : cn(
                    "flex items-center rounded-xl border border-transparent hover:bg-app-surface/50",
                    compactMode ? "p-1.5" : "p-3"
                  ),
                isSelected &&
                (viewMode === 'grid'
                  ? 'bg-gradient-to-br from-app-accent/20 to-app-accent/5 !border-app-accent !shadow-xl !shadow-app-accent/10 ring-1 ring-app-accent/50'
                  : 'bg-app-accent/10 !border-app-accent/30'),
              )}
            >
              {/* Folder Glow Effect */}
              {isFolder && viewMode === 'grid' && (
                <div className="absolute inset-0 bg-yellow-500/5 opacity-0 group-hover:opacity-100 transition-opacity -z-10 blur-xl" />
              )}

              {/* Icon Area */}
              <div
                className={cn(
                  'flex items-center justify-center transition-transform duration-300',
                  viewMode === 'grid' ? 'flex-1 w-full group-hover:scale-110' : 'w-10 mr-4',
                  isFolder ? 'text-yellow-400 drop-shadow-sm' : 'text-app-muted group-hover:text-app-text',
                  isSelected && !isFolder && 'text-app-accent',
                )}
              >
                <FileIcon file={file} size={viewMode === 'grid' ? (compactMode ? 32 : 48) : (compactMode ? 16 : 22)} />
              </div>

              {/* Text Area */}
              <div
                className={cn(
                  'w-full text-center overflow-hidden z-10',
                  viewMode === 'list' && 'text-left flex-1 flex items-center justify-between',
                )}
              >
                <div
                  className={cn(
                    'truncate font-medium leading-tight transition-colors mb-1',
                    viewMode === 'grid' ? 'text-xs' : 'text-sm',
                    isSelected ? 'text-app-accent' : 'text-app-text/90 group-hover:text-[var(--color-app-text)]',
                  )}
                  title={file.name}
                >
                  {file.name}
                </div>

                {viewMode === 'grid' && (
                  <div className="text-[10px] text-app-muted/60 truncate opacity-0 group-hover:opacity-100 transition-opacity translate-y-2 group-hover:translate-y-0">
                    {formatSize(file.size)}
                  </div>
                )}

                {viewMode === 'list' && (
                  <div className="text-xs text-app-muted/60 w-24 text-right font-mono">{formatSize(file.size)}</div>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// Utility to format bytes
function formatSize(bytes: number) {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${parseFloat((bytes / k ** i).toFixed(1))} ${sizes[i]}`;
}

// Extended Icon Selector with Colors
function FileIcon({ file, size }: { file: FileEntry; size: number }) {
  if (file.type === 'd') {
    return <Folder size={size} fill="currentColor" className="text-yellow-400 opacity-90" />;
  }

  const ext = file.name.split('.').pop()?.toLowerCase() || '';

  // Code / Config
  if (
    ['js', 'ts', 'jsx', 'tsx', 'css', 'html', 'py', 'go', 'rb', 'php', 'java', 'c', 'cpp', 'rs', 'lua'].includes(ext)
  ) {
    return <FileCode size={size} className="text-blue-400" />;
  }
  if (['json', 'yml', 'yaml', 'xml', 'toml', 'ini', 'env'].includes(ext)) {
    return <FileJson size={size} className="text-purple-400" />;
  }
  if (['sh', 'bash', 'zsh', 'bat', 'cmd', 'ps1'].includes(ext)) {
    return <FileTerminal size={size} className="text-green-400" />;
  }

  // Media
  if (['png', 'jpg', 'jpeg', 'gif', 'svg', 'webp', 'ico', 'bmp', 'tiff'].includes(ext)) {
    return <FileImage size={size} className="text-pink-400" />;
  }
  if (['mp3', 'wav', 'ogg', 'm4a', 'flac'].includes(ext)) {
    return <FileAudio size={size} className="text-yellow-600" />;
  }
  if (['mp4', 'mkv', 'avi', 'mov', 'webm'].includes(ext)) {
    return <FileVideo size={size} className="text-red-400" />;
  }

  // Archives
  if (['zip', 'rar', '7z', 'tar', 'gz', 'bz2', 'xz'].includes(ext)) {
    return <FileArchive size={size} className="text-orange-400" />;
  }

  // Data / Docs
  if (['csv', 'xlsx', 'xls', 'ods'].includes(ext)) {
    return <FileSpreadsheet size={size} className="text-emerald-500" />;
  }
  if (['sql', 'db', 'sqlite', 'mdb'].includes(ext)) {
    return <Database size={size} className="text-indigo-400" />;
  }
  if (['pdf'].includes(ext)) {
    return <FileType size={size} className="text-red-500" />; // Or specific generic doc
  }
  if (['txt', 'md', 'log', 'rtf'].includes(ext)) {
    return <FileText size={size} className="text-slate-400" />;
  }
  if (['pem', 'key', 'crt', 'cer'].includes(ext)) {
    return <Lock size={size} className="text-amber-500" />;
  }

  // Default
  return <File size={size} className="text-app-muted/50" />;
}

// Export function to check current drag source
export function getCurrentDragSource() {
  return currentDragSource;
}
