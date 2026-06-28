import { memo, type RefObject } from 'react';
import { Search, ArrowUp, ArrowDown, X } from 'lucide-react';
import { cn } from '../../lib/utils';

export interface TerminalSearchBarProps {
  isOpen: boolean;
  searchText: string;
  inputRef: RefObject<HTMLInputElement | null>;
  onSearchTextChange: (value: string) => void;
  onNext: () => void;
  onPrev: () => void;
  onClose: () => void;
}

export const TerminalSearchBar = memo(function TerminalSearchBar({
  isOpen,
  searchText,
  inputRef,
  onSearchTextChange,
  onNext,
  onPrev,
  onClose,
}: TerminalSearchBarProps) {
  return (
    <div className={cn(
      'absolute top-4 right-4 z-50 flex items-center gap-1 p-1 bg-app-panel backdrop-blur-xl border border-app-border rounded-lg shadow-xl transition-all duration-200 ease-out origin-top-right',
      isOpen ? 'opacity-100 scale-100 translate-y-0' : 'opacity-0 scale-95 -translate-y-2 pointer-events-none',
    )}>
      <div className="relative flex items-center">
        <Search className="absolute left-2 w-3.5 h-3.5 text-app-muted" />
        <input
          ref={inputRef}
          type="text"
          value={searchText}
          onChange={(e) => onSearchTextChange(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              if (e.shiftKey) onPrev();
              else onNext();
            }
            if (e.key === 'Escape') onClose();
          }}
          placeholder="Find..."
          className="w-48 bg-transparent text-sm text-app-text placeholder:text-app-muted/50 pl-7 pr-2 py-1 focus:outline-none"
        />
      </div>

      <div className="h-4 w-[1px] bg-app-border mx-1" />

      <button
        onClick={onPrev}
        className="p-1 hover:bg-app-surface rounded text-app-muted hover:text-app-text transition-colors"
        title="Previous (Shift+Enter)"
        type="button"
      >
        <ArrowUp className="w-4 h-4" />
      </button>
      <button
        onClick={onNext}
        className="p-1 hover:bg-app-surface rounded text-app-muted hover:text-app-text transition-colors"
        title="Next (Enter)"
        type="button"
      >
        <ArrowDown className="w-4 h-4" />
      </button>

      <button
        onClick={onClose}
        className="p-1 hover:bg-red-500/10 hover:text-red-400 rounded text-app-muted transition-colors ml-1"
        type="button"
      >
        <X className="w-4 h-4" />
      </button>
    </div>
  );
});