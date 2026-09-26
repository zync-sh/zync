import { useState, useRef, useEffect, useMemo, useCallback, memo, type DragEvent } from 'react';
import { useAppStore } from '../../store/useAppStore';
import { useShallow } from 'zustand/react/shallow';
import { cn } from '../../lib/utils';
import { pluginTabInventory } from './featureTabInventory';
import { FolderOpen, Plus, X, PanelRight, Terminal as TerminalIcon } from 'lucide-react';
import { ContextMenu, type ContextMenuItem } from '../ui/ContextMenu';
import { useWindowDrag } from '../../hooks/useWindowDrag';
import type { ShellEntry } from '../../lib/shells/types';
import { ShellIcon } from '../icons/ShellIcon';
import { PluginIcon } from '../icons/PluginIcon';
import { FEATURE_META, type FeatureId, type WorkspaceFeatureTab } from './featureMeta';
import { formatShortcutLabel } from '../../lib/shortcuts';
import { SHORTCUT_CATALOG } from '../../features/shortcuts/catalog';
import { defaultSettings } from '../../store/settingsSlice';
import { Tooltip } from '../ui/Tooltip';
import {
    collectLeaves,
    findLayoutOwner,
    findNode,
    isFeatureContent,
    isPaneLeaf,
    isPluginContent,
    isSplitFeatureId,
    isSplitLayout,
    layoutForCanvas,
    layoutHasFeature,
    layoutHasPlugin,
    paneDockPayload,
    sameSplitGroup,
    SPLIT_FEATURE_IDS,
    visibleTermIds,
    type DockEdge,
    type SplitDirection,
    type SplitFeatureId,
} from '../../lib/paneLayout';
import { WorkspaceOpenMenu } from './workspaceOpen';
import { splitOpenMenuItems, useDockTabPointer, type DockTabPointerHandlers } from './tabDock';
import { useInternalFileDrag } from '../../lib/dragDrop';
import { acceptFilePathDrag } from '../../lib/terminal/fileDropToTerminal';
import { pasteFilePathsIntoTerminal } from '../../lib/terminal/pasteFileDropToTerminal';


interface CombinedTabBarProps {
    connectionId: string;
    tabId: string;
    activeView: string;
    activeTerminalId: string | null;
    openFeatures: string[];
    featureTabs: WorkspaceFeatureTab[];
    activeFeatureTabId: string | null;
    pinnedFeatures: string[];
    pluginPanels?: { id: string; title: string }[];
    availableShells?: ShellEntry[];
    shellsLoading?: boolean;
    shellsError?: string | null;
    onRefetchShells?: () => void;
    onTabSelect: (view: string, termId?: string) => void;
    onFeatureClose: (feature: string) => void;
    onFeatureTabSelect: (tabId: string, featureId: FeatureId) => void;
    onFeatureTabClose: (tabId: string, featureId: FeatureId) => void;
    onTerminalClose: (termId: string) => void;
    onNewTerminal: (shell?: ShellEntry) => void;
    onOpenFeature?: (feature: string) => void;
    onTogglePin: (feature: string) => void;
    sessionToolsOpen?: boolean;
    onToggleSessionTools?: () => void;
    isSplit?: boolean;
    canSplit?: boolean;
    onSplit?: (direction: SplitDirection) => void;
    onUnsplit?: () => void;
    onSplitSelect?: (owner: string) => void;
    onSplitClose?: (owner: string, paneId: string) => void;
    onSplitUnsplit?: (owner: string, paneId: string) => void;
    onOpenSplitFeature?: (featureId: SplitFeatureId, edge?: DockEdge) => void;
    onOpenSplitPlugin?: (pluginId: string, edge?: DockEdge) => void;
    onDockTerm?: (termId: string, edge: DockEdge) => void;
    onSplitNewShell?: (edge: DockEdge, shell?: ShellEntry) => void;
    dockPointer?: DockTabPointerHandlers;
}

type ContextMenuTarget =
    | { type: 'split'; owner: string; paneId: string }
    | { type: 'terminal'; termId: string }
    | { type: 'feature'; featureId: FeatureId; tabId: string }
    | { type: 'plugin'; featureId: string };

const COMMON_SHELL_PATTERN = /(^|\/)(bash|zsh|fish|sh)$/i;
const COMMON_SHELL_LABEL_PATTERN = /\b(?:bash|zsh|fish|sh)\b/i;

function isCommonShellCandidate(shell: ShellEntry): boolean {
    return COMMON_SHELL_PATTERN.test(shell.id) || COMMON_SHELL_LABEL_PATTERN.test(shell.label);
}

function findPreferredShellId(shells: ShellEntry[]): string | undefined {
    return shells.find(isCommonShellCandidate)?.id ?? shells[0]?.id;
}

function SplitPaneIcon({
    direction,
    size = 15,
}: {
    direction: SplitDirection;
    size?: number;
}) {
    const stacked = direction === 'vertical';
    return (
        <svg
            width={size}
            height={size}
            viewBox="0 0 16 16"
            fill="none"
            aria-hidden
            className="shrink-0"
        >
            <rect x="2" y="2.5" width="12" height="11" rx="2" stroke="currentColor" strokeWidth="1.5" />
            {stacked ? (
                <path d="M2 8h12" stroke="currentColor" strokeWidth="1.5" />
            ) : (
                <path d="M8 2.5v11" stroke="currentColor" strokeWidth="1.5" />
            )}
        </svg>
    );
}

function normalizeTerminalTitle(title: string): string {
    const match = /^Terminal\s+(\d+)$/i.exec(title.trim());
    if (match) return `Shell ${match[1]}`;
    return title;
}

function getContextMenuItems(input: {
    target: ContextMenuTarget;
    pinnedFeatures: string[];
    onTerminalClose: (termId: string) => void;
    onFeatureClose: (feature: string) => void;
    onFeatureTabClose: (tabId: string, featureId: FeatureId) => void;
    onTogglePin: (feature: string) => void;
    onUnsplit?: () => void;
    onSplitClose?: (owner: string, paneId: string) => void;
    onSplitUnsplit?: (owner: string, paneId: string) => void;
    canUnsplitTab?: boolean;
    onOpenSplitFeature?: (featureId: SplitFeatureId, edge?: DockEdge) => void;
    onOpenSplitPlugin?: (pluginId: string, edge?: DockEdge) => void;
    onDockTerm?: (termId: string, edge: DockEdge) => void;
    canOpenSplit: boolean;
    isCurrentShellGroup: boolean;
}): ContextMenuItem[] {
    const { target } = input;
    if (target.type === 'split') {
        return [
            {
                label: 'Unsplit focused pane',
                action: () => input.onSplitUnsplit?.(target.owner, target.paneId),
                disabled: !input.onSplitUnsplit,
            },
        ];
    }
    if (target.type === 'terminal') {
        const items: ContextMenuItem[] = [];
        if (input.onDockTerm && !input.isCurrentShellGroup) {
            items.push(
                ...splitOpenMenuItems((edge) => input.onDockTerm!(target.termId, edge), !input.canOpenSplit),
                { separator: true },
            );
        }
        if (input.canUnsplitTab && input.onUnsplit) {
            items.push({
                label: 'Unsplit focused pane',
                action: input.onUnsplit,
            });
        }
        items.push({
            label: 'Close Tab',
            variant: 'danger' as const,
            action: () => input.onTerminalClose(target.termId),
        });
        return items;
    }
    if (target.type === 'plugin') {
        const items: ContextMenuItem[] = [];
        if (input.onOpenSplitPlugin) {
            items.push(
                ...splitOpenMenuItems(
                    (edge) => input.onOpenSplitPlugin!(target.featureId.slice('plugin:'.length), edge),
                    !input.canOpenSplit,
                ),
                { separator: true },
            );
        }
        items.push(
            {
                label: 'Close Tab',
                variant: 'danger' as const,
                action: () => input.onFeatureClose(target.featureId),
            },
        );
        return items;
    }

    const items: ContextMenuItem[] = [];
    if (input.onOpenSplitFeature && isSplitFeatureId(target.featureId)) {
        const featureId = target.featureId;
        items.push(
            ...splitOpenMenuItems((edge) => input.onOpenSplitFeature!(featureId, edge), !input.canOpenSplit),
            { separator: true },
        );
    }
    items.push(
        {
            label: input.pinnedFeatures.includes(target.featureId) ? 'Unpin Tab' : 'Pin Tab',
            action: () => input.onTogglePin(target.featureId),
        },
        {
            label: 'Close Tab',
            variant: 'danger' as const,
            action: () => input.onFeatureTabClose(target.tabId, target.featureId),
            disabled: target.tabId === `pinned:${target.featureId}`,
        },
    );
    return items;
}

export const CombinedTabBar = memo(function CombinedTabBar({
    connectionId,
    tabId,
    activeView,
    activeTerminalId,
    openFeatures,
    featureTabs,
    activeFeatureTabId,
    pinnedFeatures,
    pluginPanels = [],
    availableShells = [],
    shellsLoading = false,
    shellsError = null,
    onRefetchShells,
    onTabSelect,
    onFeatureClose,
    onFeatureTabSelect,
    onFeatureTabClose,
    onTerminalClose,
    onNewTerminal,
    onOpenFeature,
    onTogglePin,
    sessionToolsOpen = false,
    onToggleSessionTools,
    isSplit = false,
    canSplit = true,
    onSplit,
    onUnsplit,
    onSplitSelect,
    onSplitClose,
    onSplitUnsplit,
    onOpenSplitFeature,
    onOpenSplitPlugin,
    onDockTerm,
    onSplitNewShell,
    dockPointer,
}: CombinedTabBarProps) {
    const { begin: beginDockPointer, consumeClickIfDragged } = useDockTabPointer(dockPointer);
    const fileDragActive = useInternalFileDrag();
    const [fileDropTermId, setFileDropTermId] = useState<string | null>(null);
    const handleTermFileDragOver = useCallback((event: DragEvent<HTMLDivElement>, termId: string) => {
        if (!fileDragActive || !acceptFilePathDrag(event)) return;
        setFileDropTermId(termId);
    }, [fileDragActive]);
    const handleTermFileDrop = useCallback((event: DragEvent<HTMLDivElement>, termId: string) => {
        setFileDropTermId(null);
        if (!fileDragActive || !acceptFilePathDrag(event)) return;
        event.stopPropagation();
        onTabSelect('terminal', termId);
        pasteFilePathsIntoTerminal(termId, event.dataTransfer, connectionId);
    }, [connectionId, fileDragActive, onTabSelect]);
    const terminals = useAppStore(useShallow(state =>
        (state.terminals[connectionId] || []).filter(term => term.tabVisible !== false),
    ));
    const paneGroups = useAppStore(state => state.paneLayouts[connectionId]);
    const activePaneGroupOwner = useAppStore(state => state.activePaneGroupOwner[connectionId] ?? null);
    const splitBinding = useAppStore(state =>
        state.settings.keybindings?.splitPanes || defaultSettings.keybindings.splitPanes,
    );
    const stackedSplitBinding = SHORTCUT_CATALOG.find(command => command.id === 'splitPanes')
        ?.extraKeys?.find(chord => chord.endsWith('ArrowDown'))
        ?? 'Ctrl+Shift+ArrowDown';
    const canOpenFeature = Boolean(onOpenFeature);
    const splitLayout = layoutForCanvas(paneGroups, activeTerminalId, activePaneGroupOwner);
    const splitGroups = Object.entries(paneGroups ?? {})
        .filter((entry): entry is [string, NonNullable<typeof entry[1]>] => isSplitLayout(entry[1]));
    const allPaneLeaves = Object.values(paneGroups ?? {}).flatMap(layout => collectLeaves(layout.root));
    const groupedLeaves = splitGroups.flatMap(([, layout]) => collectLeaves(layout.root));
    const groupedTermIds = new Set(
        splitGroups.flatMap(([, layout]) => visibleTermIds(layout)),
    );
    const extraLeafFeatureIds = new Set(
        groupedLeaves.flatMap((leaf) => (isFeatureContent(leaf.content) ? [leaf.content.featureId] : [])),
    );
    const groupedFeatureInstanceIds = new Set(
        groupedLeaves.flatMap((leaf) => (
            isFeatureContent(leaf.content) && leaf.content.instanceId ? [leaf.content.instanceId] : []
        )),
    );
    const extraLeafPluginIds = new Set(
        groupedLeaves.flatMap((leaf) => (isPluginContent(leaf.content) ? [leaf.content.pluginId] : [])),
    );
    const filesInSplit = layoutHasFeature(splitLayout, 'files');
    const canOpenFilesSplit = filesInSplit || canSplit;
    const shellById = useMemo(
        () => new Map(availableShells.map(shell => [shell.id, shell] as const)),
        [availableShells],
    );
    const remoteFallbackShellId = useMemo(() => {
        if (connectionId === 'local') return undefined;
        return findPreferredShellId(availableShells);
    }, [availableShells, connectionId]);

    /**
     * Icon fallback when a tab has no shellOverride yet.
     * Must be stable (not live settings) so changing Default Shell does not rebrand open shells.
     */
    const localDisplayFallbackShellId = useMemo(() => {
        if (connectionId !== 'local') return undefined;
        const platform = window.electronUtils?.platform;
        if (platform === 'win32') return 'powershell';
        return availableShells[0]?.id;
    }, [availableShells, connectionId]);

    const resolveShell = useCallback((shellId?: string): ShellEntry | undefined => {
        let effectiveShellId = shellId;
        if (!effectiveShellId) {
            effectiveShellId = connectionId === 'local'
                ? localDisplayFallbackShellId
                : remoteFallbackShellId;
        }

        // Settings may store "default" — never resolve that to the *current* settings default.
        if (effectiveShellId === 'default') {
            effectiveShellId = connectionId === 'local'
                ? 'powershell'
                : remoteFallbackShellId;
        }

        if (!effectiveShellId) return undefined;
        if (shellById.has(effectiveShellId)) return shellById.get(effectiveShellId);

        // Fallback entry lets ShellIcon render CSS badge even if shell detection
        // has not resolved a concrete icon payload yet.
        return { id: effectiveShellId, label: effectiveShellId };
    }, [connectionId, localDisplayFallbackShellId, remoteFallbackShellId, shellById]);

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
            const inContextMenu = event.target instanceof Element
                && Boolean(event.target.closest('.context-menu-container, .context-menu-submenu-portal'));
            if (dropdownRef.current && !dropdownRef.current.contains(event.target as Node) && !inContextMenu) {
                setIsDropdownOpen(false);
            }
            // Close context menu if click outside
            if (contextMenu && !inContextMenu) {
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
    const terminalSplitOwners = terminals
        .map(term => term.id)
        .filter(termId => isSplitLayout(paneGroups?.[termId]));
    const terminalSplitOwnerSet = new Set(terminalSplitOwners);
    const pluginInventory = pluginTabInventory(openFeatures, pinnedFeatures, activeView);
    const featureAnchorOwnerByTabId = new Map<string, string>();
    const featureAnchorTabIdByOwner = new Map<string, string>();
    const pluginAnchorOwnerById = new Map<string, string>();
    const pluginAnchorIdByOwner = new Map<string, string>();
    const claimedFeatureTabs = new Set<string>();
    const claimedPlugins = new Set<string>();

    for (const [owner, layout] of splitGroups) {
        if (terminalSplitOwnerSet.has(owner)) continue;
        const leaves = collectLeaves(layout.root);
        const exactFeatureAnchor = featureTabs.find(featureTab => (
            !claimedFeatureTabs.has(featureTab.id)
            && leaves.some(leaf => (
                isFeatureContent(leaf.content)
                && leaf.content.featureId === featureTab.featureId
                && leaf.content.instanceId === featureTab.instanceId
            ))
        ));
        const featureAnchor = exactFeatureAnchor ?? featureTabs.find(featureTab => (
            !claimedFeatureTabs.has(featureTab.id)
            && leaves.some(leaf => (
                isFeatureContent(leaf.content)
                && leaf.content.featureId === featureTab.featureId
                && !leaf.content.instanceId
            ))
        ));
        if (featureAnchor) {
            claimedFeatureTabs.add(featureAnchor.id);
            featureAnchorOwnerByTabId.set(featureAnchor.id, owner);
            featureAnchorTabIdByOwner.set(owner, featureAnchor.id);
            continue;
        }
        const pluginAnchor = pluginInventory
            .map(featureId => featureId.slice('plugin:'.length))
            .find(pluginId => !claimedPlugins.has(pluginId) && layoutHasPlugin(layout, pluginId));
        if (pluginAnchor) {
            claimedPlugins.add(pluginAnchor);
            pluginAnchorOwnerById.set(pluginAnchor, owner);
            pluginAnchorIdByOwner.set(owner, pluginAnchor);
        }
    }
    const visibleFeatureTabs = featureTabs
        .filter((featureTab) => {
            if (featureAnchorOwnerByTabId.has(featureTab.id)) return true;
            if (groupedFeatureInstanceIds.has(featureTab.instanceId)) return false;
            if (extraLeafFeatureIds.has(featureTab.featureId) && !featureTab.instanceId) return false;
            return true;
        });
    const standaloneFeatureTabs = visibleFeatureTabs.filter((featureTab) => (
        !featureAnchorOwnerByTabId.has(featureTab.id)
    ));
    const standaloneFeatureCounts = standaloneFeatureTabs.reduce((counts, featureTab) => {
        counts.set(featureTab.featureId, (counts.get(featureTab.featureId) ?? 0) + 1);
        return counts;
    }, new Map<FeatureId, number>());
    const standaloneFeatureOrdinals = new Map<string, number>();
    const seenFeatureCounts = new Map<FeatureId, number>();
    for (const featureTab of standaloneFeatureTabs) {
        const ordinal = (seenFeatureCounts.get(featureTab.featureId) ?? 0) + 1;
        seenFeatureCounts.set(featureTab.featureId, ordinal);
        standaloneFeatureOrdinals.set(featureTab.id, ordinal);
    }
    const splitOwnerOrder = [
        ...terminalSplitOwners,
        ...splitGroups
            .map(([owner]) => owner)
            .filter(owner => !terminalSplitOwnerSet.has(owner)),
    ];
    const renderedSplitOwners = new Set([
        ...terminalSplitOwners,
        ...featureAnchorTabIdByOwner.keys(),
        ...pluginAnchorIdByOwner.keys(),
    ]);

    const renderSplitTab = (owner: string, layout: (typeof splitGroups)[number][1]) => {
        const splitIndex = splitOwnerOrder.indexOf(owner);
        const label = `Split ${splitIndex >= 0 ? splitIndex + 1 : 1}`;
        const isActive = splitLayout === layout
            || activePaneGroupOwner === owner;
        const activePane = findNode(layout.root, layout.activePaneId);
        const dockPayload = activePane && isPaneLeaf(activePane) ? paneDockPayload(activePane) : null;
        return (
            <Tooltip key={`split:${owner}`} content={label} position="bottom">
                <div
                    onPointerDown={(event) => {
                        if (dockPayload) beginDockPointer(event, dockPayload);
                    }}
                    onClick={() => {
                        if (consumeClickIfDragged()) return;
                        onSplitSelect?.(owner);
                    }}
                    onContextMenu={(event) => {
                        event.preventDefault();
                        event.stopPropagation();
                        setContextMenu({
                            x: event.clientX,
                            y: event.clientY,
                            target: { type: 'split', owner, paneId: layout.activePaneId },
                        });
                    }}
                    data-tauri-drag-region="false"
                    className={cn(
                        "flex items-center gap-2 px-3 py-1.5 h-7 text-xs font-medium rounded-md transition-colors duration-100 cursor-grab min-w-[100px] max-w-[200px] group border border-transparent drag-none shrink-0 active:scale-[0.98] active:cursor-grabbing",
                        isActive
                            ? "bg-app-surface text-app-text shadow-sm border-app-border/50"
                            : "text-app-muted hover:bg-app-surface/50 hover:text-app-text",
                    )}
                >
                    <span className={cn(isActive ? 'text-app-accent' : 'text-app-muted')}>
                        <SplitPaneIcon direction="horizontal" size={12} />
                    </span>
                    <span className="truncate flex-1">{label}</span>
                    <button
                        type="button"
                        onClick={(event) => {
                            event.stopPropagation();
                            onSplitClose?.(owner, layout.activePaneId);
                        }}
                        className={cn(
                            "p-0.5 rounded hover:bg-app-bg hover:text-red-400 transition-colors opacity-0 group-hover:opacity-100",
                            isActive && "opacity-100",
                        )}
                        aria-label={`Close ${label}`}
                        title="Close split"
                    >
                        <X size={12} />
                    </button>
                </div>
            </Tooltip>
        );
    };
    return (
        <div ref={dragRegionRef} className="flex items-center w-full bg-app-panel border-b border-app-border px-1 h-9 shrink-0 gap-1 select-none app-drag-region" data-tauri-drag-region>

            {/* Scrollable Tabs Wrapper - flex-initial to size to content, allow shrinking for scroll */}
            <div className="flex-initial min-w-0 flex overflow-x-auto scrollbar-hide h-full items-center gap-1 pr-1 app-drag-region" data-tauri-drag-region>

                {/* 1. Terminal inventory; a shell-owned split replaces its owner in place. */}
                {terminals.map(term => {
                    const ownedSplit = paneGroups?.[term.id];
                    if (ownedSplit && isSplitLayout(ownedSplit)) {
                        return renderSplitTab(term.id, ownedSplit);
                    }
                    if (groupedTermIds.has(term.id)) return null;
                    const splitOwner = activeTerminalId
                        ? findLayoutOwner(paneGroups, activeTerminalId)
                        : null;
                    const isActive = activeView === 'terminal'
                        && !activePaneGroupOwner
                        && (activeTerminalId === term.id || splitOwner === term.id);
                    const tabLabel = normalizeTerminalTitle(term.title);
                    // Prefer tab-stamped shell only. Do not fall back to live Default Shell settings.
                    const effectiveShellId = term.shellOverride
                        ?? (connectionId === 'local'
                            ? localDisplayFallbackShellId
                            : remoteFallbackShellId);
                    const shell = resolveShell(effectiveShellId);
                    return (
                        <Tooltip
                            key={term.id}
                            content={tabLabel}
                            position="bottom"
                        >
                            <div
                                onPointerDown={(event) => beginDockPointer(event, { kind: 'term', termId: term.id })}
                                onClick={() => {
                                    if (consumeClickIfDragged()) return;
                                    onTabSelect('terminal', term.id);
                                }}
                                onDragOver={(event) => handleTermFileDragOver(event, term.id)}
                                onDragLeave={(event) => {
                                    if (event.currentTarget.contains(event.relatedTarget as Node | null)) return;
                                    setFileDropTermId((current) => (current === term.id ? null : current));
                                }}
                                onDrop={(event) => handleTermFileDrop(event, term.id)}
                                onContextMenu={(e) => {
                                    e.preventDefault();
                                    e.stopPropagation();
                                    setContextMenu({ x: e.clientX, y: e.clientY, target: { type: 'terminal', termId: term.id } });
                                }}
                                data-tauri-drag-region="false"
                                className={cn(
                                    "flex items-center gap-2 px-3 py-1.5 h-7 text-xs font-medium rounded-md transition-colors duration-100 cursor-grab min-w-[100px] max-w-[200px] group border border-transparent drag-none shrink-0 active:scale-[0.98] active:cursor-grabbing",
                                    isActive
                                        ? "bg-app-surface text-app-text shadow-sm border-app-border/50"
                                        : "text-app-muted hover:bg-app-surface/50 hover:text-app-text",
                                    fileDragActive && fileDropTermId === term.id && "border-app-accent bg-app-accent/15 text-app-text",
                                )}
                            >
                                {shell ? (
                                    <ShellIcon shell={shell} size={12} />
                                ) : (
                                    <TerminalIcon size={12} className={cn(isActive ? "text-app-accent" : "text-app-muted")} />
                                )}
                                <span className="truncate flex-1">{tabLabel}</span>
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

                {/* Restored/legacy groups without a current inventory anchor. */}
                {splitGroups
                    .filter(([owner]) => !renderedSplitOwners.has(owner))
                    .map(([owner, layout]) => renderSplitTab(owner, layout))}

                {/* 2. Feature inventory; a feature-owned split replaces that feature in place. */}
                {visibleFeatureTabs.map(featureTab => {
                    const anchoredOwner = featureAnchorOwnerByTabId.get(featureTab.id);
                    const anchoredLayout = anchoredOwner ? paneGroups?.[anchoredOwner] : undefined;
                    if (anchoredOwner && anchoredLayout && isSplitLayout(anchoredLayout)) {
                        return renderSplitTab(anchoredOwner, anchoredLayout);
                    }
                    const featureId = featureTab.featureId;
                    const config = FEATURE_META[featureId];
                    const duplicateCount = standaloneFeatureCounts.get(featureId) ?? 0;
                    const tabLabel = duplicateCount > 1
                        ? `${config.label} ${standaloneFeatureOrdinals.get(featureTab.id) ?? 1}`
                        : config.label;
                    const isActive = activeView === featureId && activeFeatureTabId === featureTab.id;
                    const isPinned = pinnedFeatures.includes(featureId) && featureTab.id === `pinned:${featureId}`;
                    const Icon = config.icon;
                    const sourcePane = allPaneLeaves.find(leaf => (
                        isFeatureContent(leaf.content)
                        && leaf.content.featureId === featureId
                        && leaf.content.instanceId === featureTab.instanceId
                    ));

                    return (
                        <div
                            key={featureTab.id}
                            onPointerDown={(event) => {
                                if (!isSplitFeatureId(featureId)) return;
                                beginDockPointer(event, {
                                    kind: 'feature',
                                    featureId,
                                    instanceId: featureTab.instanceId,
                                    sourcePaneId: sourcePane?.id,
                                });
                            }}
                            onClick={() => {
                                if (consumeClickIfDragged()) return;
                                onFeatureTabSelect(featureTab.id, featureId);
                            }}
                            onContextMenu={(e) => {
                                e.preventDefault();
                                e.stopPropagation();
                                setContextMenu({ x: e.clientX, y: e.clientY, target: { type: 'feature', featureId, tabId: featureTab.id } });
                            }}
                            data-tauri-drag-region="false"
                            className={cn(
                                "flex items-center gap-2 px-3 py-1.5 h-7 text-xs font-medium rounded-md transition-colors duration-100 cursor-grab min-w-[90px] group border border-transparent relative drag-none shrink-0 active:scale-[0.98] active:cursor-grabbing",
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
                            <span className="truncate flex-1">{tabLabel}</span>

                            {/* Close Button (Hidden if Pinned) */}
                            {!isPinned && (
                                <button
                                    onClick={(e) => { e.stopPropagation(); onFeatureTabClose(featureTab.id, featureId); }}
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

                {/* 3. Plugin panel inventory */}
                {pluginInventory.map(featureId => {
                    const panelId = featureId.replace('plugin:', '');
                    const anchoredOwner = pluginAnchorOwnerById.get(panelId);
                    const anchoredLayout = anchoredOwner ? paneGroups?.[anchoredOwner] : undefined;
                    if (anchoredOwner && anchoredLayout && isSplitLayout(anchoredLayout)) {
                        return renderSplitTab(anchoredOwner, anchoredLayout);
                    }
                    if (extraLeafPluginIds.has(panelId)) return null;
                    const panel = pluginPanels.find(p => p.id === panelId) ?? { id: panelId, title: 'Plugin' };
                    const isActive = activeView === featureId;
                    return (
                        <div
                            key={featureId}
                            data-pane-id={`overlay:plugin:${panelId}`}
                            onPointerDown={(event) => beginDockPointer(event, { kind: 'plugin', pluginId: panelId })}
                            onClick={() => {
                                if (consumeClickIfDragged()) return;
                                onTabSelect(featureId);
                            }}
                            onContextMenu={(e) => {
                                e.preventDefault();
                                e.stopPropagation();
                                setContextMenu({ x: e.clientX, y: e.clientY, target: { type: 'plugin', featureId } });
                            }}
                            data-tauri-drag-region="false"
                            className={cn(
                                "flex items-center gap-2 px-3 py-1.5 h-7 text-xs font-medium rounded-md transition-colors duration-100 cursor-grab min-w-[90px] group border border-transparent relative drag-none shrink-0 active:scale-[0.98] active:cursor-grabbing",
                                isActive
                                    ? "bg-app-surface text-app-text shadow-sm border-app-border/50"
                                    : "text-app-muted hover:bg-app-surface/50 hover:text-app-text"
                            )}
                        >
                            <PluginIcon panelId={panelId} size={14} className={cn(isActive ? "text-app-accent" : "text-app-muted")} />
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

            <div
                className="relative flex items-center bg-app-surface/30 rounded-lg p-0.5 border border-app-border/30 drag-none shrink-0 ml-1"
                data-tauri-drag-region="false"
                ref={dropdownRef}
            >
                <Tooltip content="Open a tab" position="bottom">
                    <button
                        ref={dropdownButtonRef}
                        type="button"
                        aria-haspopup="dialog"
                        aria-expanded={isDropdownOpen}
                        aria-label="Open a tab"
                        onClick={() => {
                            const opening = !isDropdownOpen;
                            if (opening && dropdownButtonRef.current) {
                                const rect = dropdownButtonRef.current.getBoundingClientRect();
                                const spaceRight = window.innerWidth - rect.left;
                                setDropdownAlign(spaceRight >= 288 ? 'left' : 'right');
                            }
                            setIsDropdownOpen(opening);
                            if (opening && onRefetchShells) {
                                requestAnimationFrame(() => onRefetchShells());
                            }
                        }}
                        className={cn(
                            'h-6 w-7 flex items-center justify-center rounded transition-colors',
                            isDropdownOpen
                                ? 'bg-app-surface text-white'
                                : 'hover:bg-app-surface hover:text-white text-app-accent',
                        )}
                    >
                        <Plus size={14} strokeWidth={3} />
                    </button>
                </Tooltip>
                {isDropdownOpen && (
                    <WorkspaceOpenMenu
                        align={dropdownAlign}
                        shells={availableShells}
                        shellsLoading={shellsLoading}
                        shellsError={shellsError}
                        onRefetchShells={onRefetchShells}
                        canOpenFeature={canOpenFeature}
                        features={(Object.keys(FEATURE_META) as FeatureId[]).map((id) => ({
                            id,
                            isOpen: featureTabs.some(tab => tab.featureId === id),
                            isActive: activeView === id && featureTabs.some(tab => tab.id === activeFeatureTabId && tab.featureId === id),
                        }))}
                        plugins={pluginPanels.map(panel => ({
                            id: panel.id,
                            title: panel.title,
                            isOpen: pluginInventory.includes(`plugin:${panel.id}`),
                        }))}
                        onNewShell={onNewTerminal}
                        onOpenFeature={onOpenFeature}
                        onOpenPlugin={(pluginId) => onTabSelect(`plugin:${pluginId}`)}
                        splitFeatures={SPLIT_FEATURE_IDS.map((id) => {
                            const isOpen = layoutHasFeature(splitLayout, id);
                            return { id, isOpen, canOpen: isOpen || canSplit };
                        })}
                        onOpenSplitFeature={onOpenSplitFeature}
                        onOpenSplitPlugin={onOpenSplitPlugin}
                        onSplitNewShell={onSplitNewShell}
                        canSplitPane={canSplit}
                        onClose={(source) => {
                            setIsDropdownOpen(false);
                            if (source === 'keyboard') {
                                dropdownButtonRef.current?.focus();
                            }
                        }}
                    />
                )}
            </div>

            {(onSplit || onToggleSessionTools) && (
                <div
                    className="ml-auto flex items-center shrink-0 gap-1 pr-0.5 drag-none"
                    data-tauri-drag-region="false"
                >
                    {onSplit && (
                        <div className="flex items-center bg-app-surface/30 rounded-lg p-0.5 border border-app-border/30">
                            <Tooltip
                                content={`Split side by side (${formatShortcutLabel(splitBinding)})`}
                                position="bottom"
                            >
                                <button
                                    type="button"
                                    onClick={() => onSplit('horizontal')}
                                    disabled={!canSplit}
                                    aria-label="Split side by side"
                                    className={cn(
                                        'h-6 w-7 flex items-center justify-center rounded transition-colors',
                                        isSplit
                                            ? 'text-app-text'
                                            : 'text-app-muted hover:text-app-text hover:bg-app-surface',
                                        !canSplit && 'opacity-40 cursor-default hover:bg-transparent',
                                    )}
                                >
                                    <SplitPaneIcon direction="horizontal" />
                                </button>
                            </Tooltip>
                            <div className="w-px h-4 bg-app-border/50" />
                            <Tooltip
                                content={`Split stacked (${formatShortcutLabel(stackedSplitBinding)})`}
                                position="bottom"
                            >
                                <button
                                    type="button"
                                    onClick={() => onSplit('vertical')}
                                    disabled={!canSplit}
                                    aria-label="Split stacked"
                                    className={cn(
                                        'h-6 w-7 flex items-center justify-center rounded transition-colors',
                                        isSplit
                                            ? 'text-app-text'
                                            : 'text-app-muted hover:text-app-text hover:bg-app-surface',
                                        !canSplit && 'opacity-40 cursor-default hover:bg-transparent',
                                    )}
                                >
                                    <SplitPaneIcon direction="vertical" />
                                </button>
                            </Tooltip>
                            {onOpenSplitFeature && (
                                <>
                                    <div className="w-px h-4 bg-app-border/50" />
                                    <Tooltip
                                        content={
                                            filesInSplit
                                                ? 'Files in split'
                                                : canOpenFilesSplit
                                                    ? 'Open Files in split'
                                                    : 'Pane limit reached (4)'
                                        }
                                        position="bottom"
                                    >
                                        <button
                                            type="button"
                                            onClick={() => onOpenSplitFeature('files')}
                                            disabled={!canOpenFilesSplit}
                                            aria-label="Open Files in split"
                                            aria-pressed={filesInSplit}
                                            className={cn(
                                                'h-6 w-7 flex items-center justify-center rounded transition-colors',
                                                filesInSplit
                                                    ? 'text-app-text'
                                                    : 'text-app-muted hover:text-app-text hover:bg-app-surface',
                                                !canOpenFilesSplit && 'opacity-40 cursor-default hover:bg-transparent',
                                            )}
                                        >
                                            <FolderOpen size={14} />
                                        </button>
                                    </Tooltip>
                                </>
                            )}
                        </div>
                    )}
                    {onToggleSessionTools && (
                        <Tooltip
                            content={`Session tools (${formatShortcutLabel('Ctrl+Shift+S')})`}
                            position="bottom"
                        >
                            <button
                                type="button"
                                id={`session-tools-toggle-${tabId}`}
                                onClick={onToggleSessionTools}
                                aria-pressed={sessionToolsOpen}
                                aria-label="Toggle session tools"
                                className={cn(
                                    'h-7 w-7 flex items-center justify-center rounded-md border transition-colors',
                                    sessionToolsOpen
                                        ? 'bg-app-accent/20 text-app-text border-app-accent/40'
                                        : 'text-app-muted border-transparent hover:text-app-text hover:bg-app-surface hover:border-app-border/40',
                                )}
                            >
                                <PanelRight size={14} />
                            </button>
                        </Tooltip>
                    )}
                </div>
            )}

            {contextMenu && (
                <ContextMenu
                    x={contextMenu.x}
                    y={contextMenu.y}
                    onClose={() => setContextMenu(null)}
                    items={getContextMenuItems({
                        target: contextMenu.target,
                        pinnedFeatures,
                        onTerminalClose,
                        onFeatureClose,
                        onFeatureTabClose,
                        onTogglePin,
                        onUnsplit,
                        onSplitClose,
                        onSplitUnsplit,
                        canUnsplitTab: contextMenu.target.type === 'terminal'
                            && isSplit
                            && findLayoutOwner(paneGroups, activeTerminalId ?? '') === contextMenu.target.termId,
                        onOpenSplitFeature,
                        onOpenSplitPlugin,
                        onDockTerm,
                        canOpenSplit: contextMenu.target.type === 'feature' && isSplitFeatureId(contextMenu.target.featureId)
                            ? canSplit || layoutHasFeature(splitLayout, contextMenu.target.featureId)
                            : canSplit,
                        isCurrentShellGroup: contextMenu.target.type === 'terminal'
                            && activeTerminalId != null
                            && sameSplitGroup(paneGroups, activeTerminalId, contextMenu.target.termId),
                    })}
                />
            )}
        </div>
    );
});
