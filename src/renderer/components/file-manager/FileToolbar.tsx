import { ChevronRight, Home, LayoutGrid, LayoutList, Plus, RefreshCw, Search, Upload } from 'lucide-react';
import { useState } from 'react';
import { cn } from '../../lib/utils';
import { Button } from '../ui/Button';
import { useAppStore } from '../../store/useAppStore'; // Updated Import

interface FileToolbarProps {
  currentPath: string;
  homePath: string;
  onNavigate: (path: string) => void;
  onRefresh: () => void;
  onUpload: () => void;
  onNewFolder: () => void;
  viewMode: 'grid' | 'list';
  onToggleView: (mode: 'grid' | 'list') => void;
  onSearch: (term: string) => void;
}

export function FileToolbar({
  currentPath,
  homePath,
  onNavigate,
  onRefresh,
  onUpload,
  onNewFolder,
  viewMode,
  onToggleView,
  onSearch,
}: FileToolbarProps) {
  const [searchTerm, setSearchTerm] = useState('');
  const settings = useAppStore(state => state.settings);
  const compactMode = settings.compactMode;

  const pathParts = currentPath.split('/').filter((p) => p);

  return (
    <div className={cn(
      "border-b border-app-border/40 bg-app-panel/50 backdrop-blur-md flex items-center justify-between px-4 shrink-0 gap-4 z-20 relative transition-all",
      compactMode ? "h-11 custom-drag-region pt-[2px]" : "h-16"
    )}>
      {/* Unified Command Bar (Address + Search) */}
      <div className={cn(
        "flex-1 flex items-center bg-app-surface/40 border border-app-border/50 rounded-xl px-2 min-w-0 mr-auto transition-all focus-within:bg-app-surface/60 focus-within:border-app-accent/30 focus-within:ring-2 focus-within:ring-app-accent/10 no-drag",
        compactMode ? "h-8" : "h-10"
      )}>
        {/* Home Button */}
        <button
          onClick={() => onNavigate(homePath || '/')}
          className={cn(
            'h-7 w-7 flex items-center justify-center rounded-lg transition-all shrink-0 mr-1',
            currentPath === homePath
              ? 'bg-app-accent text-white shadow-sm'
              : 'text-app-muted hover:bg-app-surface hover:text-app-text',
          )}
          title={homePath || 'Root'}
        >
          <Home size={14} />
        </button>

        <div className="h-4 w-px bg-app-border/50 mx-1 shrink-0" />

        {/* Breadcrumbs (Scrollable) */}
        <div className="flex items-center gap-0.5 overflow-x-auto overflow-y-hidden flex-1 min-w-0 mask-linear-fade no-scrollbar h-full mr-2">
          {pathParts.map((part, index) => {
            const fullPath = `/${pathParts.slice(0, index + 1).join('/')}`;
            const isLast = index === pathParts.length - 1;

            return (
              <div key={fullPath} className="flex items-center shrink-0">
                <ChevronRight size={12} className="text-app-muted/30 mx-0.5 shrink-0" />
                <button
                  onClick={() => onNavigate(fullPath)}
                  className={cn(
                    'px-2.5 py-1 rounded-md transition-all whitespace-nowrap text-xs font-medium max-w-[200px] truncate',
                    isLast
                      ? 'text-app-text bg-app-surface shadow-sm ring-1 ring-black/5'
                      : 'text-app-muted hover:bg-app-surface hover:text-app-text',
                  )}
                >
                  {part}
                </button>
              </div>
            );
          })}
        </div>

        {/* Merged Search Input */}
        <div className="relative group shrink-0 border-l border-app-border/30 pl-2 ml-1">
          <Search className="absolute left-4 top-1/2 -translate-y-1/2 h-4 w-4 text-app-muted group-focus-within:text-app-accent transition-colors pointer-events-none" />
          <input
            className="h-8 w-32 sm:w-48 bg-transparent border-0 rounded-lg pl-8 pr-2 text-sm transition-all focus:w-48 sm:focus:w-64 focus:bg-app-surface/50 focus:outline-none text-app-text placeholder:text-app-muted/50 font-medium"
            placeholder="Search..."
            value={searchTerm}
            onChange={(e) => {
              setSearchTerm(e.target.value);
              onSearch(e.target.value);
            }}
          />
        </div>
      </div>

      {/* Right Actions */}
      <div className="flex items-center gap-2 shrink-0 ml-2">
        <div className="flex items-center bg-app-surface/30 rounded-xl p-1 border border-app-border/30 ml-2">
          <button
            onClick={() => onToggleView('grid')}
            className={cn(
              'p-1.5 rounded-lg transition-all',
              viewMode === 'grid'
                ? 'bg-app-panel shadow-sm text-app-accent border border-app-border/20'
                : 'text-app-muted hover:text-app-text',
            )}
          >
            <LayoutGrid size={16} />
          </button>
          <button
            onClick={() => onToggleView('list')}
            className={cn(
              'p-1.5 rounded-lg transition-all',
              viewMode === 'list'
                ? 'bg-app-panel shadow-sm text-app-accent border border-app-border/20'
                : 'text-app-muted hover:text-app-text',
            )}
          >
            <LayoutList size={16} />
          </button>
        </div>

        <Button
          variant="ghost"
          size="icon"
          className={cn(
            "rounded-xl text-app-muted hover:text-app-text hover:bg-app-surface/50",
            compactMode ? "h-8 w-8" : "h-10 w-10"
          )}
          onClick={onRefresh}
        >
          <RefreshCw size={compactMode ? 14 : 18} />
        </Button>

        <div className="flex gap-2 ml-2">
          <Button
            variant="secondary"
            size="sm"
            className={cn(
              "rounded-xl font-medium hidden md:flex transition-all",
              compactMode ? "h-8 px-3 text-xs" : "h-10 px-4"
            )}
            onClick={onNewFolder}
          >
            <Plus size={compactMode ? 14 : 16} className="mr-2" />
            New Folder
          </Button>

          <Button
            variant="primary"
            size="sm"
            className={cn(
              "rounded-xl font-medium shadow-lg shadow-app-accent/20 transition-all",
              compactMode ? "h-8 px-3 text-xs" : "h-10 px-4"
            )}
            onClick={onUpload}
          >
            <Upload size={compactMode ? 14 : 16} className="mr-2" />
            Upload
          </Button>
        </div>
      </div>
    </div>
  );
}
