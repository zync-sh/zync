import { useState, useRef, useEffect } from 'react';
import { useAppStore } from '../../store/useAppStore';
import { useShallow } from 'zustand/react/shallow';
import { cn } from '../../lib/utils';
import { Terminal as TerminalIcon, Files, Network, Code, LayoutDashboard, Plus, ChevronDown, X } from 'lucide-react';
import { ContextMenu } from '../ui/ContextMenu';
import { useWindowDrag } from '../../hooks/useWindowDrag';

interface CombinedTabBarProps {
    connectionId: string;
    activeView: 'dashboard' | 'files' | 'port-forwarding' | 'snippets' | 'terminal';
    activeTerminalId: string | null;
    openFeatures: string[];
    pinnedFeatures: string[];
    onTabSelect: (view: 'dashboard' | 'files' | 'port-forwarding' | 'snippets' | 'terminal', termId?: string) => void;
    onFeatureClose: (feature: string) => void;
    onTerminalClose: (termId: string) => void;
    onNewTerminal: () => void;
    onOpenFeature: (feature: string) => void;
    onTogglePin: (feature: string) => void;
}

export function CombinedTabBar({
    connectionId,
    activeView,
    activeTerminalId,
    openFeatures,
    pinnedFeatures,
    onTabSelect,
    onFeatureClose,
    onTerminalClose,
    onNewTerminal,
    onOpenFeature,
    onTogglePin
}: CombinedTabBarProps) {
    const terminals = useAppStore(useShallow(state => state.terminals[connectionId] || []));

    // Window drag hook for Linux compatibility
    const dragRegionRef = useRef<HTMLDivElement>(null);
    useWindowDrag(dragRegionRef, true);

    // Dropdown State
    const [isDropdownOpen, setIsDropdownOpen] = useState(false);
    const dropdownRef = useRef<HTMLDivElement>(null);
    const [contextMenu, setContextMenu] = useState<{ x: number, y: number, feature: string } | null>(null);

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

    // Merge Items: Terminals first, then Pinned Features, then Open Features
    // We filter openFeatures to exclude pinned ones to avoid duplication
    const visibleFeatures = Array.from(new Set([...pinnedFeatures, ...openFeatures]));

    const FEATURE_CONFIG: Record<string, { icon: any, label: string, view: any, shortcut: string }> = {
        'files': { icon: Files, label: 'Files', view: 'files', shortcut: 'Ctrl+Shift+F' },
        'port-forwarding': { icon: Network, label: 'Port Forwarding', view: 'port-forwarding', shortcut: 'Ctrl+Shift+N' },
        'snippets': { icon: Code, label: 'Snippets', view: 'snippets', shortcut: 'Ctrl+Shift+S' },
        'dashboard': { icon: LayoutDashboard, label: 'Dashboard', view: 'dashboard', shortcut: 'Ctrl+Shift+D' },
    };

    return (
        <div ref={dragRegionRef} className="flex items-center w-full bg-app-panel border-b border-app-border px-1 h-9 shrink-0 gap-1 select-none app-drag-region" data-tauri-drag-region>

            {/* Scrollable Tabs Wrapper - flex-initial to size to content, allow shrinking for scroll */}
            <div className="flex-initial min-w-0 flex overflow-x-auto scrollbar-hide h-full items-center gap-1 pr-1 app-drag-region" data-tauri-drag-region>

                {/* 1. Terminal Tabs */}
                {terminals.map(term => {
                    const isActive = activeView === 'terminal' && activeTerminalId === term.id;
                    return (
                        <div
                            key={term.id}
                            onClick={() => onTabSelect('terminal', term.id)}
                            data-tauri-drag-region="false"
                            className={cn(
                                "flex items-center gap-2 px-3 py-1.5 h-7 text-xs font-medium rounded-md transition-all cursor-pointer min-w-[100px] max-w-[200px] group border border-transparent drag-none shrink-0",
                                isActive
                                    ? "bg-app-surface text-app-text shadow-sm border-app-border/50"
                                    : "text-app-muted hover:bg-app-surface/50 hover:text-app-text"
                            )}
                            title={term.title}
                        >
                            <TerminalIcon size={12} className={cn(isActive ? "text-app-accent" : "text-app-muted")} />
                            <span className="truncate flex-1">{term.title}</span>
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
                    );
                })}

                {/* 2. Feature Tabs (Pinned & Open) */}
                {visibleFeatures.map(feature => {
                    const config = FEATURE_CONFIG[feature];
                    if (!config) return null;
                    const isActive = activeView === feature;
                    const isPinned = pinnedFeatures.includes(feature);
                    const Icon = config.icon;

                    return (
                        <div
                            key={feature}
                            onClick={() => onTabSelect(config.view)}
                            onContextMenu={(e) => {
                                e.preventDefault();
                                e.stopPropagation(); // Stop propagation to document
                                console.log('[CombinedTabBar] Right-click on feature:', feature);
                                setContextMenu({ x: e.clientX, y: e.clientY, feature });
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

                            <Icon size={12} className={cn(isActive ? "text-app-accent" : "text-app-muted")} />
                            <span className="truncate flex-1">{config.label}</span>

                            {/* Close Button (Hidden if Pinned) */}
                            {!isPinned && (
                                <button
                                    onClick={(e) => { e.stopPropagation(); onFeatureClose(feature); }}
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
            </div>

            {/* 3. Actions: Add Terminal + Dropdown (Outside scrollable area) */}
            <div className="flex items-center gap-0.5 bg-app-surface/30 rounded-lg p-0.5 border border-app-border/30 drag-none shrink-0 ml-1" data-tauri-drag-region="false">
                <button
                    onClick={onNewTerminal}
                    className="h-6 w-7 flex items-center justify-center rounded hover:bg-app-surface hover:text-white text-app-accent transition-colors"
                    title="New Terminal"
                >
                    <Plus size={14} strokeWidth={3} />
                </button>
                <div className="w-[1px] h-4 bg-app-border/50" />

                <div className="relative" ref={dropdownRef}>
                    <button
                        onClick={() => setIsDropdownOpen(!isDropdownOpen)}
                        className={cn(
                            "h-6 w-6 flex items-center justify-center rounded hover:bg-app-surface transition-colors",
                            isDropdownOpen ? "text-app-text bg-app-surface" : "text-app-muted"
                        )}
                        title="Open Feature..."
                    >
                        <ChevronDown size={12} />
                    </button>

                    {isDropdownOpen && (
                        <div className="absolute top-full right-0 mt-2 w-52 bg-app-panel border border-app-border rounded-xl shadow-xl z-50 overflow-hidden py-1 animate-in fade-in zoom-in-95 duration-100 flex flex-col">



                            <button
                                onClick={() => {
                                    onNewTerminal();
                                    setIsDropdownOpen(false);
                                }}
                                className="w-full text-left px-3 py-1.5 text-xs flex items-center gap-2.5 transition-colors text-app-text hover:bg-app-surface mx-1 rounded-md w-[calc(100%-8px)]"
                            >
                                <TerminalIcon size={14} className="opacity-80" />
                                <span>Terminal</span>
                            </button>

                            <div className="h-[1px] bg-app-border/50 my-1 mx-2" />

                            <div className="px-3 py-1 text-[10px] font-bold text-app-muted uppercase tracking-wider">Features</div>

                            {Object.entries(FEATURE_CONFIG).map(([key, conf]) => {
                                const isOpen = openFeatures.includes(key);
                                const isActive = activeView === key;
                                const Icon = conf.icon;
                                return (
                                    <button
                                        key={key}
                                        onClick={() => {
                                            onOpenFeature(key);
                                            setIsDropdownOpen(false);
                                        }}
                                        disabled={isActive}
                                        className={cn(
                                            "w-full text-left px-3 py-1.5 text-xs flex items-center gap-2.5 transition-colors mx-1 rounded-md w-[calc(100%-8px)]",
                                            isActive ? "bg-app-accent/10 text-app-accent cursor-default" : "text-app-text hover:bg-app-surface"
                                        )}
                                    >
                                        <Icon size={14} className={cn("opacity-80", isActive && "opacity-100")} />
                                        <span className="flex-1 font-medium">{conf.label}</span>
                                        {isActive ? (
                                            <span className="text-[10px] opacity-70">Active</span>
                                        ) : isOpen ? (
                                            <span className="text-[10px] opacity-50">Open</span>
                                        ) : (
                                            <span className="text-[10px] text-app-muted/60 font-mono">{conf.shortcut}</span>
                                        )}
                                    </button>
                                );
                            })}
                        </div>
                    )}
                </div>
            </div>

            {contextMenu && (
                <ContextMenu
                    x={contextMenu.x}
                    y={contextMenu.y}
                    onClose={() => setContextMenu(null)}
                    items={[
                        {
                            label: pinnedFeatures.includes(contextMenu.feature) ? 'Unpin Tab' : 'Pin Tab',
                            action: () => onTogglePin(contextMenu.feature)
                        },
                        {
                            label: 'Close Tab',
                            variant: 'danger',
                            action: () => onFeatureClose(contextMenu.feature),
                            disabled: pinnedFeatures.includes(contextMenu.feature)
                        }
                    ]}
                />
            )}
        </div>
    );
}
