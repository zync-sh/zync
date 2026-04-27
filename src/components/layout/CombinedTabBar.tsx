import { useState, useRef, useEffect, useMemo, useCallback } from 'react';
import { useAppStore } from '../../store/useAppStore';
import { useShallow } from 'zustand/react/shallow';
import { cn } from '../../lib/utils';
import { Plus, ChevronDown, X, Plug, Terminal as TerminalIcon, Loader2, RotateCw } from 'lucide-react';
import { ContextMenu } from '../ui/ContextMenu';
import { useWindowDrag } from '../../hooks/useWindowDrag';
import type { ShellEntry } from '../../lib/shells/types';
import { ShellIcon } from '../icons/ShellIcon';
import { FEATURE_META, formatFeatureShortcut, type FeatureId } from './featureMeta';
import { Tooltip } from '../ui/Tooltip';

interface CombinedTabBarProps {
    connectionId: string;
    activeView: string;
    activeTerminalId: string | null;
    openFeatures: string[];
    pinnedFeatures: string[];
    pluginPanels?: { id: string; title: string }[];
    availableShells?: ShellEntry[];
    shellsLoading?: boolean;
    shellsError?: string | null;
    onRefetchShells?: () => void;
    defaultShellId?: string;
    onTabSelect: (view: string, termId?: string) => void;
    onFeatureClose: (feature: string) => void;
    onTerminalClose: (termId: string) => void;
    onNewTerminal: (shell?: ShellEntry) => void;
    onOpenFeature?: (feature: string) => void;
    onTogglePin: (feature: string) => void;
}

type ContextMenuTarget =
    | { type: 'terminal'; termId: string }
    | { type: 'feature'; featureId: string }
    | { type: 'plugin'; featureId: string };

const COMMON_SHELL_PATTERN = /(^|\/)(bash|zsh|fish|sh)$/i;
const COMMON_SHELL_LABEL_PATTERN = /\b(?:bash|zsh|fish|sh)\b/i;

function isCommonShellCandidate(shell: ShellEntry): boolean {
    return COMMON_SHELL_PATTERN.test(shell.id) || COMMON_SHELL_LABEL_PATTERN.test(shell.label);
}

function findPreferredShellId(shells: ShellEntry[]): string | undefined {
    return shells.find(isCommonShellCandidate)?.id ?? shells[0]?.id;
}

function normalizeTerminalTitle(title: string): string {
    const match = /^Terminal\s+(\d+)$/i.exec(title.trim());
    if (match) return `Shell ${match[1]}`;
    return title;
}

function getContextMenuItems(
    target: ContextMenuTarget,
    pinnedFeatures: string[],
    onTerminalClose: (termId: string) => void,
    onFeatureClose: (feature: string) => void,
    onTogglePin: (feature: string) => void,
) {
    if (target.type === 'terminal') {
        return [
            {
                label: 'Close Tab',
                variant: 'danger' as const,
                action: () => onTerminalClose(target.termId),
            },
        ];
    }
    if (target.type === 'plugin') {
        return [
            {
                label: 'Close Tab',
                variant: 'danger' as const,
                action: () => onFeatureClose(target.featureId),
            },
        ];
    }

    return [
        {
            label: pinnedFeatures.includes(target.featureId) ? 'Unpin Tab' : 'Pin Tab',
            action: () => onTogglePin(target.featureId),
        },
        {
            label: 'Close Tab',
            variant: 'danger' as const,
            action: () => onFeatureClose(target.featureId),
            disabled: pinnedFeatures.includes(target.featureId),
        },
    ];
}

export function CombinedTabBar({
    connectionId,
    activeView,
    activeTerminalId,
    openFeatures,
    pinnedFeatures,
    pluginPanels = [],
    availableShells = [],
    shellsLoading = false,
    shellsError = null,
    onRefetchShells,
    defaultShellId,
    onTabSelect,
    onFeatureClose,
    onTerminalClose,
    onNewTerminal,
    onOpenFeature,
    onTogglePin
}: CombinedTabBarProps) {
    const terminals = useAppStore(useShallow(state => state.terminals[connectionId] || []));
    const canOpenFeature = Boolean(onOpenFeature);
    const shellById = useMemo(
        () => new Map(availableShells.map(shell => [shell.id, shell] as const)),
        [availableShells],
    );
    const remoteFallbackShellId = useMemo(() => {
        if (connectionId === 'local') return undefined;
        return findPreferredShellId(availableShells);
    }, [availableShells, connectionId]);

    const localFallbackShellId = useMemo(() => {
        if (connectionId !== 'local') return undefined;
        const platform = window.electronUtils?.platform;
        if (platform === 'win32') {
            return defaultShellId && defaultShellId !== 'default' ? defaultShellId : 'powershell';
        }

        return availableShells[0]?.id;
    }, [availableShells, connectionId, defaultShellId]);

    const resolveShell = useCallback((shellId?: string): ShellEntry | undefined => {
        let effectiveShellId = shellId;
        if (!effectiveShellId) {
            effectiveShellId = connectionId === 'local' ? localFallbackShellId : remoteFallbackShellId;
        }

        // Local settings may store "default" to represent Windows PowerShell.
        if (effectiveShellId === 'default') {
            if (connectionId === 'local') {
                effectiveShellId = (localFallbackShellId && localFallbackShellId !== 'default')
                    ? localFallbackShellId
                    : 'powershell';
            } else {
                effectiveShellId = remoteFallbackShellId;
            }
        }

        if (!effectiveShellId) return undefined;
        if (shellById.has(effectiveShellId)) return shellById.get(effectiveShellId);

        // Fallback entry lets ShellIcon render CSS badge even if shell detection
        // has not resolved a concrete icon payload yet.
        return { id: effectiveShellId, label: effectiveShellId };
    }, [connectionId, localFallbackShellId, remoteFallbackShellId, shellById]);

    // Window drag hook for Linux compatibility
    const dragRegionRef = useRef<HTMLDivElement>(null);
    useWindowDrag(dragRegionRef, true);

    // Dropdown State
    const [isDropdownOpen, setIsDropdownOpen] = useState(false);
    const [dropdownAlign, setDropdownAlign] = useState<'left' | 'right'>('left');
    const dropdownRef = useRef<HTMLDivElement>(null);
    const dropdownButtonRef = useRef<HTMLButtonElement>(null);
    const [contextMenu, setContextMenu] = useState<{ x: number, y: number, target: ContextMenuTarget } | null>(null);

    useEffect(() => {
        const handleClickOutside = (event: MouseEvent) => {
            if (dropdownRef.current && !dropdownRef.current.contains(event.target as Node)) {
                setIsDropdownOpen(false);
            }
            // Close context menu if click outside
            if (contextMenu && !(event.target as Element).closest('.context-menu-container')) {
                setContextMenu(null);
            }
        };
        document.addEventListener('mousedown', handleClickOutside);
        document.addEventListener('contextmenu', handleClickOutside); // Also close on right-click outside
        return () => {
            document.removeEventListener('mousedown', handleClickOutside);
            document.removeEventListener('contextmenu', handleClickOutside);
        };
    }, [contextMenu]);

    // Merge Items: Terminals first, then Pinned Features, then Open Features.
    // Keep only built-in features for this section.
    const visibleFeatures = Array.from(new Set([...pinnedFeatures, ...openFeatures]))
        .filter((featureId): featureId is FeatureId =>
            Object.prototype.hasOwnProperty.call(FEATURE_META, featureId)
        );

    return (
        <div ref={dragRegionRef} className="flex items-center w-full bg-app-panel border-b border-app-border px-1 h-9 shrink-0 gap-1 select-none app-drag-region" data-tauri-drag-region>

            {/* Scrollable Tabs Wrapper - flex-initial to size to content, allow shrinking for scroll */}
            <div className="flex-initial min-w-0 flex overflow-x-auto scrollbar-hide h-full items-center gap-1 pr-1 app-drag-region" data-tauri-drag-region>

                {/* 1. Terminal Tabs */}
                {terminals.map(term => {
                    const isActive = activeView === 'terminal' && activeTerminalId === term.id;
                    const effectiveShellId = term.shellOverride
                        ?? (connectionId === 'local'
                            ? localFallbackShellId
                            : remoteFallbackShellId);
                    const shell = resolveShell(effectiveShellId);
                    return (
                        <Tooltip
                            key={term.id}
                            content={normalizeTerminalTitle(term.title)}
                            position="bottom"
                        >
                            <div
                                onClick={() => onTabSelect('terminal', term.id)}
                                onContextMenu={(e) => {
                                    e.preventDefault();
                                    e.stopPropagation();
                                    setContextMenu({ x: e.clientX, y: e.clientY, target: { type: 'terminal', termId: term.id } });
                                }}
                                data-tauri-drag-region="false"
                                className={cn(
                                    "flex items-center gap-2 px-3 py-1.5 h-7 text-xs font-medium rounded-md transition-all cursor-pointer min-w-[100px] max-w-[200px] group border border-transparent drag-none shrink-0",
                                    isActive
                                        ? "bg-app-surface text-app-text shadow-sm border-app-border/50"
                                        : "text-app-muted hover:bg-app-surface/50 hover:text-app-text"
                                )}
                            >
                                {shell ? (
                                    <ShellIcon shell={shell} size={12} />
                                ) : (
                                    <TerminalIcon size={12} className={cn(isActive ? "text-app-accent" : "text-app-muted")} />
                                )}
                                <span className="truncate flex-1">{normalizeTerminalTitle(term.title)}</span>
                                <button
                                    onClick={(e) => { e.stopPropagation(); onTerminalClose(term.id); }}
                                    className={cn(
                                        "p-0.5 rounded hover:bg-app-bg hover:text-red-400 transition-colors opacity-0 group-hover:opacity-100",
                                        isActive && "opacity-100"
                                    )}
                                >
                                    <X size={12} />
                                </button>
                            </div>
                        </Tooltip>
                    );
                })}

                {/* 2. Feature Tabs */}
                {visibleFeatures.map(featureId => {
                    const config = FEATURE_META[featureId];
                    const isActive = activeView === featureId;
                    const isPinned = pinnedFeatures.includes(featureId);
                    const Icon = config.icon;

                    return (
                        <div
                            key={featureId}
                            onClick={() => onTabSelect(featureId)}
                            onContextMenu={(e) => {
                                e.preventDefault();
                                e.stopPropagation();
                                setContextMenu({ x: e.clientX, y: e.clientY, target: { type: 'feature', featureId } });
                            }}
                            data-tauri-drag-region="false"
                            className={cn(
                                "flex items-center gap-2 px-3 py-1.5 h-7 text-xs font-medium rounded-md transition-all cursor-pointer min-w-[90px] group border border-transparent relative drag-none shrink-0",
                                isActive
                                    ? "bg-app-surface text-app-text shadow-sm border-app-border/50"
                                    : "text-app-muted hover:bg-app-surface/50 hover:text-app-text"
                            )}
                        >
                            {/* Pin Indicator */}
                            {isPinned && (
                                <div className="absolute top-0.5 right-0.5 w-1 h-1 rounded-full bg-app-accent" />
                            )}

                            <span className={cn(
                                "inline-flex h-4 w-4 items-center justify-center rounded-sm shrink-0",
                                isActive ? "text-app-accent" : "text-app-muted"
                            )}>
                                <Icon size={11} />
                            </span>
                            <span className="truncate flex-1">{config.label}</span>

                            {/* Close Button (Hidden if Pinned) */}
                            {!isPinned && (
                                <button
                                    onClick={(e) => { e.stopPropagation(); onFeatureClose(featureId); }}
                                    className={cn(
                                        "p-0.5 rounded hover:bg-app-bg hover:text-red-400 transition-colors opacity-0 group-hover:opacity-100",
                                        isActive && "opacity-100"
                                    )}
                                >
                                    <X size={12} />
                                </button>
                            )}
                        </div>
                    );
                })}

                {/* 3. Plugin Panel Tabs (open ones) */}
                {openFeatures.filter(f => f.startsWith('plugin:')).map(featureId => {
                    const panelId = featureId.replace('plugin:', '');
                    const panel = pluginPanels.find(p => p.id === panelId);
                    if (!panel) return null;
                    const isActive = activeView === featureId;
                    return (
                        <div
                            key={featureId}
                            onClick={() => onTabSelect(featureId)}
                            onContextMenu={(e) => {
                                e.preventDefault();
                                e.stopPropagation();
                                setContextMenu({ x: e.clientX, y: e.clientY, target: { type: 'plugin', featureId } });
                            }}
                            data-tauri-drag-region="false"
                            className={cn(
                                "flex items-center gap-2 px-3 py-1.5 h-7 text-xs font-medium rounded-md transition-all cursor-pointer min-w-[90px] group border border-transparent relative drag-none shrink-0",
                                isActive
                                    ? "bg-app-surface text-app-text shadow-sm border-app-border/50"
                                    : "text-app-muted hover:bg-app-surface/50 hover:text-app-text"
                            )}
                        >
                            <Plug size={12} className={cn(isActive ? "text-app-accent" : "text-app-muted")} />
                            <span className="truncate flex-1">{panel.title}</span>
                            <button
                                onClick={(e) => { e.stopPropagation(); onFeatureClose(featureId); }}
                                className={cn(
                                    "p-0.5 rounded hover:bg-app-bg hover:text-red-400 transition-colors opacity-0 group-hover:opacity-100",
                                    isActive && "opacity-100"
                                )}
                            >
                                <X size={12} />
                            </button>
                        </div>
                    );
                })}
            </div>

            {/* 3. Actions: Split button [+|⌄] */}
            <div className="flex items-center bg-app-surface/30 rounded-lg p-0.5 border border-app-border/30 drag-none shrink-0 ml-1" data-tauri-drag-region="false">
                <Tooltip content="New Shell" position="bottom">
                    <button
                        onClick={() => onNewTerminal()}
                        className="h-6 w-7 flex items-center justify-center rounded hover:bg-app-surface hover:text-white text-app-accent transition-colors"
                    >
                        <Plus size={14} strokeWidth={3} />
                    </button>
                </Tooltip>

                <div className="w-px h-4 bg-app-border/50" />

                <div className="relative" ref={dropdownRef}>
                    <Tooltip content="Open shells and features" position="bottom">
                        <button
                            ref={dropdownButtonRef}
                            onClick={() => {
                                const opening = !isDropdownOpen;
                                if (opening && dropdownButtonRef.current) {
                                    const rect = dropdownButtonRef.current.getBoundingClientRect();
                                    const spaceRight = window.innerWidth - rect.left;
                                    setDropdownAlign(spaceRight >= 208 ? 'left' : 'right');
                                }
                                // Trigger a shell-list fetch every time the dropdown is
                                // opened. The hook coalesces concurrent calls and
                                // localStorage cache makes the first paint instant.
                                if (opening) onRefetchShells?.();
                                setIsDropdownOpen(opening);
                            }}
                            className={cn(
                                "h-6 w-6 flex items-center justify-center rounded hover:bg-app-surface transition-colors",
                                isDropdownOpen ? "text-app-text bg-app-surface" : "text-app-muted"
                            )}
                        >
                            <ChevronDown size={12} />
                        </button>
                    </Tooltip>

                    {isDropdownOpen && (
                        <div className={cn(
                            "absolute top-full mt-2 w-52 bg-app-panel border border-app-border rounded-xl shadow-xl z-50 px-1 py-1 animate-in fade-in zoom-in-95 duration-100 flex flex-col",
                            dropdownAlign === 'right' ? 'right-0' : 'left-0'
                        )}>
                            {/* Shell picker. Always shown so the user knows shells are
                                being fetched even when nothing's cached yet. */}
                            {(availableShells.length > 0 || shellsLoading || onRefetchShells) && (
                                <>
                                    <div className="px-3 py-1 text-[10px] font-bold text-app-muted uppercase tracking-wider flex items-center gap-1.5">
                                        <span>Shells</span>
                                        {onRefetchShells && (
                                            <button
                                                type="button"
                                                onClick={(e) => {
                                                    e.preventDefault();
                                                    e.stopPropagation();
                                                    onRefetchShells();
                                                }}
                                                disabled={shellsLoading}
                                                className={cn(
                                                    "h-5 w-5 inline-flex items-center justify-center rounded text-app-muted transition-colors",
                                                    shellsLoading
                                                        ? "cursor-wait opacity-70"
                                                        : "hover:bg-app-surface hover:text-app-text"
                                                )}
                                                title="Reload shells"
                                                aria-label="Reload shells"
                                            >
                                                <RotateCw size={11} className={cn(shellsLoading && "animate-spin")} />
                                            </button>
                                        )}
                                    </div>
                                    <div className="overflow-y-auto max-h-[84px] pr-1">
                                        {availableShells.map(shell => (
                                            <button
                                                key={shell.id}
                                                onClick={() => { onNewTerminal(shell); setIsDropdownOpen(false); }}
                                                className="w-full h-7 text-left px-3 text-xs flex items-center gap-2.5 transition-colors text-app-text hover:bg-app-surface rounded-md"
                                            >
                                                <ShellIcon shell={shell} />
                                                <span className="truncate">{shell.label}</span>
                                            </button>
                                        ))}
                                        {availableShells.length === 0 && shellsLoading && (
                                            <div className="h-7 px-3 text-xs flex items-center gap-2.5 text-app-muted">
                                                <Loader2 size={12} className="animate-spin" />
                                                <span>Loading shells…</span>
                                            </div>
                                        )}
                                        {availableShells.length === 0 && !shellsLoading && shellsError && (
                                            <div
                                                className="min-h-7 px-3 py-1 text-xs flex items-center gap-2.5 text-app-muted"
                                                title={shellsError}
                                            >
                                                <TerminalIcon size={12} className="opacity-60" />
                                                <span className="truncate">Couldn’t load shells</span>
                                            </div>
                                        )}
                                    </div>
                                    <div className="h-px bg-app-border/50 my-1 mx-1" />
                                </>
                            )}

                            {/* Features */}
                            {canOpenFeature && (
                                <>
                                    <div className="px-3 py-1 text-[10px] font-bold text-app-muted uppercase tracking-wider">Features</div>
                                    {Object.entries(FEATURE_META).map(([key, conf]) => {
                                const isOpen = openFeatures.includes(key);
                                const isActive = activeView === key;
                                const Icon = conf.icon;
                                return (
                                    <Tooltip
                                        key={key}
                                        content={`${conf.label} • ${formatFeatureShortcut(conf.keys)}`}
                                        position="right"
                                        className="w-full"
                                    >
                                        <button
                                            onClick={() => {
                                                onOpenFeature!(key);
                                                setIsDropdownOpen(false);
                                            }}
                                            disabled={isActive}
                                            className={cn(
                                                "w-full text-left px-3 py-1.5 text-xs flex items-center gap-2.5 transition-colors rounded-md",
                                                isActive ? "bg-app-accent/10 text-app-accent cursor-default" : "text-app-text hover:bg-app-surface"
                                            )}
                                        >
                                            <span className={cn(
                                                "inline-flex h-5 w-5 items-center justify-center rounded-md shrink-0",
                                                isActive ? "text-app-accent" : "text-app-muted"
                                            )}>
                                                <Icon size={12} />
                                            </span>
                                            <span className="flex-1 font-medium truncate">{conf.label}</span>
                                            {isActive ? (
                                                <span className="text-[10px] opacity-70">Active</span>
                                            ) : isOpen ? (
                                                <span className="text-[10px] opacity-50">Open</span>
                                            ) : null}
                                        </button>
                                    </Tooltip>
                                );
                                    })}
                                </>
                            )}

                            {/* Plugin Panels */}
                            {canOpenFeature && pluginPanels.length > 0 && (
                                <>
                                    <div className="h-px bg-app-border/50 my-1 mx-1" />
                                    <div className="px-3 py-1 text-[10px] font-bold text-app-muted uppercase tracking-wider flex items-center gap-1.5">
                                        <Plug size={10} />
                                        Plugin Panels
                                    </div>
                                    {pluginPanels.map(panel => {
                                        const featureId = `plugin:${panel.id}`;
                                        const isActive = activeView === featureId;
                                        return (
                                            <button
                                                key={panel.id}
                                                onClick={() => {
                                                    onOpenFeature!(featureId);
                                                    setIsDropdownOpen(false);
                                                }}
                                                disabled={isActive}
                                                className={cn(
                                                    "w-full text-left px-3 py-1.5 text-xs flex items-center gap-2.5 transition-colors rounded-md",
                                                    isActive ? "bg-app-accent/10 text-app-accent cursor-default" : "text-app-text hover:bg-app-surface"
                                                )}
                                            >
                                                <Plug size={14} className={cn("opacity-80 text-app-accent", isActive && "opacity-100")} />
                                                <span className="flex-1 font-medium">{panel.title}</span>
                                                {isActive && <span className="text-[10px] opacity-70">Active</span>}
                                            </button>
                                        );
                                    })}
                                </>
                            )}
                        </div>
                    )}
                </div>
            </div>

            {contextMenu && (
                <ContextMenu
                    x={contextMenu.x}
                    y={contextMenu.y}
                    onClose={() => setContextMenu(null)}
                    items={getContextMenuItems(
                        contextMenu.target,
                        pinnedFeatures,
                        onTerminalClose,
                        onFeatureClose,
                        onTogglePin,
                    )}
                />
            )}
        </div>
    );
}
