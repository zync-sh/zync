import { useState, useCallback, useEffect, useRef, type KeyboardEvent, type ReactNode } from 'react';
import { Globe, Server, X, Search, Terminal, Settings2, SlidersHorizontal } from 'lucide-react';
import { useAppStore } from '../../store/useAppStore';
import { track } from '../../features/usage';
import { cn } from '../../lib/utils';
import { formatShortcutLabel } from '../../lib/shortcuts';
import { TerminalQuickSettings } from './TerminalQuickSettings';

type SessionToolId = 'snippets' | 'terminal';

function focusSessionToolsToggle(tabId: string | undefined, connectionId: string): void {
    const ids = [
        tabId ? `session-tools-toggle-${tabId}` : null,
        `session-tools-toggle-${connectionId}`,
    ];
    const seen = new Set<string>();
    for (const id of ids) {
        if (!id || seen.has(id)) continue;
        seen.add(id);
        const el = document.getElementById(id);
        if (el instanceof HTMLElement) {
            el.focus();
            return;
        }
    }
}

interface SnippetSidebarProps {
    connectionId: string;
    tabId?: string;
    isOpen: boolean;
    onClose: () => void;
    /** When true, closing the rail returns focus to the PTY. Otherwise the opener control is focused. */
    restoreTerminalFocus?: boolean;
}

export function SnippetSidebar({ connectionId, tabId, isOpen, onClose, restoreTerminalFocus = false }: SnippetSidebarProps) {
    const snippets = useAppStore((state) => state.snippets);
    const isLoadingSnippets = useAppStore((state) => state.isLoadingSnippets);
    const showToast = useAppStore((state) => state.showToast);
    const [search, setSearch] = useState('');
    const [tool, setTool] = useState<SessionToolId>('snippets');
    const inputRef = useRef<HTMLInputElement>(null);
    const panelRef = useRef<HTMLDivElement>(null);
    const wasOpenRef = useRef(isOpen);
    const isMac = typeof navigator !== 'undefined' && /mac/i.test(navigator.platform);
    const shortcutLabel = formatShortcutLabel('Ctrl+Shift+S', isMac);

    useEffect(() => {
        const wasOpen = wasOpenRef.current;
        wasOpenRef.current = isOpen;
        if (!isOpen && wasOpen) {
            if (document.activeElement instanceof HTMLElement && panelRef.current?.contains(document.activeElement)) {
                document.activeElement.blur();
            }
            if (restoreTerminalFocus) {
                window.dispatchEvent(new CustomEvent('ssh-ui:term-focus'));
            } else {
                focusSessionToolsToggle(tabId, connectionId);
            }
        }
    }, [isOpen, restoreTerminalFocus, tabId, connectionId]);

    useEffect(() => {
        if (!isOpen) return;
        const focusTimer = window.setTimeout(() => {
            if (tool === 'snippets') {
                inputRef.current?.focus();
                return;
            }
            panelRef.current?.focus();
        }, 80);
        return () => window.clearTimeout(focusTimer);
    }, [isOpen, tool]);

    const filteredSnippets = snippets.filter((s) => {
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
        if (document.activeElement instanceof HTMLElement) {
            document.activeElement.blur();
        }
        window.dispatchEvent(new CustomEvent('ssh-ui:term-focus'));
        window.dispatchEvent(new CustomEvent('ssh-ui:run-command', {
            detail: { connectionId, command: command + '\r' },
        }));
        track('snippet_insert');
        showToast('success', 'Command sent to terminal');
    }, [connectionId, showToast]);

    const openSnippetManager = () => {
        if (!tabId) return;
        window.dispatchEvent(new CustomEvent('ssh-ui:open-feature', {
            detail: { feature: 'snippets', tabId },
        }));
    };

    const handlePanelKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
        if (e.key !== 'Escape') return;
        e.preventDefault();
        e.stopPropagation();
        if (tool === 'snippets' && search) {
            setSearch('');
            return;
        }
        onClose();
    };

    const emptyLabel = isLoadingSnippets
        ? 'Loading snippets…'
        : search.trim()
            ? 'No matches'
            : 'No snippets yet';

    return (
        <div
            ref={panelRef}
            tabIndex={-1}
            onKeyDown={handlePanelKeyDown}
            className={cn(
                'absolute right-0 top-0 bottom-0 z-40 flex flex-col',
                'bg-app-panel/90 backdrop-blur-xl border-l border-app-border/40 shadow-[-16px_0_32px_-8px_rgba(0,0,0,0.3)]',
                'transition-all duration-300 ease-in-out',
                isOpen ? 'w-64 opacity-100 pointer-events-auto translate-x-0' : 'w-0 opacity-0 pointer-events-none translate-x-4 overflow-hidden',
            )}
        >
            <div className="flex items-center justify-between px-2 py-1.5 border-b border-app-border/30 shrink-0 gap-1">
                <div
                    className="flex flex-1 min-w-0 rounded-md bg-app-surface/40 p-0.5 border border-app-border/30"
                    role="tablist"
                    aria-label="Session tools"
                >
                    <ToolTab
                        id="snippets"
                        label="Snippets"
                        icon={<Terminal size={11} />}
                        active={tool === 'snippets'}
                        onSelect={setTool}
                    />
                    <ToolTab
                        id="terminal"
                        label="Terminal"
                        icon={<SlidersHorizontal size={11} />}
                        active={tool === 'terminal'}
                        onSelect={setTool}
                    />
                </div>
                <button
                    type="button"
                    onClick={onClose}
                    className="text-app-muted hover:text-app-text hover:bg-app-surface/50 transition-all p-1 rounded-md shrink-0"
                    title={`Close (${shortcutLabel})`}
                    aria-label="Close session tools"
                >
                    <X size={12} />
                </button>
            </div>

            {tool === 'snippets' && (
                <>
                    <div className="px-2 py-2 shrink-0 border-b border-app-border/20">
                        <div className="flex items-center gap-2 bg-app-surface/30 border border-app-border/40 rounded px-2 py-1 focus-within:border-app-accent/50 transition-colors">
                            <Search size={10} className="text-app-muted shrink-0" />
                            <input
                                ref={inputRef}
                                type="search"
                                value={search}
                                onChange={(e) => setSearch(e.target.value)}
                                placeholder="Search snippets…"
                                className="flex-1 min-w-0 bg-transparent text-[10px] text-app-text placeholder:text-app-muted/40 outline-none"
                                aria-label="Search snippets"
                            />
                        </div>
                    </div>

                    <div className="flex-1 overflow-y-auto scrollbar-thin scrollbar-track-transparent scrollbar-thumb-app-border/40 py-1">
                        {filteredSnippets.length === 0 && (
                            <div className="flex flex-col items-center justify-center py-10 text-center px-4 opacity-60">
                                <Terminal size={20} className="mb-2 text-app-muted" />
                                <span className="text-[10px] font-medium text-app-muted">{emptyLabel}</span>
                                {!isLoadingSnippets && !search.trim() && (
                                    <button
                                        type="button"
                                        onClick={openSnippetManager}
                                        className="mt-2 text-[10px] text-app-accent hover:underline"
                                    >
                                        Manage snippets
                                    </button>
                                )}
                                {search.trim() && (
                                    <button
                                        type="button"
                                        onClick={() => setSearch('')}
                                        className="mt-2 text-[10px] text-app-accent hover:underline"
                                    >
                                        Clear search
                                    </button>
                                )}
                            </div>
                        )}

                        {Object.entries(grouped).map(([category, items]) => (
                            <div key={category} className="mb-2">
                                <div className="px-3 py-0.5 text-[8px] font-bold text-app-muted/50 uppercase tracking-[0.2em] mb-1">
                                    {category}
                                </div>
                                {items.map((snippet) => (
                                    <button
                                        key={snippet.id}
                                        type="button"
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
                </>
            )}

            {tool === 'terminal' && <TerminalQuickSettings />}

            <div className="px-3 py-2 border-t border-app-border/20 bg-app-surface/20 shrink-0">
                <div className="flex items-center justify-between gap-2">
                    {tool === 'snippets' ? (
                        <button
                            type="button"
                            onClick={openSnippetManager}
                            className="text-[9px] text-app-muted hover:text-app-text font-medium tracking-tight inline-flex items-center gap-1"
                        >
                            <Settings2 size={9} />
                            Manage
                        </button>
                    ) : (
                        <span className="text-[9px] text-app-muted/50 font-medium tracking-tight">Session tools</span>
                    )}
                    <kbd className="text-[8px] font-mono bg-app-surface/50 border border-app-border/40 px-1 py-0.5 rounded text-app-muted/50">
                        {shortcutLabel}
                    </kbd>
                </div>
            </div>
        </div>
    );
}

function ToolTab({
    id,
    label,
    icon,
    active,
    onSelect,
}: {
    id: SessionToolId;
    label: string;
    icon: ReactNode;
    active: boolean;
    onSelect: (id: SessionToolId) => void;
}) {
    return (
        <button
            type="button"
            role="tab"
            aria-selected={active}
            onClick={() => onSelect(id)}
            className={cn(
                'flex-1 min-w-0 h-6 px-1 rounded flex items-center justify-center gap-1 text-[9px] font-semibold uppercase tracking-wide transition-colors',
                active ? 'bg-app-accent/20 text-app-text' : 'text-app-muted hover:text-app-text',
            )}
        >
            {icon}
            <span className="truncate">{label}</span>
        </button>
    );
}
