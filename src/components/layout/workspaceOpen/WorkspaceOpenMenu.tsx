import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion';
import { Braces, ChevronLeft, ChevronRight, FolderOpen, LayoutDashboard, Loader2, Plus, RotateCw, Search, Terminal as TerminalIcon, Waypoints } from 'lucide-react';
import { cn } from '../../../lib/utils';
import { ShellIcon } from '../../icons/ShellIcon';
import { PluginIcon } from '../../icons/PluginIcon';
import { TopbarDropdown } from '../../ui/TopbarDropdown';
import { FEATURE_META, formatFeatureShortcut, type FeatureId } from '../featureMeta';
import type { ShellEntry } from '../../../lib/shells/types';
import { buildWorkspaceOpenItems, WORKSPACE_OPEN_GROUP_LABEL } from './buildWorkspaceOpenItems';
import { groupWorkspaceOpenItems, visibleWorkspaceOpenItems, workspaceOpenEscapeAction } from './filterWorkspaceOpenItems';
import { isSplitFeatureId, type DockEdge, type SplitFeatureId } from '../../../lib/paneLayout';
import { ContextMenu } from '../../ui/ContextMenu';
import { splitOpenMenuItems } from '../tabDock';
import type {
    WorkspaceOpenCloseSource,
    WorkspaceOpenFeatureState,
    WorkspaceOpenItem,
    WorkspaceOpenPluginState,
    WorkspaceOpenSplitFeatureState,
    WorkspaceOpenView,
} from './types';

const FEATURE_ICON: Record<FeatureId, typeof FolderOpen> = {
    files: FolderOpen,
    'port-forwarding': Waypoints,
    dashboard: LayoutDashboard,
    snippets: Braces,
};

export function WorkspaceOpenMenu({
    align,
    shells,
    shellsLoading,
    shellsError,
    onRefetchShells,
    canOpenFeature,
    features,
    plugins,
    splitFeatures,
    onNewShell,
    onOpenFeature,
    onOpenPlugin,
    onOpenSplitFeature,
    onOpenSplitPlugin,
    onSplitNewShell,
    canSplitPane = true,
    onClose,
}: {
    align: 'left' | 'right';
    shells: readonly ShellEntry[];
    shellsLoading: boolean;
    shellsError: string | null;
    onRefetchShells?: () => void;
    canOpenFeature: boolean;
    features: readonly WorkspaceOpenFeatureState[];
    plugins?: readonly WorkspaceOpenPluginState[];
    splitFeatures?: readonly WorkspaceOpenSplitFeatureState[];
    onNewShell: (shell?: ShellEntry) => void;
    onOpenFeature?: (featureId: string) => void;
    onOpenPlugin?: (pluginId: string) => void;
    onOpenSplitFeature?: (featureId: SplitFeatureId, edge?: DockEdge) => void;
    onOpenSplitPlugin?: (pluginId: string, edge?: DockEdge) => void;
    onSplitNewShell?: (edge: DockEdge, shell?: ShellEntry) => void;
    canSplitPane?: boolean;
    onClose: (source?: WorkspaceOpenCloseSource) => void;
}) {
    const [query, setQuery] = useState('');
    const [view, setView] = useState<WorkspaceOpenView>('root');
    const [slideDir, setSlideDir] = useState(1);
    const [activeIndex, setActiveIndex] = useState(0);
    const [rowMenu, setRowMenu] = useState<{ x: number; y: number; item: WorkspaceOpenItem } | null>(null);
    const searchRef = useRef<HTMLInputElement>(null);
    const reduceMotion = useReducedMotion();

    const items = useMemo(
        () => buildWorkspaceOpenItems({ shells, canOpenFeature, features, plugins }),
        [shells, canOpenFeature, features, plugins],
    );
    const visible = useMemo(
        () => visibleWorkspaceOpenItems(items, query, view),
        [items, query, view],
    );
    const sections = useMemo(() => groupWorkspaceOpenItems(visible), [visible]);
    const listId = useId();
    const activeItem = visible.length > 0 ? visible[Math.min(activeIndex, visible.length - 1)] : undefined;
    const activeDescendantId = activeItem ? `${listId}-${view}-${activeItem.id}` : undefined;

    useEffect(() => {
        searchRef.current?.focus();
    }, []);

    useEffect(() => {
        setActiveIndex((index) => {
            if (visible.length === 0) return 0;
            return Math.min(index, visible.length - 1);
        });
    }, [visible.length]);

    useEffect(() => {
        if (!activeDescendantId) return;
        document.getElementById(activeDescendantId)?.scrollIntoView({ block: 'nearest' });
    }, [activeDescendantId]);

    const runItem = (item: WorkspaceOpenItem) => {
        if (item.disabled) return;
        if (item.kind === 'other-shells') {
            setQuery('');
            setActiveIndex(0);
            setSlideDir(1);
            setView('shells');
            return;
        }
        if (item.kind === 'new-shell') {
            onNewShell();
            onClose();
            return;
        }
        if (item.kind === 'shell' && item.shell) {
            onNewShell(item.shell);
            onClose();
            return;
        }
        if (item.kind === 'feature' && item.featureId && onOpenFeature) {
            onOpenFeature(item.featureId);
            onClose();
            return;
        }
        if (item.kind === 'plugin' && item.pluginId && onOpenPlugin) {
            onOpenPlugin(item.pluginId);
            onClose();
            return;
        }
        if (item.kind === 'split-feature' && isSplitFeatureId(item.featureId) && onOpenSplitFeature) {
            onOpenSplitFeature(item.featureId);
            onClose();
        }
    };

    const splitDisabledFor = (item: WorkspaceOpenItem): boolean => {
        if (item.kind === 'feature' || item.kind === 'split-feature') {
            if (!isSplitFeatureId(item.featureId)) return true;
            const state = splitFeatures?.find((feature) => feature.id === item.featureId);
            if (state) return !state.canOpen;
            return !canSplitPane;
        }
        if (item.kind === 'plugin') return !canSplitPane || !onOpenSplitPlugin;
        if (item.kind === 'new-shell' || item.kind === 'shell') {
            return !canSplitPane || !onSplitNewShell;
        }
        return true;
    };

    const runSplit = (item: WorkspaceOpenItem, edge: DockEdge) => {
        if (splitDisabledFor(item)) return;
        if ((item.kind === 'feature' || item.kind === 'split-feature') && isSplitFeatureId(item.featureId) && onOpenSplitFeature) {
            onOpenSplitFeature(item.featureId, edge);
            onClose();
            return;
        }
        if (item.kind === 'plugin' && item.pluginId && onOpenSplitPlugin) {
            onOpenSplitPlugin(item.pluginId, edge);
            onClose();
            return;
        }
        if (item.kind === 'new-shell' && onSplitNewShell) {
            onSplitNewShell(edge);
            onClose();
            return;
        }
        if (item.kind === 'shell' && onSplitNewShell) {
            onSplitNewShell(edge, item.shell);
            onClose();
        }
    };

    const openRowMenu = (item: WorkspaceOpenItem, event: { clientX: number; clientY: number; preventDefault: () => void }) => {
        if (item.kind === 'other-shells') return;
        if (item.kind === 'feature' && !isSplitFeatureId(item.featureId)) return;
        event.preventDefault();
        setRowMenu({ x: event.clientX, y: event.clientY, item });
    };

    const goBack = () => {
        setQuery('');
        setActiveIndex(0);
        setSlideDir(-1);
        setView('root');
    };

    const onMenuKeyDownCapture = (event: KeyboardEvent<HTMLDivElement>) => {
        if (event.key !== 'Escape') return;
        event.preventDefault();
        event.stopPropagation();
        if (workspaceOpenEscapeAction(view) === 'back') {
            goBack();
            return;
        }
        onClose('keyboard');
    };

    const onSearchKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
        if (event.key === 'ArrowDown') {
            event.preventDefault();
            if (visible.length === 0) return;
            setActiveIndex((index) => (index + 1) % visible.length);
            return;
        }
        if (event.key === 'ArrowUp') {
            event.preventDefault();
            if (visible.length === 0) return;
            setActiveIndex((index) => (index - 1 + visible.length) % visible.length);
            return;
        }
        if (event.key === 'Enter') {
            event.preventDefault();
            const item = visible[activeIndex];
            if (item) runItem(item);
        }
    };

    let rowIndex = -1;

    return (
        <>
        <TopbarDropdown
            widthClass="w-72"
            align={align}
            className="p-0 flex flex-col shadow-xl"
            role="dialog"
            aria-label="Open a workspace tab"
            onKeyDownCapture={onMenuKeyDownCapture}
        >
            <div className="flex items-center gap-2 px-2.5 py-2 border-b border-app-border/60">
                {view === 'shells' ? (
                    <button
                        type="button"
                        onClick={goBack}
                        className="h-5 w-5 inline-flex items-center justify-center rounded text-app-muted hover:bg-app-surface hover:text-app-text"
                        aria-label="Back"
                    >
                        <ChevronLeft size={14} />
                    </button>
                ) : (
                    <Search size={13} className="text-app-muted shrink-0" />
                )}
                <input
                    ref={searchRef}
                    value={query}
                    onChange={(event) => {
                        setQuery(event.target.value);
                        setActiveIndex(0);
                    }}
                    onKeyDown={onSearchKeyDown}
                    placeholder={view === 'shells' ? 'Search shells…' : 'Open a tab…'}
                    className="flex-1 min-w-0 bg-transparent text-xs text-app-text placeholder:text-app-muted/50 outline-none"
                    role="combobox"
                    aria-expanded
                    aria-controls={listId}
                    aria-activedescendant={activeDescendantId}
                    aria-autocomplete="list"
                    aria-label={view === 'shells' ? 'Filter shells' : 'Filter tabs'}
                />
            </div>

            <div className="relative max-h-72 overflow-hidden">
                <AnimatePresence mode="wait" initial={false}>
                    <motion.div
                        key={view}
                        id={listId}
                        role="listbox"
                        aria-label={view === 'shells' ? 'Shells' : 'Workspace tabs'}
                        className="max-h-72 overflow-y-auto py-1"
                        initial={reduceMotion ? false : { opacity: 0, x: slideDir * 14 }}
                        animate={{ opacity: 1, x: 0 }}
                        exit={reduceMotion ? { opacity: 1, x: 0 } : { opacity: 0, x: slideDir * -14 }}
                        transition={{ duration: 0.16, ease: [0.22, 1, 0.36, 1] }}
                    >
                        {sections.map((section) => (
                            <div key={section.group} className="px-1 pb-1">
                                <div className="px-2.5 py-1 text-[10px] font-bold text-app-muted uppercase tracking-wider flex items-center gap-1.5">
                                    <span>{WORKSPACE_OPEN_GROUP_LABEL[section.group]}</span>
                                    {section.group === 'shells' && onRefetchShells && (
                                        <button
                                            type="button"
                                            onClick={(event) => {
                                                event.preventDefault();
                                                event.stopPropagation();
                                                onRefetchShells();
                                            }}
                                            disabled={shellsLoading}
                                            className={cn(
                                                'h-5 w-5 inline-flex items-center justify-center rounded text-app-muted transition-colors',
                                                shellsLoading
                                                    ? 'cursor-wait opacity-70'
                                                    : 'hover:bg-app-surface hover:text-app-text',
                                            )}
                                            title="Reload shells"
                                            aria-label="Reload shells"
                                        >
                                            <RotateCw size={11} className={cn(shellsLoading && 'animate-spin')} />
                                        </button>
                                    )}
                                </div>
                                {section.items.map((item) => {
                                    rowIndex += 1;
                                    const index = rowIndex;
                                    const active = index === activeIndex;
                                    return (
                                        <WorkspaceOpenRow
                                            key={item.id}
                                            id={`${listId}-${view}-${item.id}`}
                                            item={item}
                                            active={active}
                                            onHover={() => setActiveIndex(index)}
                                            onSelect={() => runItem(item)}
                                            onContextMenu={(event) => openRowMenu(item, event)}
                                        />
                                    );
                                })}
                            </div>
                        ))}

                        {visible.length === 0 && (
                            <div className="px-3 py-4 text-xs text-app-muted">No matching tabs</div>
                        )}

                        {shells.length === 0 && shellsLoading && (
                            <div className="h-7 px-3 text-xs flex items-center gap-2.5 text-app-muted">
                                <Loader2 size={12} className="animate-spin" />
                                <span>Loading shells…</span>
                            </div>
                        )}
                        {shells.length === 0 && !shellsLoading && shellsError && (
                            <div className="min-h-7 px-3 py-1 text-xs flex items-center gap-2.5 text-app-muted" title={shellsError}>
                                <TerminalIcon size={12} className="opacity-60" />
                                <span className="truncate">Couldn’t load shells</span>
                            </div>
                        )}
                    </motion.div>
                </AnimatePresence>
            </div>
        </TopbarDropdown>
            {rowMenu && (
                <ContextMenu
                    x={rowMenu.x}
                    y={rowMenu.y}
                    onClose={() => setRowMenu(null)}
                    items={splitOpenMenuItems(
                        (edge) => runSplit(rowMenu.item, edge),
                        splitDisabledFor(rowMenu.item),
                    )}
                />
            )}
        </>
    );
}

function WorkspaceOpenRow({
    id,
    item,
    active,
    onHover,
    onSelect,
    onContextMenu,
}: {
    id: string;
    item: WorkspaceOpenItem;
    active: boolean;
    onHover: () => void;
    onSelect: () => void;
    onContextMenu?: (event: { clientX: number; clientY: number; preventDefault: () => void }) => void;
}) {
    return (
        <button
            type="button"
            id={id}
            role="option"
            aria-selected={active}
            aria-disabled={item.disabled || undefined}
            onMouseEnter={onHover}
            onClick={() => {
                if (item.disabled) return;
                onSelect();
            }}
            onContextMenu={(event) => {
                event.preventDefault();
                event.stopPropagation();
                onContextMenu?.(event);
            }}
            className={cn(
                'w-full h-7 text-left px-2.5 text-xs flex items-center gap-2.5 rounded-md transition-colors',
                item.disabled
                    ? 'bg-app-accent/10 text-app-accent cursor-default'
                    : active
                        ? 'bg-app-surface text-app-text'
                        : 'text-app-text hover:bg-app-surface',
            )}
        >
            <span className="inline-flex h-5 w-5 items-center justify-center shrink-0 text-app-muted">
                <WorkspaceOpenIcon item={item} />
            </span>
            <span className="flex-1 truncate font-medium">{item.label}</span>
            {item.kind === 'feature' && item.featureId && (
                <span className="text-[10px] text-app-muted/70 shrink-0">
                    {item.hint ?? formatFeatureShortcut(FEATURE_META[item.featureId].keys)}
                </span>
            )}
            {item.kind === 'other-shells' && (
                <span className="inline-flex items-center gap-1 text-[10px] text-app-muted shrink-0">
                    {item.hint}
                    <ChevronRight size={12} />
                </span>
            )}
            {item.hint && item.kind !== 'feature' && item.kind !== 'other-shells' && (
                <span className="text-[10px] opacity-70">{item.hint}</span>
            )}
        </button>
    );
}

function WorkspaceOpenIcon({ item }: { item: WorkspaceOpenItem }): ReactNode {
    if (item.kind === 'new-shell') return <Plus size={12} />;
    if (item.kind === 'other-shells') return <TerminalIcon size={12} />;
    if (item.kind === 'shell' && item.shell) return <ShellIcon shell={item.shell} size={12} />;
    if ((item.kind === 'feature' || item.kind === 'split-feature') && item.featureId) {
        const Icon = FEATURE_ICON[item.featureId];
        return <Icon size={12} />;
    }
    if (item.kind === 'plugin' && item.pluginId) return <PluginIcon panelId={item.pluginId} size={14} />;
    return <TerminalIcon size={12} />;
}
