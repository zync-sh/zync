import { useEffect, useRef, useCallback, useState, useMemo, memo } from 'react';
import { Command } from 'cmdk';
import { Globe, Server, Search, CornerDownLeft } from 'lucide-react';
import { useAppStore } from '../../store/useAppStore';
import { ZPortal } from '../ui/ZPortal';
import { clsx } from 'clsx';

interface SnippetPickerProps {
    connectionId: string;
    isOpen: boolean;
    onClose: () => void;
}

export const SnippetPicker = memo(function SnippetPicker({ connectionId, isOpen, onClose }: SnippetPickerProps) {
    const snippets = useAppStore(state => state.snippets);
    const inputRef = useRef<HTMLInputElement>(null);
    const [selectedValue, setSelectedValue] = useState<string>('');

    // Filter snippets scoped to this connection + globals
    const filteredSnippets = useMemo(() => snippets.filter(s =>
        !s.connectionId || s.connectionId === connectionId
    ), [snippets, connectionId]);

    const closeAndRestoreFocus = useCallback(() => {
        if (document.activeElement instanceof HTMLElement) {
            document.activeElement.blur();
        }
        window.dispatchEvent(new CustomEvent('ssh-ui:term-focus'));
        onClose();
    }, [onClose]);

    const runSnippet = useCallback((command: string) => {
        closeAndRestoreFocus();
        window.dispatchEvent(new CustomEvent('ssh-ui:run-command', {
            detail: { connectionId, command: command + '\r' }
        }));
    }, [connectionId, closeAndRestoreFocus]);

    // Auto-focus and set initial selection
    useEffect(() => {
        if (isOpen) {
            const timerId = setTimeout(() => inputRef.current?.focus(), 50);
            if (filteredSnippets.length > 0 && !selectedValue) {
                setSelectedValue(filteredSnippets[0].id);
            }
            return () => clearTimeout(timerId);
        }
    }, [isOpen, filteredSnippets, selectedValue]);

    // Close on Escape
    useEffect(() => {
        if (!isOpen) return;

        const handleKey = (e: KeyboardEvent) => {
            if (e.key === 'Escape') {
                e.preventDefault();
                closeAndRestoreFocus();
            }
        };
        window.addEventListener('keydown', handleKey, { capture: true });
        return () => window.removeEventListener('keydown', handleKey, { capture: true });
    }, [isOpen, onClose]);

    if (!isOpen) return null;

    return (
        <ZPortal className="fixed inset-0 z-[9999] flex items-start justify-center pt-[20vh] px-4">
            {/* Backdrop */}
            <div
                className="absolute inset-0 bg-black/40 backdrop-blur-[1px]"
                onClick={closeAndRestoreFocus}
            />

            <div className="relative w-full max-w-xl animate-in fade-in zoom-in-95 duration-200">
                <Command
                    value={selectedValue}
                    onValueChange={setSelectedValue}
                    className={clsx(
                        'flex flex-col w-full max-h-[55vh] overflow-hidden rounded-xl border shadow-[0_24px_48px_-12px_rgba(0,0,0,0.5)]',
                        'bg-app-panel/90 backdrop-blur-xl border-app-border/40 text-app-text'
                    )}
                    loop
                >
                    {/* Search input */}
                    <div className="flex items-center gap-3 border-b border-app-border/30 px-3 py-0.5" cmdk-input-wrapper="">
                        <Search className="h-4 w-4 shrink-0 text-app-accent/60" />
                        <Command.Input
                            ref={inputRef}
                            autoFocus
                            placeholder="Search snippets..."
                            className="flex h-10 w-full bg-transparent py-2 text-sm outline-none placeholder:text-app-muted/40"
                        />
                        <div className="flex items-center gap-1 shrink-0">
                            <span className="text-[9px] font-bold text-app-muted border border-app-border/50 rounded px-1.5 py-0.5 uppercase tracking-tighter">ESC</span>
                        </div>
                    </div>

                    <Command.List className="overflow-y-auto p-1.5 scrollbar-thin scrollbar-track-transparent scrollbar-thumb-app-border/40">
                        <Command.Empty className="py-10 text-center text-sm text-app-muted animate-in fade-in duration-300">
                            No snippets found.
                        </Command.Empty>

                        {filteredSnippets.map(snippet => (
                            <Command.Item
                                key={snippet.id}
                                value={snippet.id}
                                onSelect={() => runSnippet(snippet.command)}
                                className={clsx(
                                    "relative flex cursor-pointer select-none items-center rounded-lg px-2.5 py-1.5 text-sm outline-none transition-all duration-150 group mb-0.5",
                                    "data-[selected=true]:bg-app-accent/20 data-[selected=true]:text-app-text",
                                    "hover:bg-app-accent/5"
                                )}
                            >
                                {/* Hidden keywords for cmdk search */}
                                <span className="hidden">{snippet.name} {snippet.command} {snippet.category}</span>

                                <div className="mr-3 h-7 w-7 shrink-0 flex items-center justify-center rounded-md bg-app-surface/40 border border-app-border/30 group-data-[selected=true]:border-app-accent/30 group-data-[selected=true]:bg-app-accent/10 transition-all">
                                    {snippet.connectionId ? (
                                        <Server className="h-3.5 w-3.5 text-app-accent/80 group-data-[selected=true]:text-app-accent" />
                                    ) : (
                                        <Globe className="h-3.5 w-3.5 text-app-muted group-data-[selected=true]:text-app-accent" />
                                    )}
                                </div>

                                <div className="flex flex-col flex-1 min-w-0">
                                    <div className="flex items-center gap-2 flex-wrap min-w-0">
                                        <span className="font-medium text-app-text group-data-[selected=true]:text-app-accent transition-colors truncate">
                                            {snippet.name}
                                        </span>
                                        {/* Scope tag */}
                                        {snippet.connectionId ? (
                                            <span className="text-[8px] font-bold bg-app-accent/20 text-app-accent px-1 py-0.5 rounded-[2px] uppercase tracking-tighter shadow-sm shrink-0">Host</span>
                                        ) : (
                                            <span className="text-[8px] font-bold bg-app-muted/15 text-app-muted/70 px-1 py-0.5 rounded-[2px] uppercase tracking-tighter shrink-0">Global</span>
                                        )}
                                    </div>
                                    <span className="text-[10px] text-app-muted/50 font-mono truncate leading-tight">
                                        {snippet.command}
                                    </span>
                                </div>

                                <div className="ml-2 flex items-center opacity-0 group-data-[selected=true]:opacity-100 transition-all">
                                    <div className="flex items-center gap-0.5 rounded bg-app-accent px-1.5 py-0.5 text-[9px] font-bold text-white shadow-sm">
                                        Run <CornerDownLeft size={8} strokeWidth={3} />
                                    </div>
                                </div>
                            </Command.Item>
                        ))}
                    </Command.List>

                    {/* Footer hint */}
                    <div className="border-t border-app-border/30 bg-app-surface/20 px-3 py-1.5 flex items-center justify-between text-[9px] font-medium text-app-muted/60">
                        <div className="flex gap-3">
                            <span className="flex items-center gap-1">
                                <kbd className="rounded border border-app-border/50 bg-app-surface/40 px-1 py-0.5 font-sans min-w-[1.2em] text-center">↑</kbd>
                                <kbd className="rounded border border-app-border/50 bg-app-surface/40 px-1 py-0.5 font-sans min-w-[1.2em] text-center">↓</kbd>
                                <span>Navigate</span>
                            </span>
                            <span className="flex items-center gap-1">
                                <kbd className="rounded border border-app-border/50 bg-app-surface/40 px-1.2 py-0.5 font-sans">Enter</kbd>
                                <span>Run</span>
                            </span>
                        </div>
                        <div className="flex items-center gap-2 italic">
                            <span>Snippet Access</span>
                        </div>
                    </div>
                </Command>
            </div>
        </ZPortal>
    );
});
