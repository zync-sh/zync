import { FolderOpen, PanelRight, Pin, Search, Terminal as TerminalIcon, X } from 'lucide-react';
import {
    type DragEvent,
    memo,
    type ReactNode,
    useCallback,
    useEffect,
    useId,
    useMemo,
    useRef,
    useState,
} from 'react';
import { useShallow } from 'zustand/react/shallow';

import { SHORTCUT_CATALOG } from '../../features/shortcuts/catalog';
import { shortcutHint } from '../../features/shortcuts/labels';
import { deriveWorkspaceContentInventory } from '../../features/workspace/domain/contentInventory';
import { parseWorkspaceDocking } from '../../features/workspace/domain/docking';
import { createWorkspaceSplitControlsSelector } from '../../features/workspace/domain/dockingView';
import { describeDockedTab } from '../../features/workspace/domain/dockPresentation';
import { resolveWorkspaceNavigation } from '../../features/workspace/domain/navigation';
import { resolveDisplayTitle } from '../../features/workspace/domain/presentation';
import { canCreateFeatureInWorkspace } from '../../features/workspace/domain/registrations';
import { projectWorkspaceTabs } from '../../features/workspace/domain/tabPresentation';
import { useInternalFileDrag } from '../../lib/dragDrop';
import {
    collectLeaves,
    type DockEdge,
    findLayoutOwner,
    findNode,
    isFeatureContent,
    isPaneLeaf,
    isPluginContent,
    isSplitFeatureId,
    isSplitLayout,
    isTermContent,
    layoutForCanvas,
    layoutHasFeature,
    paneContentKey,
    paneDockPayload,
    projectVisiblePaneLayout,
    SPLIT_FEATURE_IDS,
    type SplitDirection,
    type SplitFeatureId,
    sameSplitGroup,
    visibleTermIds,
} from '../../lib/paneLayout';
import type { ShellEntry } from '../../lib/shells/types';
import { formatShortcutLabel } from '../../lib/shortcuts';
import { LOCAL_TERMINAL_CONNECTION_ID } from '../../lib/terminal/connectionIds';
import { acceptFilePathDrag } from '../../lib/terminal/fileDropToTerminal';
import { pasteFilePathsIntoTerminal } from '../../lib/terminal/pasteFileDropToTerminal';
import { terminalCache } from '../../lib/terminal/terminalCache';
import { openTerminalFind } from '../../lib/terminal/terminalInteraction';
import { cn } from '../../lib/utils';
import { defaultSettings } from '../../store/settingsSlice';
import { useAppStore } from '../../store/useAppStore';
import { PluginIcon } from '../icons/PluginIcon';
import { ShellIcon } from '../icons/ShellIcon';
import { ContextMenu, type ContextMenuItem } from '../ui/ContextMenu';
import { isInsideMenu } from '../ui/MenuSubmenu';
import { Tooltip } from '../ui/Tooltip';
import { useWorkspaceContextActions } from '../workspace/workspaceActionsContext';
import { ChromeActionItems } from './ChromeActionItems';
import { ContentTabTrigger } from './ContentTabTrigger';
import { FEATURE_META, type FeatureId, type WorkspaceFeatureTab } from './featureMeta';
import { WorkspaceStripHandle } from './navigation/WorkspaceStripHandle';
import { describePaneGroup, PaneGroupTabIcon } from './PaneGroupTabChrome';
import { TabAddButton } from './TabAddButton';
import {
    COMPACT_TAB_LABEL_CLASSES,
    COMPACT_TAB_ROW_CLASSES,
    TabDragPreview,
} from './TabDragPreview';
import { type DockTabPointerHandlers, splitOpenMenuItems, useDockTabPointer } from './tabDock';
import { useChromeCustomizationMenu } from './useChromeCustomizationMenu';
import { WorkspaceOpenMenu } from './workspaceOpen';

interface CombinedTabBarProps {
    connectionId: string;
    tabId: string;
    activeView: string;
    activeTerminalId: string | null;
    featureTabs: WorkspaceFeatureTab[];
    activeFeatureTabId: string | null;
    pinnedFeatures: string[];
    pluginPanels?: { id: string; title: string; allowMultiple: boolean }[];
    contentActions?: ReactNode;
    availableShells?: ShellEntry[];
    shellsLoading?: boolean;
    shellsError?: string | null;
    onRefetchShells?: () => void;
    onTabSelect: (view: string, termId?: string) => void;
    onPluginTabSelect: (contentId: string) => void;
    onPluginTabClose: (contentId: string) => void;
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
    /** Close the canonical group, including hidden members; the app owns close guards. */
    onPaneGroupClose?: (owner: string) => void;
    onSplitUnsplit?: (owner: string, paneId: string) => void;
    onOpenSplitFeature?: (featureId: SplitFeatureId, edge?: DockEdge) => void;
    onOpenSplitPlugin?: (pluginId: string, edge?: DockEdge, contentId?: string) => void;
    onDockTerm?: (termId: string, edge: DockEdge) => void;
    onSplitNewShell?: (edge: DockEdge, shell?: ShellEntry) => void;
    dockPointer?: DockTabPointerHandlers;
}

type ContextMenuTarget =
    | { type: 'split'; owner: string; paneId: string }
    | { type: 'terminal'; termId: string }
    | { type: 'feature'; featureId: FeatureId; tabId: string }
    | { type: 'plugin'; panelId: string; contentId: string };

const COMMON_SHELL_PATTERN = /(^|\/)(bash|zsh|fish|sh)$/i;
const COMMON_SHELL_LABEL_PATTERN = /\b(?:bash|zsh|fish|sh)\b/i;

function isCommonShellCandidate(shell: ShellEntry): boolean {
    return COMMON_SHELL_PATTERN.test(shell.id) || COMMON_SHELL_LABEL_PATTERN.test(shell.label);
}

function findPreferredShellId(shells: ShellEntry[]): string | undefined {
    return shells.find(isCommonShellCandidate)?.id ?? shells[0]?.id;
}

function SplitPaneIcon({ direction, size = 15 }: { direction: SplitDirection; size?: number }) {
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
            <rect
                x="2"
                y="2.5"
                width="12"
                height="11"
                rx="2"
                stroke="currentColor"
                strokeWidth="1.5"
            />
            {stacked ? (
                <path
                    d="M2 8h12"
                    stroke="currentColor"
                    strokeWidth="1.5"
                />
            ) : (
                <path
                    d="M8 2.5v11"
                    stroke="currentColor"
                    strokeWidth="1.5"
                />
            )}
        </svg>
    );
}

function normalizeTerminalTitle(title: string): string {
    const match = /^Terminal\s+(\d+)$/i.exec(title.trim());
    if (match) {
        return `Shell ${match[1]}`;
    }
    return title;
}

function ContentPinIndicator() {
    return (
        <span
            className="inline-flex shrink-0 text-app-accent"
            title="Pinned content"
        >
            <Pin
                size={10}
                aria-hidden="true"
            />
            <span className="sr-only">Pinned content</span>
        </span>
    );
}

function getContextMenuItems(input: {
    target: ContextMenuTarget;
    pinnedFeatures: string[];
    onTerminalClose: (termId: string) => void;
    onPluginTabClose: (contentId: string) => void;
    onFeatureTabClose: (tabId: string, featureId: FeatureId) => void;
    onTogglePin: (feature: string) => void;
    onUnsplit?: () => void;
    onSplitUnsplit?: (owner: string, paneId: string) => void;
    canUnsplitTab?: boolean;
    onOpenSplitFeature?: (featureId: SplitFeatureId, edge?: DockEdge) => void;
    onOpenSplitPlugin?: (pluginId: string, edge?: DockEdge, contentId?: string) => void;
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
                ...splitOpenMenuItems(
                    (edge) => input.onDockTerm!(target.termId, edge),
                    !input.canOpenSplit,
                ),
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
                    (edge) => input.onOpenSplitPlugin!(target.panelId, edge, target.contentId),
                    !input.canOpenSplit,
                ),
                { separator: true },
            );
        }
        items.push({
            label: 'Close Tab',
            variant: 'danger' as const,
            action: () => input.onPluginTabClose(target.contentId),
        });
        return items;
    }

    const items: ContextMenuItem[] = [];
    if (input.onOpenSplitFeature && isSplitFeatureId(target.featureId)) {
        const featureId = target.featureId;
        items.push(
            ...splitOpenMenuItems(
                (edge) => input.onOpenSplitFeature!(featureId, edge),
                !input.canOpenSplit,
            ),
            { separator: true },
        );
    }
    items.push(
        {
            label: input.pinnedFeatures.includes(target.featureId)
                ? 'Stop opening with connection'
                : 'Open with connection',
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
    featureTabs,
    activeFeatureTabId,
    pinnedFeatures,
    pluginPanels = [],
    contentActions,
    availableShells = [],
    shellsLoading = false,
    shellsError = null,
    onRefetchShells,
    onTabSelect,
    onPluginTabSelect,
    onPluginTabClose,
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
    onPaneGroupClose,
    onSplitUnsplit,
    onOpenSplitFeature,
    onOpenSplitPlugin,
    onDockTerm,
    onSplitNewShell,
    dockPointer,
}: CombinedTabBarProps) {
    const navigationRaw = useAppStore((state) => state.settings.workspaceNavigation);
    const navigationPosition =
        resolveWorkspaceNavigation(navigationRaw).workspaceTabsPosition ?? 'default';
    const vertical = navigationPosition !== 'default';
    const openMenuId = useId();
    const workspaceActions = useWorkspaceContextActions();
    const { begin: beginDockPointer, consumeClickIfDragged } = useDockTabPointer(
        dockPointer && {
            ...dockPointer,
            onTabReorder: (source, target, after) => {
                const store = useAppStore.getState();
                const changed = store.reorderContent(connectionId, source, target, after);
                if (!changed) {
                    store.showToast(
                        'info',
                        'Keep pinned tabs together. This tab cannot move to that position now.',
                    );
                }
                return changed;
            },
        },
    );
    const fileDragActive = useInternalFileDrag();
    const [fileDropTermId, setFileDropTermId] = useState<string | null>(null);
    const handleTermFileDragOver = useCallback(
        (event: DragEvent<HTMLDivElement>, termId: string) => {
            if (!fileDragActive || !acceptFilePathDrag(event)) {
                return;
            }
            setFileDropTermId(termId);
        },
        [fileDragActive],
    );
    const handleTermFileDrop = useCallback(
        (event: DragEvent<HTMLDivElement>, termId: string) => {
            setFileDropTermId(null);
            if (!fileDragActive || !acceptFilePathDrag(event)) {
                return;
            }
            event.stopPropagation();
            onTabSelect('terminal', termId);
            pasteFilePathsIntoTerminal(termId, event.dataTransfer, connectionId);
        },
        [connectionId, fileDragActive, onTabSelect],
    );
    const terminals = useAppStore(
        useShallow((state) =>
            (state.terminals[connectionId] || []).filter((term) => term.tabVisible !== false),
        ),
    );
    const allTerminals = useAppStore((state) => state.terminals[connectionId]);
    const paneGroups = useAppStore((state) => state.paneLayouts[connectionId]);
    const presentationScope = useAppStore((state) => state.contentPresentation[connectionId]);
    const dockingRaw = useAppStore((state) => state.workspaceDocking);
    const dockFocus = useAppStore((state) => state.workspaceDockFocus[connectionId]);
    const docking = useMemo(() => parseWorkspaceDocking(dockingRaw), [dockingRaw]);
    const chromeActions = useAppStore((state) => state.settings.chromeActions);
    const toolbarMenu = useChromeCustomizationMenu('workspaceToolbar');
    const contentPresentation = presentationScope?.items;
    const hiddenContent = useMemo(
        () =>
            new Set(
                Object.entries(contentPresentation ?? {})
                    .filter(([, item]) => item.hidden)
                    .map(([id]) => id),
            ),
        [contentPresentation],
    );
    const dockFor = (ids: readonly string[]) =>
        describeDockedTab(
            ids.filter((id) => !hiddenContent.has(id)),
            docking.ok ? (docking.value[connectionId]?.placements ?? {}) : {},
            dockFocus,
        );
    const activePaneGroupOwner = useAppStore(
        (state) => state.activePaneGroupOwner[connectionId] ?? null,
    );
    const splitBinding = useAppStore(
        (state) => state.settings.keybindings?.splitPanes ?? defaultSettings.keybindings.splitPanes,
    );
    const sessionToolsHint = useAppStore((state) =>
        shortcutHint('snippetsFeature', state.settings.keybindings ?? {}),
    );
    const stackedSplitBinding = splitBinding
        ? (SHORTCUT_CATALOG.find((command) => command.id === 'splitPanes')?.extraKeys?.find(
              (chord) => chord.endsWith('ArrowDown'),
          ) ?? 'Ctrl+Shift+ArrowDown')
        : '';
    const canOpenFeature = Boolean(onOpenFeature);
    const workspaceScope = connectionId === LOCAL_TERMINAL_CONNECTION_ID ? 'local' : 'remote';
    const splitLayout = layoutForCanvas(paneGroups, activeTerminalId, activePaneGroupOwner);
    const selectSplitControls = useMemo(
        () =>
            createWorkspaceSplitControlsSelector(connectionId, {
                featureId: isSplitFeatureId(activeView) ? activeView : undefined,
                featureInstanceId: isSplitFeatureId(activeView)
                    ? featureTabs.find((tab) => tab.id === activeFeatureTabId)?.instanceId
                    : undefined,
                pluginPanelId: activeView.startsWith('plugin:')
                    ? activeView.slice('plugin:'.length)
                    : undefined,
            }),
        [connectionId, activeView, featureTabs, activeFeatureTabId],
    );
    const findTerminalId = useAppStore(selectSplitControls).terminalId;
    const splitGroups = Object.entries(paneGroups ?? {}).filter(
        (entry): entry is [string, NonNullable<(typeof entry)[1]>] => isSplitLayout(entry[1]),
    );
    const allPaneLeaves = Object.values(paneGroups ?? {}).flatMap((layout) =>
        collectLeaves(layout.root),
    );
    const groupedLeaves = splitGroups.flatMap(([, layout]) => collectLeaves(layout.root));
    const groupedTermIds = new Set(splitGroups.flatMap(([, layout]) => visibleTermIds(layout)));
    const extraLeafFeatureIds = new Set(
        groupedLeaves.flatMap((leaf) =>
            isFeatureContent(leaf.content) ? [leaf.content.featureId] : [],
        ),
    );
    const groupedFeatureInstanceIds = new Set(
        groupedLeaves.flatMap((leaf) =>
            isFeatureContent(leaf.content) && leaf.content.instanceId
                ? [leaf.content.instanceId]
                : [],
        ),
    );
    const filesInSplit = layoutHasFeature(splitLayout, 'files');
    const canOpenFilesSplit = filesInSplit || canSplit;
    const shellById = useMemo(
        () => new Map(availableShells.map((shell) => [shell.id, shell] as const)),
        [availableShells],
    );
    const remoteFallbackShellId = useMemo(() => {
        if (connectionId === 'local') {
            return undefined;
        }
        return findPreferredShellId(availableShells);
    }, [availableShells, connectionId]);

    /**
     * Icon fallback when a tab has no shellOverride yet.
     * Must be stable (not live settings) so changing Default Shell does not rebrand open shells.
     */
    const localDisplayFallbackShellId = useMemo(() => {
        if (connectionId !== 'local') {
            return undefined;
        }
        const platform = window.electronUtils?.platform;
        if (platform === 'win32') {
            return 'powershell';
        }
        return availableShells[0]?.id;
    }, [availableShells, connectionId]);

    const resolveShell = useCallback(
        (shellId?: string): ShellEntry | undefined => {
            let effectiveShellId = shellId;
            if (!effectiveShellId) {
                effectiveShellId =
                    connectionId === 'local' ? localDisplayFallbackShellId : remoteFallbackShellId;
            }

            // Settings may store "default" — never resolve that to the *current* settings default.
            if (effectiveShellId === 'default') {
                effectiveShellId = connectionId === 'local' ? 'powershell' : remoteFallbackShellId;
            }

            if (!effectiveShellId) {
                return undefined;
            }
            if (shellById.has(effectiveShellId)) {
                return shellById.get(effectiveShellId);
            }

            // Fallback entry lets ShellIcon render CSS badge even if shell detection
            // has not resolved a concrete icon payload yet.
            return { id: effectiveShellId, label: effectiveShellId };
        },
        [connectionId, localDisplayFallbackShellId, remoteFallbackShellId, shellById],
    );

    // Dropdown State
    const [isDropdownOpen, setIsDropdownOpen] = useState(false);
    // A placement change invalidates the popup anchor geometry, not the live pane content.
    useEffect(() => {
        setIsDropdownOpen(false);
    }, [navigationPosition]);
    const [dropdownAlign, setDropdownAlign] = useState<'left' | 'right'>('left');
    const dropdownRef = useRef<HTMLDivElement>(null);
    const dropdownButtonRef = useRef<HTMLButtonElement>(null);
    const [contextMenu, setContextMenu] = useState<{
        x: number;
        y: number;
        target: ContextMenuTarget;
    } | null>(null);

    useEffect(() => {
        const handleClickOutside = (event: MouseEvent) => {
            const inContextMenu =
                event.target instanceof Element &&
                Boolean(
                    event.target.closest('.context-menu-container, .context-menu-submenu-portal'),
                );
            if (
                dropdownRef.current &&
                !isInsideMenu(dropdownRef.current, event.target) &&
                !inContextMenu
            ) {
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
        .map((term) => term.id)
        .filter((termId) => isSplitLayout(paneGroups?.[termId]));
    const terminalSplitOwnerSet = new Set(terminalSplitOwners);
    const pluginInventory = deriveWorkspaceContentInventory([], paneGroups).filter((item) =>
        isPluginContent(item.content),
    );
    const featureAnchorOwnerByTabId = new Map<string, string>();
    const featureAnchorTabIdByOwner = new Map<string, string>();
    const pluginAnchorOwnerById = new Map<string, string>();
    const pluginAnchorIdByOwner = new Map<string, string>();
    const claimedFeatureTabs = new Set<string>();
    const claimedPlugins = new Set<string>();

    for (const [owner, layout] of splitGroups) {
        if (terminalSplitOwnerSet.has(owner)) {
            continue;
        }
        const leaves = collectLeaves(layout.root);
        const exactFeatureAnchor = featureTabs.find(
            (featureTab) =>
                !claimedFeatureTabs.has(featureTab.id) &&
                leaves.some(
                    (leaf) =>
                        isFeatureContent(leaf.content) &&
                        leaf.content.featureId === featureTab.featureId &&
                        leaf.content.instanceId === featureTab.instanceId,
                ),
        );
        const featureAnchor =
            exactFeatureAnchor ??
            featureTabs.find(
                (featureTab) =>
                    !claimedFeatureTabs.has(featureTab.id) &&
                    leaves.some(
                        (leaf) =>
                            isFeatureContent(leaf.content) &&
                            leaf.content.featureId === featureTab.featureId &&
                            !leaf.content.instanceId,
                    ),
            );
        if (featureAnchor) {
            claimedFeatureTabs.add(featureAnchor.id);
            featureAnchorOwnerByTabId.set(featureAnchor.id, owner);
            featureAnchorTabIdByOwner.set(owner, featureAnchor.id);
            continue;
        }
        const pluginAnchor = pluginInventory.find(
            (item) => !claimedPlugins.has(item.id) && item.owner === owner,
        );
        if (pluginAnchor) {
            claimedPlugins.add(pluginAnchor.id);
            pluginAnchorOwnerById.set(pluginAnchor.id, owner);
            pluginAnchorIdByOwner.set(owner, pluginAnchor.id);
        }
    }
    const visibleFeatureTabs = featureTabs.filter((featureTab) => {
        if (featureAnchorOwnerByTabId.has(featureTab.id)) {
            return true;
        }
        if (groupedFeatureInstanceIds.has(featureTab.instanceId)) {
            return false;
        }
        if (extraLeafFeatureIds.has(featureTab.featureId) && !featureTab.instanceId) {
            return false;
        }
        return true;
    });
    const standaloneFeatureTabs = visibleFeatureTabs.filter(
        (featureTab) => !featureAnchorOwnerByTabId.has(featureTab.id),
    );
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
    const renderedSplitOwners = new Set([
        ...terminalSplitOwners,
        ...featureAnchorTabIdByOwner.keys(),
        ...pluginAnchorIdByOwner.keys(),
    ]);

    const renderSplitTab = (owner: string, layout: (typeof splitGroups)[number][1]) => {
        const isActive = splitLayout === layout || activePaneGroupOwner === owner;
        const projected = projectVisiblePaneLayout(layout, hiddenContent);
        const leaves = collectLeaves(layout.root);
        const members = leaves
            .filter((leaf) => !hiddenContent.has(paneContentKey(leaf.content, leaf.id)))
            .map((leaf) => {
                const id = paneContentKey(leaf.content, leaf.id);
                const content = leaf.content;
                let defaultLabel: string;
                let icon: ReactNode;
                if (isTermContent(content)) {
                    const term = allTerminals?.find((item) => item.id === content.termId);
                    defaultLabel = normalizeTerminalTitle(term?.title ?? 'Shell');
                    const shell = resolveShell(term?.shellOverride);
                    icon = shell ? (
                        <ShellIcon
                            shell={shell}
                            size={13}
                        />
                    ) : (
                        <TerminalIcon size={13} />
                    );
                } else if (isFeatureContent(content)) {
                    const meta = FEATURE_META[content.featureId];
                    defaultLabel = meta.label;
                    const Icon = meta.icon;
                    icon = <Icon size={13} />;
                } else {
                    defaultLabel =
                        pluginPanels.find((panel) => panel.id === content.pluginId)?.title ??
                        'Plugin';
                    icon = (
                        <PluginIcon
                            panelId={content.pluginId}
                            size={13}
                        />
                    );
                }
                return {
                    id,
                    label: resolveDisplayTitle(
                        defaultLabel,
                        contentPresentation?.[id]?.displayAlias,
                    ),
                    icon,
                };
            });
        const { label, description, closeDescription } = describePaneGroup(
            members,
            leaves.length - members.length,
        );
        const dock = dockFor(members.map((member) => member.id));
        const interactivePaneId = projected?.activePaneId;
        const activePane = interactivePaneId ? findNode(layout.root, interactivePaneId) : null;
        const dockPayload =
            activePane && isPaneLeaf(activePane) ? paneDockPayload(activePane) : null;
        return {
            id: `split:${owner}`,
            label,
            dragIcon: <PaneGroupTabIcon members={members} />,
            groupDescription: description,
            contextTarget: interactivePaneId
                ? ({ type: 'split', owner, paneId: interactivePaneId } as ContextMenuTarget)
                : undefined,
            contentIds: leaves.map((leaf) => paneContentKey(leaf.content, leaf.id)),
            render: (pinned: boolean) => (
                <Tooltip
                    key={`split:${owner}`}
                    content={dock ? `${description} — ${dock.description}` : description}
                    position="bottom"
                >
                    <div
                        onPointerDown={(event) => {
                            if (dockPayload) {
                                beginDockPointer(event, dockPayload);
                            }
                        }}
                        onClick={() => {
                            if (consumeClickIfDragged()) {
                                return;
                            }
                            onSplitSelect?.(owner);
                        }}
                        onContextMenu={(event) => {
                            event.preventDefault();
                            event.stopPropagation();
                            if (!interactivePaneId) {
                                return;
                            }
                            setContextMenu({
                                x: event.clientX,
                                y: event.clientY,
                                target: { type: 'split', owner, paneId: interactivePaneId },
                            });
                        }}
                        data-pane-group-tab
                        data-zync-color="contentTab"
                        data-zync-selected={isActive}
                        className={cn(
                            COMPACT_TAB_ROW_CLASSES,
                            'rounded-md transition-colors duration-100 cursor-grab min-w-[100px] max-w-[240px] group border border-transparent drag-none shrink-0 active:scale-[0.98] active:cursor-grabbing',
                            isActive
                                ? 'bg-app-surface text-app-text shadow-sm border-app-border/50'
                                : 'text-app-muted hover:bg-app-surface/50 hover:text-app-text',
                        )}
                    >
                        <ContentTabTrigger
                            label={description}
                            selected={isActive}
                            compact
                            dock={dock}
                        >
                            <PaneGroupTabIcon members={members} />
                            <span
                                data-tab-label
                                className={COMPACT_TAB_LABEL_CLASSES}
                            >
                                {label}
                            </span>
                            {pinned && <ContentPinIndicator />}
                        </ContentTabTrigger>
                        <button
                            data-pane-group-close
                            type="button"
                            onClick={(event) => {
                                event.stopPropagation();
                                onPaneGroupClose?.(owner);
                            }}
                            className={cn(
                                'inline-flex h-5 w-5 shrink-0 items-center justify-center rounded hover:bg-app-bg hover:text-red-400 transition-colors opacity-0 group-hover:opacity-100 group-focus-within:opacity-100',
                                isActive && 'opacity-100',
                            )}
                            aria-label={closeDescription}
                            title={closeDescription}
                        >
                            <X size={12} />
                        </button>
                    </div>
                </Tooltip>
            ),
        };
    };
    // Preserve the existing default anchors, then project instance preferences
    // across the complete strip so DOM order matches the visible order.
    const defaultTabs = [
        ...terminals.map((term) => {
            const ownedSplit = paneGroups?.[term.id];
            if (ownedSplit && isSplitLayout(ownedSplit)) {
                return renderSplitTab(term.id, ownedSplit);
            }
            if (groupedTermIds.has(term.id)) {
                return null;
            }
            const splitOwner = activeTerminalId
                ? findLayoutOwner(paneGroups, activeTerminalId)
                : null;
            const isActive =
                activeView === 'terminal' &&
                !activePaneGroupOwner &&
                (activeTerminalId === term.id || splitOwner === term.id);
            const defaultTitle = normalizeTerminalTitle(term.title);
            const contentId = paneContentKey({ kind: 'term', termId: term.id }, term.id);
            const dock = dockFor([contentId]);
            const tabLabel = resolveDisplayTitle(
                defaultTitle,
                contentPresentation?.[contentId]?.displayAlias,
            );
            // Prefer tab-stamped shell only. Do not fall back to live Default Shell settings.
            const effectiveShellId =
                term.shellOverride ??
                (connectionId === 'local' ? localDisplayFallbackShellId : remoteFallbackShellId);
            const shell = resolveShell(effectiveShellId);
            return {
                id: contentId,
                label: tabLabel,
                dragIcon: shell ? (
                    <ShellIcon
                        shell={shell}
                        size={13}
                    />
                ) : (
                    <TerminalIcon size={13} />
                ),
                contentIds: [contentId],
                contextTarget: { type: 'terminal', termId: term.id } as ContextMenuTarget,
                render: (pinned: boolean) => (
                    <Tooltip
                        key={term.id}
                        content={`${tabLabel === defaultTitle ? defaultTitle : `${tabLabel} — ${defaultTitle}`}${dock ? ` — ${dock.description}` : ''}`}
                        position="bottom"
                    >
                        <div
                            onPointerDown={(event) =>
                                beginDockPointer(event, { kind: 'term', termId: term.id })
                            }
                            onClick={() => {
                                if (consumeClickIfDragged()) {
                                    return;
                                }
                                onTabSelect('terminal', term.id);
                            }}
                            onDragOver={(event) => handleTermFileDragOver(event, term.id)}
                            onDragLeave={(event) => {
                                if (
                                    event.currentTarget.contains(event.relatedTarget as Node | null)
                                ) {
                                    return;
                                }
                                setFileDropTermId((current) =>
                                    current === term.id ? null : current,
                                );
                            }}
                            onDrop={(event) => handleTermFileDrop(event, term.id)}
                            onContextMenu={(e) => {
                                e.preventDefault();
                                e.stopPropagation();
                                setContextMenu({
                                    x: e.clientX,
                                    y: e.clientY,
                                    target: { type: 'terminal', termId: term.id },
                                });
                            }}
                            data-zync-color="contentTab"
                            data-zync-selected={isActive}
                            className={cn(
                                'flex items-center gap-2 px-3 py-1.5 h-7 text-xs font-medium rounded-md transition-colors duration-100 cursor-grab min-w-[100px] max-w-[200px] group border border-transparent drag-none shrink-0 active:scale-[0.98] active:cursor-grabbing',
                                isActive
                                    ? 'bg-app-surface text-app-text shadow-sm border-app-border/50'
                                    : 'text-app-muted hover:bg-app-surface/50 hover:text-app-text',
                                fileDragActive &&
                                    fileDropTermId === term.id &&
                                    'border-app-accent bg-app-accent/15 text-app-text',
                            )}
                        >
                            <ContentTabTrigger
                                label={`${tabLabel} tab`}
                                selected={isActive}
                                dock={dock}
                            >
                                {shell ? (
                                    <ShellIcon
                                        shell={shell}
                                        size={12}
                                    />
                                ) : (
                                    <TerminalIcon
                                        size={12}
                                        className={cn(
                                            isActive ? 'text-app-accent' : 'text-app-muted',
                                        )}
                                    />
                                )}
                                <span className="truncate flex-1">{tabLabel}</span>
                                {pinned && <ContentPinIndicator />}
                            </ContentTabTrigger>
                            <button
                                type="button"
                                aria-label={`Close ${tabLabel}`}
                                onClick={(e) => {
                                    e.stopPropagation();
                                    onTerminalClose(term.id);
                                }}
                                className={cn(
                                    'p-0.5 rounded hover:bg-app-bg hover:text-red-400 transition-colors opacity-0 group-hover:opacity-100 group-focus-within:opacity-100',
                                    isActive && 'opacity-100',
                                )}
                            >
                                <X size={12} />
                            </button>
                        </div>
                    </Tooltip>
                ),
            };
        }),

        // Restored/legacy groups without a current inventory anchor.
        ...splitGroups
            .filter(([owner]) => !renderedSplitOwners.has(owner))
            .map(([owner, layout]) => renderSplitTab(owner, layout)),

        ...visibleFeatureTabs.map((featureTab) => {
            const anchoredOwner = featureAnchorOwnerByTabId.get(featureTab.id);
            const anchoredLayout = anchoredOwner ? paneGroups?.[anchoredOwner] : undefined;
            if (anchoredOwner && anchoredLayout && isSplitLayout(anchoredLayout)) {
                return renderSplitTab(anchoredOwner, anchoredLayout);
            }
            const featureId = featureTab.featureId;
            const config = FEATURE_META[featureId];
            const duplicateCount = standaloneFeatureCounts.get(featureId) ?? 0;
            const defaultTitle =
                duplicateCount > 1
                    ? `${config.label} ${standaloneFeatureOrdinals.get(featureTab.id) ?? 1}`
                    : config.label;
            const contentId = paneContentKey(
                { kind: 'feature', featureId, instanceId: featureTab.instanceId },
                featureTab.id,
            );
            const dock = dockFor([contentId]);
            const tabLabel = resolveDisplayTitle(
                defaultTitle,
                contentPresentation?.[contentId]?.displayAlias,
            );
            const isActive =
                (activeView === featureId && activeFeatureTabId === featureTab.id) ||
                (activeView === 'terminal' &&
                    Boolean(anchoredOwner) &&
                    activePaneGroupOwner === anchoredOwner);
            const isPinned =
                pinnedFeatures.includes(featureId) && featureTab.id === `pinned:${featureId}`;
            const Icon = config.icon;
            const sourcePane = allPaneLeaves.find(
                (leaf) =>
                    isFeatureContent(leaf.content) &&
                    leaf.content.featureId === featureId &&
                    leaf.content.instanceId === featureTab.instanceId,
            );

            return {
                id: contentId,
                label: tabLabel,
                dragIcon: <Icon size={13} />,
                contentIds: [contentId],
                contextTarget: {
                    type: 'feature',
                    featureId,
                    tabId: featureTab.id,
                } as ContextMenuTarget,
                render: (pinned: boolean) => (
                    <Tooltip
                        content={`${tabLabel === defaultTitle ? defaultTitle : `${tabLabel} — ${defaultTitle}`}${dock ? ` — ${dock.description}` : ''}`}
                        position="bottom"
                    >
                        <div
                            key={featureTab.id}
                            onPointerDown={(event) => {
                                if (!isSplitFeatureId(featureId)) {
                                    return;
                                }
                                beginDockPointer(event, {
                                    kind: 'feature',
                                    featureId,
                                    instanceId: featureTab.instanceId,
                                    sourcePaneId: sourcePane?.id,
                                });
                            }}
                            onClick={() => {
                                if (consumeClickIfDragged()) {
                                    return;
                                }
                                onFeatureTabSelect(featureTab.id, featureId);
                            }}
                            onContextMenu={(e) => {
                                e.preventDefault();
                                e.stopPropagation();
                                setContextMenu({
                                    x: e.clientX,
                                    y: e.clientY,
                                    target: { type: 'feature', featureId, tabId: featureTab.id },
                                });
                            }}
                            data-zync-color="contentTab"
                            data-zync-selected={isActive}
                            className={cn(
                                'flex items-center gap-2 px-3 py-1.5 h-7 text-xs font-medium rounded-md transition-colors duration-100 cursor-grab min-w-[90px] group border border-transparent relative drag-none shrink-0 active:scale-[0.98] active:cursor-grabbing',
                                isActive
                                    ? 'bg-app-surface text-app-text shadow-sm border-app-border/50'
                                    : 'text-app-muted hover:bg-app-surface/50 hover:text-app-text',
                            )}
                        >
                            {/* Pin Indicator */}
                            {isPinned && (
                                <div className="absolute top-0.5 right-0.5 w-1 h-1 rounded-full bg-app-accent" />
                            )}

                            <ContentTabTrigger
                                label={`${tabLabel} tab`}
                                selected={isActive}
                                dock={dock}
                            >
                                <span
                                    className={cn(
                                        'inline-flex h-4 w-4 items-center justify-center rounded-sm shrink-0',
                                        isActive ? 'text-app-accent' : 'text-app-muted',
                                    )}
                                >
                                    <Icon size={11} />
                                </span>
                                <span className="truncate flex-1">{tabLabel}</span>
                                {pinned && <ContentPinIndicator />}
                            </ContentTabTrigger>

                            {/* Close Button (Hidden if Pinned) */}
                            {!isPinned && (
                                <button
                                    type="button"
                                    aria-label={`Close ${tabLabel}`}
                                    onClick={(e) => {
                                        e.stopPropagation();
                                        onFeatureTabClose(featureTab.id, featureId);
                                    }}
                                    className={cn(
                                        'p-0.5 rounded hover:bg-app-bg hover:text-red-400 transition-colors opacity-0 group-hover:opacity-100 group-focus-within:opacity-100',
                                        isActive && 'opacity-100',
                                    )}
                                >
                                    <X size={12} />
                                </button>
                            )}
                        </div>
                    </Tooltip>
                ),
            };
        }),

        ...pluginInventory.map((item) => {
            if (!isPluginContent(item.content)) {
                return null;
            }
            const panelId = item.content.pluginId;
            const anchoredOwner = pluginAnchorOwnerById.get(item.id);
            const anchoredLayout = anchoredOwner ? paneGroups?.[anchoredOwner] : undefined;
            if (anchoredOwner && anchoredLayout && isSplitLayout(anchoredLayout)) {
                return renderSplitTab(anchoredOwner, anchoredLayout);
            }
            if (item.owner && isSplitLayout(paneGroups?.[item.owner])) {
                return null;
            }
            const panel = pluginPanels.find((p) => p.id === panelId) ?? {
                id: panelId,
                title: 'Plugin',
            };
            const dock = dockFor([item.id]);
            const tabLabel = resolveDisplayTitle(
                panel.title,
                contentPresentation?.[item.id]?.displayAlias,
            );
            const pluginLeaf = allPaneLeaves.find((leaf) => leaf.id === item.paneId);
            const isActive =
                (activeView === `plugin:${panelId}` || activeView === 'terminal') &&
                activePaneGroupOwner === item.owner;
            return {
                id: item.id,
                label: tabLabel,
                dragIcon: (
                    <PluginIcon
                        panelId={panelId}
                        size={13}
                    />
                ),
                contentIds: [item.id],
                contextTarget: { type: 'plugin', panelId, contentId: item.id } as ContextMenuTarget,
                render: (pinned: boolean) => (
                    <Tooltip
                        content={`${tabLabel === panel.title ? panel.title : `${tabLabel} — ${panel.title}`}${dock ? ` — ${dock.description}` : ''}`}
                        position="bottom"
                    >
                        <div
                            key={item.id}
                            onPointerDown={(event) =>
                                beginDockPointer(
                                    event,
                                    pluginLeaf
                                        ? paneDockPayload(pluginLeaf)
                                        : { kind: 'plugin', pluginId: panelId },
                                )
                            }
                            onClick={() => {
                                if (consumeClickIfDragged()) {
                                    return;
                                }
                                onPluginTabSelect(item.id);
                            }}
                            onContextMenu={(e) => {
                                e.preventDefault();
                                e.stopPropagation();
                                setContextMenu({
                                    x: e.clientX,
                                    y: e.clientY,
                                    target: { type: 'plugin', panelId, contentId: item.id },
                                });
                            }}
                            data-zync-color="contentTab"
                            data-zync-selected={isActive}
                            className={cn(
                                'flex items-center gap-2 px-3 py-1.5 h-7 text-xs font-medium rounded-md transition-colors duration-100 cursor-grab min-w-[90px] group border border-transparent relative drag-none shrink-0 active:scale-[0.98] active:cursor-grabbing',
                                isActive
                                    ? 'bg-app-surface text-app-text shadow-sm border-app-border/50'
                                    : 'text-app-muted hover:bg-app-surface/50 hover:text-app-text',
                            )}
                        >
                            <ContentTabTrigger
                                label={`${tabLabel} tab`}
                                selected={isActive}
                                dock={dock}
                            >
                                <PluginIcon
                                    panelId={panelId}
                                    size={14}
                                    className={cn(isActive ? 'text-app-accent' : 'text-app-muted')}
                                />
                                <span className="truncate flex-1">{tabLabel}</span>
                                {pinned && <ContentPinIndicator />}
                            </ContentTabTrigger>
                            <button
                                type="button"
                                aria-label={`Close ${tabLabel}`}
                                onClick={(e) => {
                                    e.stopPropagation();
                                    onPluginTabClose(item.id);
                                }}
                                className={cn(
                                    'p-0.5 rounded hover:bg-app-bg hover:text-red-400 transition-colors opacity-0 group-hover:opacity-100 group-focus-within:opacity-100',
                                    isActive && 'opacity-100',
                                )}
                            >
                                <X size={12} />
                            </button>
                        </div>
                    </Tooltip>
                ),
            };
        }),
    ].filter((tab): tab is NonNullable<typeof tab> => tab !== null);
    const presentedTabs = projectWorkspaceTabs(defaultTabs, presentationScope);
    const contextualExtras = (target: ContextMenuTarget | undefined) =>
        target
            ? getContextMenuItems({
                  target,
                  pinnedFeatures,
                  onTerminalClose,
                  onPluginTabClose,
                  onFeatureTabClose,
                  onTogglePin,
                  onUnsplit,
                  onSplitUnsplit,
                  onOpenSplitFeature,
                  onOpenSplitPlugin,
                  onDockTerm,
                  canUnsplitTab:
                      target.type === 'terminal' &&
                      isSplit &&
                      findLayoutOwner(paneGroups, activeTerminalId ?? '') === target.termId,
                  canOpenSplit:
                      target.type === 'feature' && isSplitFeatureId(target.featureId)
                          ? canSplit || layoutHasFeature(splitLayout, target.featureId)
                          : canSplit,
                  isCurrentShellGroup:
                      target.type === 'terminal' &&
                      activeTerminalId != null &&
                      sameSplitGroup(paneGroups, activeTerminalId, target.termId),
              })
            : [];
    return (
        // Keep this strip out of native caption hit-testing so empty space can
        // open pane recovery menus. The top title bar owns window dragging.
        <div
            data-workspace-tab-strip
            data-workspace-scope={connectionId}
            tabIndex={-1}
            role="group"
            aria-label="Workspace tabs"
            onContextMenu={(event) => workspaceActions?.open(event, undefined, toolbarMenu.items)}
            onKeyDown={(event) => {
                if (
                    event.target === event.currentTarget &&
                    (event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10'))
                ) {
                    workspaceActions?.open(event, undefined, toolbarMenu.items);
                }
            }}
            data-zync-color="contentTabs"
            className={cn(
                'flex bg-app-panel border-app-border px-1 shrink-0 gap-1 select-none drag-none',
                vertical
                    ? 'host-tabs-vertical flex-col items-stretch h-full w-full min-w-0 py-1'
                    : 'items-center w-full border-b h-9',
            )}
        >
            {/* Chrome order is independent of retained content host mount order. */}
            <WorkspaceStripHandle tabId={tabId} />
            {/* Header drops include the open-tab button and trailing space, but not workspace actions. */}
            <div
                data-tab-insertion-surface
                className={cn(
                    'flex flex-1 min-w-0 min-h-0 gap-1',
                    vertical ? 'flex-col' : 'h-full items-center',
                )}
            >
                <div
                    data-tab-drag-strip
                    data-tab-drag-axis={vertical ? 'vertical' : 'horizontal'}
                    className={cn(
                        'min-w-0 min-h-0 flex scrollbar-hide gap-1 drag-none',
                        vertical
                            ? 'flex-1 flex-col items-stretch overflow-y-auto overflow-x-hidden'
                            : 'flex-initial overflow-x-auto h-full items-center pr-1',
                    )}
                >
                    {presentedTabs.map(({ item, pinned }) => (
                        <div
                            key={item.id}
                            role="group"
                            aria-label={
                                'groupDescription' in item
                                    ? item.groupDescription
                                    : `${item.label} tab`
                            }
                            data-workspace-tab-contents={JSON.stringify(item.contentIds)}
                            data-tab-drag-source
                            data-tab-drag-item
                            data-tab-drag-pinned={pinned}
                            className={cn(
                                'shrink-0 rounded-md focus-visible:outline focus-visible:outline-1 focus-visible:outline-app-accent',
                                vertical && 'w-full',
                            )}
                            onContextMenuCapture={(event) =>
                                workspaceActions?.open(
                                    event,
                                    item.contentIds,
                                    contextualExtras(item.contextTarget),
                                )
                            }
                            onKeyDown={(event) => {
                                if (
                                    event.target !==
                                    event.currentTarget.querySelector(
                                        '[data-workspace-tab-trigger]',
                                    )
                                ) {
                                    return;
                                }
                                if (
                                    event.key === 'ContextMenu' ||
                                    (event.shiftKey && event.key === 'F10')
                                ) {
                                    workspaceActions?.open(
                                        event,
                                        item.contentIds,
                                        contextualExtras(item.contextTarget),
                                    );
                                } else if (
                                    event.key === 'F2' &&
                                    !event.altKey &&
                                    !event.ctrlKey &&
                                    !event.metaKey &&
                                    !event.shiftKey &&
                                    item.contentIds.length === 1
                                ) {
                                    event.preventDefault();
                                    event.stopPropagation();
                                    workspaceActions?.rename(item.contentIds[0]);
                                }
                            }}
                        >
                            <div data-tab-drag-visual>{item.render(pinned)}</div>
                            <div
                                hidden
                                aria-hidden="true"
                            >
                                <TabDragPreview
                                    icon={item.dragIcon}
                                    compact={'groupDescription' in item}
                                >
                                    {item.label}
                                </TabDragPreview>
                            </div>
                        </div>
                    ))}
                </div>

                <div
                    className="relative flex items-center drag-none shrink-0 ml-1"
                    ref={dropdownRef}
                >
                    <TabAddButton
                        ref={dropdownButtonRef}
                        id={openMenuId}
                        label="Open a tab"
                        open={isDropdownOpen}
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
                    />
                    {isDropdownOpen && (
                        <WorkspaceOpenMenu
                            anchor={vertical ? dropdownButtonRef.current : undefined}
                            align={dropdownAlign}
                            shells={availableShells}
                            shellsLoading={shellsLoading}
                            shellsError={shellsError}
                            onRefetchShells={onRefetchShells}
                            canOpenFeature={canOpenFeature}
                            workspaceScope={workspaceScope}
                            features={(Object.keys(FEATURE_META) as FeatureId[]).map((id) => ({
                                id,
                                isOpen: featureTabs.some((tab) => tab.featureId === id),
                                isActive:
                                    activeView === id &&
                                    featureTabs.some(
                                        (tab) =>
                                            tab.id === activeFeatureTabId && tab.featureId === id,
                                    ),
                            }))}
                            plugins={pluginPanels.map((panel) => ({
                                id: panel.id,
                                title: panel.title,
                                isOpen: pluginInventory.some(
                                    (item) =>
                                        isPluginContent(item.content) &&
                                        item.content.pluginId === panel.id,
                                ),
                            }))}
                            onNewShell={onNewTerminal}
                            onOpenFeature={onOpenFeature}
                            onOpenPlugin={(pluginId) => onTabSelect(`plugin:${pluginId}`)}
                            splitFeatures={SPLIT_FEATURE_IDS.filter((id) =>
                                canCreateFeatureInWorkspace(id, workspaceScope),
                            ).map((id) => {
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
            </div>

            {contentActions}
            {(findTerminalId || onSplit || onToggleSessionTools) && (
                <div
                    tabIndex={-1}
                    onContextMenu={toolbarMenu.onContextMenu}
                    onKeyDown={toolbarMenu.onKeyDown}
                    className={cn(
                        'flex items-center shrink-0 gap-1 pr-0.5 drag-none',
                        vertical ? 'flex-wrap w-full' : 'ml-auto',
                    )}
                >
                    <ChromeActionItems
                        value={chromeActions}
                        area="workspaceToolbar"
                        slots={{
                            'terminal.find': findTerminalId && (
                                <Tooltip
                                    content="Find in terminal"
                                    position="bottom"
                                >
                                    <button
                                        type="button"
                                        aria-label="Find in terminal"
                                        onClick={() =>
                                            openTerminalFind(
                                                terminalCache.get(findTerminalId)?.term.element ??
                                                    null,
                                            )
                                        }
                                        className="h-7 w-7 flex items-center justify-center rounded-md border border-transparent text-app-muted transition-colors hover:text-app-text hover:bg-app-surface hover:border-app-border/40"
                                    >
                                        <Search
                                            size={14}
                                            aria-hidden="true"
                                        />
                                    </button>
                                </Tooltip>
                            ),
                            'workspace.splits': onSplit && (
                                <div className="flex items-center bg-app-surface/30 rounded-lg p-0.5 border border-app-border/30">
                                    <Tooltip
                                        content={`Split side by side${splitBinding ? ` (${formatShortcutLabel(splitBinding)})` : ''}`}
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
                                                !canSplit &&
                                                    'opacity-40 cursor-default hover:bg-transparent',
                                            )}
                                        >
                                            <SplitPaneIcon direction="horizontal" />
                                        </button>
                                    </Tooltip>
                                    <div className="w-px h-4 bg-app-border/50" />
                                    <Tooltip
                                        content={`Split stacked${stackedSplitBinding ? ` (${formatShortcutLabel(stackedSplitBinding)})` : ''}`}
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
                                                !canSplit &&
                                                    'opacity-40 cursor-default hover:bg-transparent',
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
                                                        !canOpenFilesSplit &&
                                                            'opacity-40 cursor-default hover:bg-transparent',
                                                    )}
                                                >
                                                    <FolderOpen size={14} />
                                                </button>
                                            </Tooltip>
                                        </>
                                    )}
                                </div>
                            ),
                            'workspace.sessionTools': onToggleSessionTools && (
                                <Tooltip
                                    content={
                                        sessionToolsHint
                                            ? `Session tools (${sessionToolsHint})`
                                            : 'Session tools'
                                    }
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
                            ),
                        }}
                    />
                    {toolbarMenu.menu}
                </div>
            )}

            {contextMenu && (
                <ContextMenu
                    x={contextMenu.x}
                    y={contextMenu.y}
                    onClose={() => setContextMenu(null)}
                    items={contextualExtras(contextMenu.target)}
                />
            )}
        </div>
    );
});
