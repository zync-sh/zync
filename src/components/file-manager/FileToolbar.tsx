import { ChevronRight, Home, LayoutGrid, LayoutList, Plus, RefreshCw, Search, Upload, FolderInput, Hash, X, PanelLeft, FileArchive } from 'lucide-react';
import { useState, useEffect, useRef } from 'react';
import { cn } from '../../lib/utils';
import { Button } from '../ui/Button';
import { useAppStore } from '../../store/useAppStore'; // Updated Import

interface FileToolbarProps {
  currentPath: string;
  onNavigate: (path: string) => void;
  onRefresh: () => void;
  onUpload: () => void;
  onUploadFolder: () => void;
  onNewFolder: () => void;
  onDownloadAsZip?: () => void;
  selectedCount?: number;
  viewMode: 'grid' | 'list';
  onToggleView: (mode: 'grid' | 'list') => void;
  searchTerm: string;
  onSearch: (term: string) => void;
  isSearchOpen: boolean;
  onToggleSearch: (open: boolean) => void;
  isEditingPath: boolean;
  onTogglePathEdit: (editing: boolean) => void;
  isSmallScreen?: boolean;
  onToggleSidebar?: () => void;
}

export function FileToolbar({
  currentPath,
  onNavigate,
  onRefresh,
  onUpload,
  onUploadFolder,
  onNewFolder,
  onDownloadAsZip,
  selectedCount = 0,
  viewMode,
  onToggleView,
  searchTerm,
  onSearch,
  isSearchOpen,
  onToggleSearch,
  isEditingPath,
  onTogglePathEdit,
  isSmallScreen = false,
  onToggleSidebar,
}: FileToolbarProps) {
  const [pathInput, setPathInput] = useState(currentPath);
  const settings = useAppStore(state => state.settings);
  const compactMode = settings.compactMode;
  const checkPathExists = useAppStore(state => state.checkPathExists);
  const activeConnectionId = useAppStore(state => state.activeConnectionId);
  const [isInvalid, setIsInvalid] = useState(false);
  const [isMenuOpen, setIsMenuOpen] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (isSearchOpen && searchInputRef.current) {
      searchInputRef.current.focus();
    }
  }, [isSearchOpen]);

  useEffect(() => {
    if (isEditingPath) {
      setPathInput(currentPath);
    }
  }, [isEditingPath, currentPath]);

  // Clear search when path changes
  useEffect(() => {
    if (searchTerm) {
      onSearch('');
      onToggleSearch(false);
    }
  }, [currentPath, onSearch, onToggleSearch]);

  const handlePathSubmit = async () => {
    if (!pathInput.trim()) return;

    if (pathInput !== currentPath) {
      // Validate path if it's different
      // Assuming activeConnectionId is available (if valid session)
      // If we are checking "local" or a connected ID
      if (activeConnectionId) {
        const exists = await checkPathExists(activeConnectionId, pathInput);
        if (!exists) {
          setIsInvalid(true);
          // Optional: Shake animation or toast?
          return;
        }
      }
    }

    onNavigate(pathInput);
    onTogglePathEdit(false);
    setIsInvalid(false);
  };

  return (
    <div className={cn(
      "border-b border-app-border/20 bg-app-panel/95 backdrop-blur-xl flex items-center justify-between px-3 md:px-5 shrink-0 gap-3 z-20 relative transition-all",
      compactMode ? "h-10 custom-drag-region pt-[2px]" : "h-14"
    )}>
      {/* Minimalist Address Bar */}
      <div className={cn(
        "flex-1 flex items-center bg-transparent rounded-lg min-w-0 mr-auto transition-all no-drag hover:bg-app-surface/30",
        compactMode ? "h-8" : "h-10"
      )}>
        {/* Root Button (Hash Icon) */}
        <button
          onClick={() => onNavigate('/')}
          className={cn(
            'h-8 w-8 flex items-center justify-center rounded-md transition-colors shrink-0 mr-1',
            currentPath === '/'
              ? 'text-app-accent'
              : 'text-app-muted hover:text-app-text hover:bg-app-surface/50',
          )}
          title="Root (/)"
        >
          <Hash size={16} />
        </button>

        {isSmallScreen && (
          <Button
            variant="ghost"
            size="icon"
            className={cn(
              "h-8 w-8 flex items-center justify-center rounded-md text-app-muted hover:text-app-text hover:bg-app-surface/50 shrink-0 mx-0.5",
            )}
            onClick={onToggleSidebar}
            title="Toggle Sidebar"
          >
            <PanelLeft size={16} />
          </Button>
        )}

        <div className="h-4 w-px bg-app-border/30 mx-1 shrink-0" />

        {/* Path Display: Search OR Breadcrumbs OR Input */}
        {isSearchOpen ? (
          <div className="flex-1 flex items-center h-full px-2 gap-2 animate-in slide-in-from-left-2 duration-200">
            <Search size={16} className="text-app-accent shrink-0" />
            <input
              ref={searchInputRef}
              autoFocus
              className="flex-1 bg-transparent border-0 text-sm focus:outline-none font-medium h-full w-full text-app-text placeholder:text-app-muted/50"
              placeholder="Search in current folder..."
              value={searchTerm}
              onChange={(e) => onSearch(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Escape') {
                  onToggleSearch(false);
                  onSearch('');
                }
              }}
            />
            <button
              onClick={() => {
                onToggleSearch(false);
                onSearch('');
              }}
              className="p-1.5 rounded-md hover:bg-app-surface/50 text-app-muted hover:text-app-text transition-colors shrink-0"
              title="Close search"
            >
              <X size={16} />
            </button>
          </div>
        ) : isEditingPath ? (
          <input
            ref={inputRef}
            autoFocus
            className={cn(
              "flex-1 bg-transparent border-0 text-sm focus:outline-none font-medium h-full px-2 w-full transition-colors",
              isInvalid ? "text-app-danger" : "text-app-text"
            )}
            value={pathInput}
            onChange={(e) => {
              setPathInput(e.target.value);
              if (isInvalid) setIsInvalid(false);
            }} onKeyDown={(e) => {
              if (e.key === 'Enter') handlePathSubmit();
              if (e.key === 'Escape') onTogglePathEdit(false);
            }}
            onBlur={() => onTogglePathEdit(false)}
          />
        ) : (
          /* Minimal Breadcrumbs */
          <div
            className="flex items-center gap-0.5 overflow-x-auto overflow-y-hidden flex-1 min-w-0 no-scrollbar h-full mr-2 cursor-text"
            onClick={() => onTogglePathEdit(true)}
            title="Click to edit path (Ctrl+L)"
          >
            {(() => {
              // Cross-platform split: handle both / and \
              const separator = currentPath.includes('\\') ? '\\' : '/';
              const parts = currentPath.split(/[/\\]/).filter((p) => p);

              return parts.map((part, index) => {
                // Reconstruct path using the detected separator
                const fullPath = parts.slice(0, index + 1).join(separator);
                // Ensure root leading slash if it was there (checking original string or just adding / for linux)
                // Actually safer to prepend separator if the original path started with it, but simple join often works if absolute.
                // For Linux/Mac: /foo/bar -> split -> [foo, bar] -> join -> foo/bar. Need leading /.
                // For Windows: C:\foo -> split -> [C:, foo] -> join -> C:\foo. No leading separator needed usually.

                const finalPath = (separator === '/' && !fullPath.startsWith('/') && currentPath.startsWith('/'))
                  ? `/${fullPath}`
                  : fullPath;

                const isLast = index === parts.length - 1;

                return (
                  <div key={finalPath} className="flex items-center shrink-0">
                    <ChevronRight size={14} className="text-app-muted/30 shrink-0 mx-1" />
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        onNavigate(finalPath);
                      }}
                      className={cn(
                        'px-2 py-1 rounded-md transition-all whitespace-nowrap text-sm max-w-[180px] truncate flex items-center gap-1',
                        isLast
                          ? 'text-app-text font-bold'
                          : 'text-app-muted hover:text-app-text hover:bg-app-surface/50 font-medium',
                      )}
                      title={part}
                    >
                      {part.toLowerCase() === 'home' ? <Home size={14} /> : part}
                    </button>
                  </div>
                );
              });
            })()}
          </div>
        )}
      </div>

      {/* Right Actions - Minimalist & Grouped */}
      <div className="flex items-center gap-1 shrink-0 ml-2">
        {!isSmallScreen && (
          <>
            <Button
              variant="ghost"
              size="icon"
              className={cn(
                "rounded-lg text-app-muted hover:text-app-text hover:bg-app-surface/50 transition-all mr-1",
                isSearchOpen && "bg-app-surface/50 text-app-accent",
                compactMode ? "h-8 w-8" : "h-9 w-9"
              )}
              onClick={() => onToggleSearch(!isSearchOpen)}
              title="Search (Mod+F)"
            >
              <Search size={compactMode ? 14 : 18} />
            </Button>

            <div className="h-6 w-px bg-app-border/30 mx-2 shrink-0 hidden md:block" />

            <Button
              variant="ghost"
              size="icon"
              className={cn(
                "rounded-lg text-app-muted hover:text-app-text hover:bg-app-surface/50 transition-all",
                viewMode === 'grid' && "bg-app-surface/50 text-app-accent",
                compactMode ? "h-8 w-8" : "h-9 w-9"
              )}
              onClick={() => onToggleView('grid')}
              title="Grid View"
            >
              <LayoutGrid size={compactMode ? 14 : 18} />
            </Button>

            <Button
              variant="ghost"
              size="icon"
              className={cn(
                "rounded-lg text-app-muted hover:text-app-text hover:bg-app-surface/50 transition-all",
                viewMode === 'list' && "bg-app-surface/50 text-app-accent",
                compactMode ? "h-8 w-8" : "h-9 w-9"
              )}
              onClick={() => onToggleView('list')}
              title="List View"
            >
              <LayoutList size={compactMode ? 14 : 18} />
            </Button>

            <Button
              variant="ghost"
              size="icon"
              className={cn(
                "rounded-lg text-app-muted hover:text-app-text hover:bg-app-surface/50 transition-all ml-1",
                compactMode ? "h-8 w-8" : "h-9 w-9"
              )}
              onClick={onRefresh}
              title="Refresh"
            >
              <RefreshCw size={compactMode ? 14 : 18} />
            </Button>
          </>
        )}

        {isSmallScreen && !isSearchOpen && (
          <Button
            variant="ghost"
            size="icon"
            className={cn(
              "rounded-lg text-app-muted hover:text-app-text hover:bg-app-surface/50 transition-all mr-1",
              compactMode ? "h-8 w-8" : "h-9 w-9"
            )}
            onClick={() => onToggleSearch(true)}
          >
            <Search size={compactMode ? 14 : 18} />
          </Button>
        )}

        {selectedCount >= 1 && onDownloadAsZip && (
          <Button
            variant="ghost"
            size="icon"
            className={cn(
              "rounded-lg text-app-muted hover:text-app-accent hover:bg-app-surface/50 transition-all",
              compactMode ? "h-8 w-8" : "h-9 w-9"
            )}
            onClick={onDownloadAsZip}
            title={`Download ${selectedCount} item${selectedCount > 1 ? 's' : ''} as .tar.gz archive`}
          >
            <FileArchive size={compactMode ? 14 : 18} />
          </Button>
        )}

        <div className="relative ml-2">
          <Button
            variant="primary" // Reverting to primary as per ButtonProps
            size="sm"
            className={cn(
              "rounded-full font-medium shadow-sm active:scale-95 transition-all bg-app-accent hover:bg-app-accent/90 text-white",
              isSmallScreen ? "h-8 w-8 p-0" : compactMode ? "h-8 px-3 text-xs" : "h-9 px-4"
            )}
            onClick={() => setIsMenuOpen(!isMenuOpen)}
            title="Create New..."
          >
            <Plus size={compactMode ? 14 : 16} className={cn(!isSmallScreen && "md:mr-1.5")} />
            {!isSmallScreen && <span className="hidden md:inline">New</span>}
          </Button>

          {isMenuOpen && (
            <>
              <div
                className="fixed inset-0 z-40"
                onClick={() => setIsMenuOpen(false)}
              />
              <div className="absolute top-full right-0 mt-2 w-48 bg-app-panel/95 backdrop-blur-xl border border-app-border/40 rounded-xl shadow-2xl z-50 flex flex-col p-1 animate-in fade-in zoom-in-95 duration-200">
                <button
                  onClick={() => {
                    onNewFolder();
                    setIsMenuOpen(false);
                  }}
                  className="w-full flex items-center gap-3 px-3 py-2 text-left text-sm text-app-text hover:bg-app-accent/10 hover:text-app-accent rounded-lg transition-colors"
                >
                  <FolderInput size={16} />
                  <span>New Folder</span>
                </button>
                <div className="h-px bg-app-border/20 my-1 mx-2" />
                <button
                  onClick={() => {
                    onUpload();
                    setIsMenuOpen(false);
                  }}
                  className="w-full flex items-center gap-3 px-3 py-2 text-left text-sm text-app-text hover:bg-app-accent/10 hover:text-app-accent rounded-lg transition-colors"
                >
                  <Upload size={16} />
                  <span>Upload Files</span>
                </button>
                <button
                  onClick={() => {
                    onUploadFolder();
                    setIsMenuOpen(false);
                  }}
                  className="w-full flex items-center gap-3 px-3 py-2 text-left text-sm text-app-text hover:bg-app-accent/10 hover:text-app-accent rounded-lg transition-colors"
                >
                  <FolderInput size={16} />
                  <span>Upload Folder</span>
                </button>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
