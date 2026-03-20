import { useState, useCallback, useEffect, useRef } from 'react';
import { Globe, Server, X, Search, Terminal } from 'lucide-react';
import { useAppStore } from '../../store/useAppStore';
import { cn } from '../../lib/utils';

interface SnippetSidebarProps {
    connectionId: string;
    isOpen: boolean;
    onClose: () => void;
}

export function SnippetSidebar({ connectionId, isOpen, onClose }: SnippetSidebarProps) {
    const snippets = useAppStore(state => state.snippets);
    const showToast = useAppStore(state => state.showToast);
    const [search, setSearch] = useState('');
    const inputRef = useRef<HTMLInputElement>(null);

    // Handle Escape key and auto-focus
    useEffect(() => {
        if (!isOpen) return;
        
        // Auto-focus search input
        const focusTimer = window.setTimeout(() => inputRef.current?.focus(), 100);

        const handleKeyDown = (e: KeyboardEvent) => {
            if (e.key === 'Escape') {
                e.preventDefault();
                onClose();
            }
        };
        window.addEventListener('keydown', handleKeyDown, { capture: true });
        return () => {
            window.clearTimeout(focusTimer);
            window.removeEventListener('keydown', handleKeyDown, { capture: true });
        };
    }, [isOpen, onClose]);

    // Filter by connection scope + search query
    const filteredSnippets = snippets.filter(s => {
        const inScope = !s.connectionId || s.connectionId === connectionId;
        if (!inScope) return false;
        if (!search) return true;
        const q = search.toLowerCase();
        return s.name.toLowerCase().includes(q) || s.command.toLowerCase().includes(q);
    });

    const grouped = filteredSnippets.reduce((acc, s) => {
        const cat = s.category || 'General';
        if (!acc[cat]) acc[cat] = [];
        acc[cat].push(s);
        return acc;
    }, {} as Record<string, typeof filteredSnippets>);

    const runSnippet = useCallback((command: string) => {
        window.dispatchEvent(new CustomEvent('ssh-ui:run-command', {
            detail: { connectionId, command: command + '\r' }
        }));
        showToast('success', 'Command sent to terminal');
    }, [connectionId, showToast]);

    return (
        <div
            className={cn(
                'absolute right-0 top-0 bottom-0 z-20 flex flex-col',
                'bg-app-panel/90 backdrop-blur-xl border-l border-app-border/40 shadow-[-16px_0_32px_-8px_rgba(0,0,0,0.3)]',
                'transition-all duration-300 ease-in-out',
                isOpen ? 'w-60 opacity-100 pointer-events-auto translate-x-0' : 'w-0 opacity-0 pointer-events-none translate-x-4 overflow-hidden'
            )}
        >
            {/* Header */}
            <div className="flex items-center justify-between px-3 py-2 border-b border-app-border/30 shrink-0">
                <div className="flex items-center gap-1.5">
                    <Terminal size={12} className="text-app-accent" />
                    <span className="text-[10px] font-bold text-app-text uppercase tracking-wider">Snippets</span>
                </div>
                <button
                    onClick={onClose}
                    className="text-app-muted hover:text-app-text hover:bg-app-surface/50 transition-all p-1 rounded-md"
                    title="Close (Ctrl+Shift+`)"
                    aria-label="Close snippets"
                >
                    <X size={12} />
                </button>
            </div>

            {/* Search */}
            <div className="px-2 py-2 shrink-0 border-b border-app-border/20">
                <div className="flex items-center gap-2 bg-app-surface/30 border border-app-border/40 rounded px-2 py-1 focus-within:border-app-accent/50 transition-colors">
                    <Search size={10} className="text-app-muted shrink-0" />
                    <input
                        ref={inputRef}
                        type="text"
                        value={search}
                        onChange={e => setSearch(e.target.value)}
                        placeholder="Search..."
                        className="flex-1 min-w-0 bg-transparent text-[10px] text-app-text placeholder:text-app-muted/40 outline-none"
                        aria-label="Search snippets"
                    />
                </div>
            </div>

            {/* Snippet list */}
            <div className="flex-1 overflow-y-auto scrollbar-thin scrollbar-track-transparent scrollbar-thumb-app-border/40 py-1">
                {filteredSnippets.length === 0 && (
                    <div className="flex flex-col items-center justify-center py-10 text-center px-4 opacity-40">
                        <Terminal size={20} className="mb-2" />
                        <span className="text-[9px] font-medium">Matches not found</span>
                    </div>
                )}

                {Object.entries(grouped).map(([category, items]) => (
                    <div key={category} className="mb-2">
                        <div className="px-3 py-0.5 text-[8px] font-bold text-app-muted/50 uppercase tracking-[0.2em] mb-1">
                            {category}
                        </div>
                        {items.map(snippet => (
                            <button
                                key={snippet.id}
                                onClick={() => runSnippet(snippet.command)}
                                className="w-full text-left px-3 py-1.5 flex items-start gap-2.5 hover:bg-app-accent/5 transition-all group border-l-2 border-transparent hover:border-app-accent/40"
                                title={snippet.command}
                            >
                                <div className="mt-0.5 shrink-0 w-5 h-5 flex items-center justify-center rounded bg-app-surface/40 border border-app-border/30 group-hover:border-app-accent/20 group-hover:bg-app-accent/5 transition-all">
                                    {snippet.connectionId ? (
                                        <Server size={10} className="text-app-accent/70 group-hover:text-app-accent" />
                                    ) : (
                                        <Globe size={10} className="text-app-muted group-hover:text-app-accent" />
                                    )}
                                </div>
                                <div className="flex-1 min-w-0">
                                    <div className="flex items-center gap-1 mb-0.5">
                                        <span className="text-[11px] font-medium text-app-text truncate group-hover:text-app-accent transition-colors">
                                            {snippet.name}
                                        </span>
                                        {snippet.connectionId && (
                                            <span className="text-[7px] font-black bg-app-accent/10 text-app-accent px-1 rounded-[1px] uppercase tracking-tighter shrink-0">Host</span>
                                        )}
                                    </div>
                                    <span className="text-[9.5px] font-mono text-app-muted/50 truncate block leading-tight">
                                        {snippet.command}
                                    </span>
                                </div>
                            </button>
                        ))}
                    </div>
                ))}
            </div>

            {/* Footer */}
            <div className="px-3 py-2 border-t border-app-border/20 bg-app-surface/20 shrink-0">
                <div className="flex items-center justify-between">
                    <span className="text-[9px] text-app-muted/40 font-medium tracking-tight">Snippet Panel</span>
                    <kbd className="text-[8px] font-mono bg-app-surface/50 border border-app-border/40 px-1 py-0.5 rounded text-app-muted/50">Ctrl+Shift+`</kbd>
                </div>
            </div>
        </div>
    );
}
