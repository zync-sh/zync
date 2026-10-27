import { StateCreator } from 'zustand';

import { track } from '../features/usage';
import { disposeWorkspaceContent } from '../features/workspace/application/contentLifecycle';
import { registrationForContent } from '../features/workspace/application/viewRegistrationAdapters';
import {
    findWorkspacePane,
    type WorkspacePaneTarget,
    workspaceCanvases,
    workspacePaneForDockPayload,
} from '../features/workspace/domain/canvases';
import {
    CONTENT_PRESENTATION_VERSION,
    isPresentationScopeId,
    MAX_PRESENTATION_SCOPES,
    parseContentPresentation,
} from '../features/workspace/domain/contentPresentation';
import { withoutWorkspaceDocking } from '../features/workspace/domain/docking';
import {
    allowsDockingTopology,
    dockingBesideTarget,
    dockingForDuplicate,
} from '../features/workspace/domain/dockingTopology';
import {
    type PaneTabInsertion,
    planPaneTabInsertion,
} from '../features/workspace/domain/paneTabRelease';
import {
    isPaneCloseBlocked,
    isPaneLayoutCloseBlocked,
    paneCloseScope,
} from '../lib/paneCloseBlockers';
import {
    canSplit,
    collectLeaves,
    type DockEdge,
    type DockPayload,
    type DockResult,
    detachTermFromGroups,
    dockIntoLayout,
    dropFeature,
    dropPlugin,
    dropSplitIntro,
    dropTerm,
    featurePaneContent,
    featureToPromoteOnLastShellExit,
    findLayoutOwner,
    findNode,
    firstLeaf,
    focusedTermIdForRestore,
    focusPane as focusPaneInLayout,
    isFeatureContent,
    isKeepableRemainder,
    isPaneLeaf,
    isPaneSplit,
    isPluginContent,
    isSplitLayout,
    isTermContent,
    layoutActiveTermId,
    layoutForCanvas,
    layoutForFeatureInstance,
    layoutForPlugin,
    layoutHasFeature,
    neighborPaneId,
    newFeatureInstanceId,
    type OpenSplitFeatureResult,
    ownerForLayout,
    type PaneContent,
    type PaneLayout,
    type PaneLayoutGroups,
    type PaneNavDirection,
    paneContentKey,
    parsePaneLayoutGroups,
    pluginPaneContent,
    projectVisiblePaneLayout,
    type SplitDirection,
    type SplitFeatureId,
    type SplitInsert,
    sameGroupTermDock,
    setSplitSizes,
    singleFeaturePane,
    singlePane,
    singlePluginPane,
    splitPane,
    termPaneContent,
    unsplitPane,
    visibleTermIds,
    WORKSPACE_PANE_OWNER,
} from '../lib/paneLayout';
import { releasePaneFromGroups } from '../lib/paneLayout/groups';
import { terminalService } from '../lib/terminal';
import type { TerminalTabSnapshot } from './sessionPersistence';
import { scheduleSaveSession } from './sessionSlice';
import type { AppStore } from './useAppStore';

export interface TerminalTab {
    id: string;
    title: string;
    initialPath?: string;
    lastKnownCwd?: string;
    isSynced?: boolean;
    /** True for SSH terminal tabs restored from session — PTY not yet spawned, waiting for reconnect. */
    pendingRestore?: boolean;
    /** Shell override passed to the backend PTY spawner for this specific tab.
     *  Undefined means "use the global default shell setting". */
    shellOverride?: string;
    /** False = split-only pane; hidden from the shell tab bar. Default true. */
    tabVisible?: boolean;
}

/** Launch metadata shared by standalone creation and atomic split insertion. */
export interface TerminalLaunchOptions {
    initialPath?: string;
    isSynced?: boolean;
    shellOverride?: string;
    title?: string;
}

export interface TerminalSlice {
    /** Keyed by connectionId, stores the list of terminal tabs for each connection */
    terminals: Record<string, TerminalTab[]>;
    /** Keyed by connectionId, stores the ID of the currently active terminal tab */
    activeTerminalIds: Record<string, string | null>;
    /** Keyed by connectionId, stores the ID of the terminal that is currently synced with the File Manager */
    syncedTerminalId: Record<string, string | null>;
    /** Split trees per connection, keyed by the tab that owns the split. */
    paneLayouts: Record<string, PaneLayoutGroups | undefined>;
    /** Which split group the canvas is showing (term id, files instance id, or workspace). */
    activePaneGroupOwner: Record<string, string | null>;

    // Actions
    /**
     * Creates a new terminal tab for a specific connection.
     * @param connectionId The ID of the connection to create the terminal for.
     * @param opts Optional creation options.
     * @returns The generated ID, or null if docking reservations leave no room.
     */
    createTerminal: (connectionId: string, opts?: TerminalLaunchOptions) => string | null;
    /** Insert a new shell and its destination together; refused plans never publish a shell tab. */
    openTerminalInSplit: (
        connectionId: string,
        edge: DockEdge,
        target: WorkspacePaneTarget,
        launch?: TerminalLaunchOptions,
        seed?: PaneContent,
    ) => DockResult;

    /**
     * Ensures at least one terminal exists for a connection. Creates one if none exist.
     * @param connectionId The ID of the connection to check.
     * @param initialPath Optional starting directory for the new terminal if one is created.
     * @returns The existing/new ID, or null if a new canvas cannot be opened.
     */
    ensureTerminal: (connectionId: string, initialPath?: string) => string | null;

    /**
     * Closes a specific terminal tab and cleans up associated backend processes and AI history.
     * @param connectionId The ID of the connection the terminal belongs to.
     * @param termId The ID of the terminal to close.
     */
    closeTerminal: (connectionId: string, termId: string) => void;
    /** Close a visible shell tab and every extra pane it owns. */
    closeTerminalGroup: (connectionId: string, termId: string) => void;
    /** Natural shell exit (`exit` / Ctrl+D): drop this pane only, keep the rest of the split tab. */
    closePaneOnShellExit: (connectionId: string, termId: string) => void;

    /**
     * Sets a specific terminal as the active one for a connection.
     * A persistent dock receives input focus without replacing the center selection.
     * @param connectionId The ID of the connection.
     * @param termId The ID of the terminal to make active.
     */
    setActiveTerminal: (connectionId: string, termId: string) => void;
    activatePaneGroup: (connectionId: string, owner: string) => void;
    closePaneGroup: (connectionId: string, owner: string) => boolean;

    /**
     * Clears all terminal tabs for a specific connection and prunes all associated AI history.
     * @param connectionId The ID of the connection to clear terminals for.
     * @param options Optional. If preservePendingRestore is true, keep the tab list but mark with pendingRestore=true (for SSH reconnect flow) instead of fully deleting.
     */
    clearTerminals: (connectionId: string, options?: { preservePendingRestore?: boolean }) => void;

    /**
     * Updates the last known CWD of a terminal.
     */
    setTerminalCwd: (connectionId: string, termId: string, path: string) => void;

    /**
     * Updates the initialPath of a terminal tab record.
     */
    setTerminalInitialPath: (connectionId: string, termId: string, path: string) => void;

    /** Persist the shell used for a tab (e.g. after spawn when only settings had `wsl`). */
    setTerminalShellOverride: (connectionId: string, termId: string, shellOverride: string) => void;

    /**
     * Restore persisted terminal tabs for a connection on app start.
     * Uses saved IDs and metadata directly without spawning new UUIDs.
     * SSH tabs are marked pendingRestore=true until the connection reconnects.
     * Only called by sessionSlice.loadSession() during restore.
     */
    restoreTerminalTabs: (
        connectionId: string,
        snapshots: TerminalTabSnapshot[],
        activeTerminalId: string | null,
        paneLayout?: unknown,
    ) => void;

    /** An explicit target must still exist and be visible; refusal never changes selection. */
    /** Duplicate the target, or atomically insert a new shell when launch options are supplied. */
    splitPanes: (
        connectionId: string,
        direction?: SplitDirection,
        insert?: SplitInsert,
        target?: WorkspacePaneTarget,
        terminal?: TerminalLaunchOptions,
    ) => boolean;
    /** Split the current feature pane (Files | Files, etc.) even when no shell is open. */
    splitFeaturePane: (
        connectionId: string,
        featureId: SplitFeatureId,
        direction?: SplitDirection,
        instanceId?: string,
    ) => DockResult;
    /** Ungrouped Files/Dashboard/… is a real pane, not an overlay. */
    ensureFeaturePane: (
        connectionId: string,
        featureId: SplitFeatureId,
        instanceId: string,
    ) => boolean;
    ensurePluginPane: (connectionId: string, pluginId: string) => boolean;
    closePluginPanes: (connectionId: string, pluginId: string) => void;
    unsplitPanes: (connectionId: string) => void;
    togglePanes: (connectionId: string) => void;
    resizePanes: (
        connectionId: string,
        splitId: string,
        sizes: [number, number],
        persist?: boolean,
        layoutOwner?: string,
    ) => void;
    focusPane: (connectionId: string, paneId: string, layoutOwner?: string) => void;
    focusPaneInDirection: (
        connectionId: string,
        direction: PaneNavDirection,
        targetPaneId?: string,
        layoutOwner?: string,
    ) => boolean;
    /** Open or focus a split-capable feature beside the focused pane. Never replaces a shell. */
    openFeatureInSplit: (
        connectionId: string,
        featureId: SplitFeatureId,
        edge?: DockEdge,
    ) => OpenSplitFeatureResult;
    /** Dock a feature tab or move a shell tab into this group's split. */
    dockInSplit: (
        connectionId: string,
        payload: DockPayload,
        edge: DockEdge,
        targetPaneId?: WorkspacePaneTarget | null,
        canvasTermId?: string | null,
        targetContent?: PaneContent,
        /** Internal creation path; must reference a new terminal ID with no drag-source hint. */
        launch?: TerminalLaunchOptions,
    ) => DockResult;
    /** Remove a feature leaf; leftover shells stay. */
    closeFeatureInSplit: (connectionId: string, featureId: SplitFeatureId) => void;
    /** Remove a plugin leaf; leftover shells stay. */
    closePluginInSplit: (connectionId: string, pluginId: string) => void;
    /** Close one split pane by id (feature, plugin, or extra shell). */
    closePaneInSplit: (connectionId: string, target: WorkspacePaneTarget) => boolean;
    /** Detach content without closing/remounting it. Optional strip insertion commits
     * layout and validated rank metadata together; refusal changes neither. */
    releasePaneFromSplit: (
        connectionId: string,
        target: WorkspacePaneTarget,
        insertion?: PaneTabInsertion,
    ) => boolean;

    /**
     * Clears the pendingRestore flag on all terminal tabs for a connection.
     * Called after a successful SSH reconnect so tabs can spawn their PTYs.
     */
    clearPendingRestore: (connectionId: string) => void;
}

// @ts-ignore
const ipc = window.ipcRenderer;

function isTabVisible(tab: TerminalTab): boolean {
    return tab.tabVisible !== false;
}

/** Choose the lowest unused Shell number across current and legacy terminal titles. */
function nextShellTitle(tabs: readonly TerminalTab[]): string {
    const used = new Set<number>();
    for (const tab of tabs) {
        const match = /^(?:Shell|Terminal)\s+(\d+)\b/i.exec(tab.title.trim());
        if (match) {
            used.add(Number(match[1]));
        }
    }
    let n = 1;
    while (used.has(n)) {
        n += 1;
    }
    return `Shell ${n}`;
}

/** Discard animation markers from a refused plan, without altering live resources. */
function discardPlannedSplitIntros(
    state: AppStore,
    scope: string,
    groups: PaneLayoutGroups | undefined,
): void {
    const prior = new Set<string>();
    /** Visit split identities so tentative animation markers can be compared with live splits. */
    const visit = (node: import('../lib/paneLayout').PaneNode, accept: (id: string) => void) => {
        if (!isPaneSplit(node)) {
            return;
        }
        accept(node.id);
        for (const child of node.children) {
            visit(child, accept);
        }
    };
    for (const layout of Object.values(state.paneLayouts[scope] ?? {})) {
        visit(layout.root, (id) => prior.add(id));
    }
    for (const layout of Object.values(groups ?? {})) {
        visit(layout.root, (id) => {
            if (!prior.has(id)) {
                dropSplitIntro(id);
            }
        });
    }
}

/** Validate proposed canvas capacity and discard tentative animation markers on refusal. */
function acceptsDockingTopology(
    state: AppStore,
    scope: string,
    terminals: readonly TerminalTab[],
    groups: PaneLayoutGroups | undefined,
): boolean {
    if (allowsDockingTopology(state, scope, terminals, groups)) {
        return true;
    }
    discardPlannedSplitIntros(state, scope, groups);
    return false;
}

/** Explain a rejected pane allocation without changing the existing workspace. */
function reportDockingReservation(state: AppStore): void {
    state.showToast(
        'info',
        'There is no room for another pane. Move a docked pane back to the workspace or close a pane first.',
    );
}

/** Snapshot resource descriptors by stable identity before changing their containers. */
function connectionContents(state: AppStore, connectionId: string): Map<string, PaneContent> {
    const contents = new Map<string, PaneContent>();
    for (const tab of state.terminals[connectionId] ?? []) {
        const content = termPaneContent(tab.id);
        contents.set(paneContentKey(content, tab.id), content);
    }
    for (const layout of Object.values(state.paneLayouts[connectionId] ?? {})) {
        for (const pane of collectLeaves(layout.root)) {
            contents.set(paneContentKey(pane.content, pane.id), pane.content);
        }
    }
    return contents;
}

/** Presentation visibility never changes the canonical resource inventory. */
function isContentHidden(
    state: AppStore,
    connectionId: string,
    content: PaneContent,
    paneId: string,
): boolean {
    return (
        state.contentPresentation?.[connectionId]?.items[paneContentKey(content, paneId)]
            ?.hidden === true
    );
}

/** Repair effective focus over visible geometry while keeping the saved tree intact. */
function visibleLayout(
    state: AppStore,
    connectionId: string,
    layout: PaneLayout,
): PaneLayout | null {
    const hidden = new Set(
        Object.entries(state.contentPresentation?.[connectionId]?.items ?? {})
            .filter(([, item]) => item.hidden === true)
            .map(([id]) => id),
    );
    return projectVisiblePaneLayout(layout, hidden);
}

/** An implicit operation must not seed a replacement for an all-hidden workspace. */
function allContentHidden(state: AppStore, connectionId: string): boolean {
    const contents = connectionContents(state, connectionId);
    return (
        contents.size > 0 &&
        [...contents.keys()].every(
            (key) => state.contentPresentation?.[connectionId]?.items[key]?.hidden === true,
        )
    );
}

/** Release metadata and content-owned state only for permanent inventory removals. */
function forgetClosedContent(
    get: () => AppStore,
    connectionId: string,
    before: ReadonlyMap<string, PaneContent>,
): void {
    const state = get();
    const live = connectionContents(state, connectionId);
    const removed = [...before.keys()].filter((key) => !live.has(key));
    if (removed.length > 0) {
        disposeWorkspaceContent(
            state,
            connectionId,
            removed.map((key) => before.get(key)!),
            live.values(),
        );
        state.forgetClosedWorkspaceDocking(connectionId, removed);
        get().forgetContentPresentation(connectionId, removed);
    }
}

/** Enforce plugin instance multiplicity before a split can duplicate its content. */
function permitsPluginDuplicate(state: AppStore, content: PaneContent): boolean {
    if (
        content.kind !== 'plugin' ||
        registrationForContent(state.workspaceViewRegistry, content)?.multiplicity === 'multiple'
    ) {
        return true;
    }
    state.showToast('info', 'This plugin panel does not support multiple instances.');
    return false;
}

/** Resolve a legacy pane or overlay target, then fall back to selected shell/workspace ownership. */
function resolveDockOwner(
    groups: PaneLayoutGroups | undefined,
    activeId: string | null | undefined,
    targetPaneId?: string,
    activeGroupOwner?: string | null,
): string | null {
    if (targetPaneId?.startsWith('overlay:')) {
        return WORKSPACE_PANE_OWNER;
    }
    if (targetPaneId && groups) {
        for (const [owner, layout] of Object.entries(groups)) {
            if (findNode(layout.root, targetPaneId)) {
                return owner;
            }
        }
    }
    if (activeGroupOwner && groups?.[activeGroupOwner]) {
        return activeGroupOwner;
    }
    if (activeId) {
        const activeOwner = findLayoutOwner(groups, activeId);
        if (activeOwner) {
            return activeOwner;
        }
    }
    if (groups?.[WORKSPACE_PANE_OWNER]) {
        return WORKSPACE_PANE_OWNER;
    }
    return activeId ?? WORKSPACE_PANE_OWNER;
}

function writeConnectionGroups(
    paneLayouts: Record<string, PaneLayoutGroups | undefined>,
    connectionId: string,
    groups: PaneLayoutGroups | undefined,
): Record<string, PaneLayoutGroups | undefined> {
    const next = { ...paneLayouts };
    if (groups && Object.keys(groups).length > 0) {
        next[connectionId] = groups;
    } else {
        delete next[connectionId];
    }
    return next;
}

/** Manage workspace containers while delegating resource cleanup to content owners. */
export const createTerminalSlice: StateCreator<AppStore, [], [], TerminalSlice> = (set, get) => ({
    terminals: {},
    activeTerminalIds: {},
    syncedTerminalId: {},
    paneLayouts: {},
    activePaneGroupOwner: {},

    /** @inheritdoc */
    createTerminal: (connectionId, opts) => {
        const initialPath = opts?.initialPath;
        const isSynced = opts?.isSynced ?? false;
        const newId = `term-${crypto.randomUUID()}`;
        const current = get();
        if (
            !allowsDockingTopology(
                current,
                connectionId,
                [...(current.terminals[connectionId] ?? []), { id: newId }],
                current.paneLayouts[connectionId],
            )
        ) {
            reportDockingReservation(current);
            return null;
        }
        set((state) => {
            const currentTabs = state.terminals[connectionId] || [];
            const defaultTitle = nextShellTitle(currentTabs);
            const newTab: TerminalTab = {
                id: newId,
                title: opts?.title ?? (isSynced ? `Synced Terminal` : defaultTitle),
                initialPath,
                isSynced,
                shellOverride: opts?.shellOverride,
                tabVisible: true,
            };

            const nextSyncedIds = { ...state.syncedTerminalId };
            if (isSynced) {
                // If we are creating a new synced terminal, it becomes the primary synced one for this connection
                nextSyncedIds[connectionId] = newId;
            }

            return {
                terminals: {
                    ...state.terminals,
                    [connectionId]: [...currentTabs, newTab],
                },
                activeTerminalIds: {
                    ...state.activeTerminalIds,
                    [connectionId]: newId,
                },
                activePaneGroupOwner: { ...state.activePaneGroupOwner, [connectionId]: null },
                ...(state.workspaceDockFocus?.[connectionId] && {
                    workspaceDockFocus: { ...state.workspaceDockFocus, [connectionId]: null },
                }),
                syncedTerminalId: nextSyncedIds,
            };
        });
        scheduleSaveSession(() => get().saveSession());
        track('terminal');
        return newId;
    },

    /** @inheritdoc */
    ensureTerminal: (connectionId, initialPath) => {
        const state = get();
        const currentTabs = state.terminals[connectionId] || [];
        if (currentTabs.length === 0) {
            return get().createTerminal(connectionId, { initialPath });
        }
        const visibleTabs = currentTabs.filter(
            (tab) => !isContentHidden(state, connectionId, termPaneContent(tab.id), tab.id),
        );
        const activeId = state.activeTerminalIds[connectionId];
        if (activeId && visibleTabs.some((tab) => tab.id === activeId)) {
            return activeId;
        }
        // Hidden/split-only terminals still exist. Do not create or select another
        // resource just because none currently has a visible tab-strip entry.
        if (visibleTabs.length === 0) {
            return currentTabs.find((tab) => tab.id === activeId)?.id ?? currentTabs[0].id;
        }
        const fallbackId = visibleTabs.find(isTabVisible)?.id ?? visibleTabs[0].id;
        get().setActiveTerminal(connectionId, fallbackId);
        return fallbackId;
    },

    /** @inheritdoc */
    closeTerminalGroup: (connectionId, termId) => {
        const before = connectionContents(get(), connectionId);
        const owner = findLayoutOwner(get().paneLayouts[connectionId], termId) ?? termId;
        const owned = get().paneLayouts[connectionId]?.[owner];
        if (owned && isPaneLayoutCloseBlocked(connectionId, owned)) {
            get().showToast('warning', 'Close the unsaved editor before closing this pane.');
            return;
        }
        const extraIds = owned ? visibleTermIds(owned).filter((id) => id !== owner) : [];
        const groupId = owned ? owner : termId;
        for (const id of [groupId, ...extraIds]) {
            ipc.send('terminal:kill', { termId: id });
            terminalService.destroy(id);
        }

        set((state) => {
            const currentTabs = state.terminals[connectionId] || [];
            const groups = state.paneLayouts[connectionId];
            const removeIds = new Set([groupId, ...extraIds]);

            const newTabs = currentTabs.filter((t) => !removeIds.has(t.id));

            // Determine new active tab if we closed the active one
            let newActiveId = state.activeTerminalIds[connectionId];
            if (newActiveId && removeIds.has(newActiveId)) {
                const barTabs = newTabs.filter(isTabVisible);
                newActiveId =
                    barTabs.length > 0 ? barTabs[barTabs.length - 1].id : (newTabs[0]?.id ?? null);
            }

            // Cleanup synced terminal reference if closed
            const nextSyncedIds = { ...state.syncedTerminalId };
            if (nextSyncedIds[connectionId] && removeIds.has(nextSyncedIds[connectionId]!)) {
                nextSyncedIds[connectionId] = null;
            }

            let nextConversations = state.aiConversations;
            let nextDisplay = state.aiDisplayHistory;
            for (const id of removeIds) {
                const { [id]: _c, ...restC } = nextConversations;
                const { [id]: _d, ...restD } = nextDisplay;
                nextConversations = restC;
                nextDisplay = restD;
            }

            let nextGroups = { ...(groups ?? {}) };
            delete nextGroups[groupId];
            for (const [layoutOwner, layout] of Object.entries(nextGroups)) {
                const contained = visibleTermIds(layout).includes(groupId);
                // Single-pane canvases are valid tabs. Never prune a layout that
                // does not contain the closed shell, or dispose its content metadata.
                if (!contained) {
                    continue;
                }
                const dropped = dropTerm(layout, groupId);
                if (dropped && isSplitLayout(dropped)) {
                    nextGroups[layoutOwner] = dropped;
                    if (contained) {
                        const remaining = layoutActiveTermId(dropped);
                        if (remaining) {
                            newActiveId = remaining;
                        }
                    }
                } else {
                    if (contained) {
                        const remaining = dropped ? layoutActiveTermId(dropped) : null;
                        if (remaining) {
                            newActiveId = remaining;
                        }
                    }
                    delete nextGroups[layoutOwner];
                }
            }
            const nextLayouts = { ...state.paneLayouts };
            if (Object.keys(nextGroups).length > 0) {
                nextLayouts[connectionId] = nextGroups;
            } else {
                delete nextLayouts[connectionId];
            }

            return {
                terminals: {
                    ...state.terminals,
                    [connectionId]: newTabs,
                },
                activeTerminalIds: {
                    ...state.activeTerminalIds,
                    [connectionId]: newActiveId,
                },
                syncedTerminalId: nextSyncedIds,
                paneLayouts: nextLayouts,
                aiConversations: nextConversations,
                aiDisplayHistory: nextDisplay,
            };
        });
        forgetClosedContent(get, connectionId, before);
        get().saveSession();
    },

    /** Request a fresh terminal beside the addressed pane through shared docking admission. */
    openTerminalInSplit: (connectionId, edge, target, launch = {}, seed) =>
        get().dockInSplit(
            connectionId,
            { kind: 'term', termId: `term-${crypto.randomUUID()}` },
            edge,
            target,
            undefined,
            seed,
            launch,
        ),

    /** @inheritdoc */
    closeTerminal: (connectionId, termId) => {
        const before = connectionContents(get(), connectionId);
        const owner = findLayoutOwner(get().paneLayouts[connectionId], termId);
        const layout = owner ? get().paneLayouts[connectionId]?.[owner] : undefined;
        if (!owner || !layout || !isSplitLayout(layout)) {
            get().closeTerminalGroup(connectionId, termId);
            return;
        }

        ipc.send('terminal:kill', { termId });
        terminalService.destroy(termId);

        set((state) => {
            const tabs = state.terminals[connectionId] || [];
            const ownerTab = tabs.find((t) => t.id === owner);
            const { next, nextOwner } = detachTermFromGroups(
                state.paneLayouts[connectionId],
                termId,
            );
            const diedWasOwner = owner === termId;
            let newTabs = tabs.filter((t) => t.id !== termId);
            if (nextOwner && nextOwner !== termId) {
                newTabs = newTabs.map((t) => {
                    if (t.id !== nextOwner) {
                        return t;
                    }
                    return {
                        ...t,
                        tabVisible: true,
                        ...(diedWasOwner && ownerTab?.title ? { title: ownerTab.title } : {}),
                    };
                });
            }

            let newActiveId = state.activeTerminalIds[connectionId];
            let nextGroupOwner = state.activePaneGroupOwner[connectionId] ?? null;
            if (newActiveId === termId) {
                const remainingLayout = nextOwner ? next?.[nextOwner] : undefined;
                const remainingTerm = remainingLayout ? layoutActiveTermId(remainingLayout) : null;
                if (remainingTerm) {
                    newActiveId = remainingTerm;
                    nextGroupOwner = nextOwner;
                } else if (nextOwner && remainingLayout) {
                    nextGroupOwner = nextOwner;
                    const barTabs = newTabs.filter(isTabVisible);
                    newActiveId =
                        barTabs.length > 0
                            ? barTabs[barTabs.length - 1].id
                            : (newTabs[0]?.id ?? null);
                } else {
                    nextGroupOwner = null;
                    const barTabs = newTabs.filter(isTabVisible);
                    newActiveId =
                        barTabs.length > 0
                            ? barTabs[barTabs.length - 1].id
                            : (newTabs[0]?.id ?? null);
                }
            }

            const nextSyncedIds = { ...state.syncedTerminalId };
            if (nextSyncedIds[connectionId] === termId) {
                nextSyncedIds[connectionId] = null;
            }
            const { [termId]: _c, ...nextConversations } = state.aiConversations;
            const { [termId]: _d, ...nextDisplay } = state.aiDisplayHistory;

            const nextLayouts = { ...state.paneLayouts };
            if (next) {
                nextLayouts[connectionId] = next;
            } else {
                delete nextLayouts[connectionId];
            }

            return {
                terminals: { ...state.terminals, [connectionId]: newTabs },
                activeTerminalIds: { ...state.activeTerminalIds, [connectionId]: newActiveId },
                activePaneGroupOwner: {
                    ...state.activePaneGroupOwner,
                    [connectionId]: nextGroupOwner,
                },
                syncedTerminalId: nextSyncedIds,
                paneLayouts: nextLayouts,
                aiConversations: nextConversations,
                aiDisplayHistory: nextDisplay,
            };
        });
        forgetClosedContent(get, connectionId, before);
        get().saveSession();
    },

    /** Close an exited shell and select a surviving feature or split canvas when promotion is needed. */
    closePaneOnShellExit: (connectionId, termId) => {
        const owner = findLayoutOwner(get().paneLayouts[connectionId], termId);
        const layout = owner ? get().paneLayouts[connectionId]?.[owner] : undefined;
        const promote = featureToPromoteOnLastShellExit(layout, termId);
        get().closeTerminal(connectionId, termId);
        if (!promote) {
            return;
        }
        const groups = get().paneLayouts[connectionId];
        const remaining = Object.entries(groups ?? {}).find(([, group]) =>
            layoutHasFeature(group, promote),
        );
        const tab =
            get().tabs.find(
                (item) => item.connectionId === connectionId && item.id === get().activeTabId,
            ) ?? get().tabs.find((item) => item.connectionId === connectionId);
        if (remaining && isSplitLayout(remaining[1])) {
            get().activatePaneGroup(connectionId, remaining[0]);
            if (tab) {
                get().setTabView(tab.id, 'terminal');
            }
            return;
        }
        if (tab) {
            get().setTabView(tab.id, promote);
        }
    },

    /** @inheritdoc */
    setActiveTerminal: (connectionId, termId) => {
        const current = get();
        if (
            !(current.terminals[connectionId] ?? []).some((tab) => tab.id === termId) ||
            isContentHidden(current, connectionId, termPaneContent(termId), termId)
        ) {
            return;
        }
        // A dock is already visible beside the selected center. Activation owns
        // input focus only; selecting its empty center canvas would hide neighbors.
        const contentId = paneContentKey(termPaneContent(termId), termId);
        if (current.workspaceDocking?.[connectionId]?.placements[contentId]) {
            current.focusWorkspaceContent(connectionId, contentId);
            return;
        }
        set((state) => {
            const groups = state.paneLayouts[connectionId];
            const tab = (state.terminals[connectionId] || []).find((t) => t.id === termId);
            let nextActive = termId;
            let repairedLayout: PaneLayout | undefined;
            if (tab && isTabVisible(tab)) {
                const layout = groups?.[termId];
                if (layout && isSplitLayout(layout)) {
                    const visible = visibleLayout(state, connectionId, layout);
                    if (!visible) {
                        return state;
                    }
                    nextActive = layoutActiveTermId(visible) ?? termId;
                    if (visible.activePaneId !== layout.activePaneId) {
                        repairedLayout = focusPaneInLayout(layout, visible.activePaneId);
                    }
                }
            }
            const groupOwner = findLayoutOwner(groups, nextActive);
            return {
                ...(state.workspaceDockFocus?.[connectionId] && {
                    workspaceDockFocus: { ...state.workspaceDockFocus, [connectionId]: null },
                }),
                activeTerminalIds: {
                    ...state.activeTerminalIds,
                    [connectionId]: nextActive,
                },
                activePaneGroupOwner: {
                    ...state.activePaneGroupOwner,
                    [connectionId]: groupOwner,
                },
                ...(repairedLayout && {
                    paneLayouts: {
                        ...state.paneLayouts,
                        [connectionId]: { ...groups, [termId]: repairedLayout },
                    },
                }),
            };
        });
        scheduleSaveSession(() => get().saveSession());
    },

    /** @inheritdoc */
    clearTerminals: (connectionId, options = {}) => {
        const before = connectionContents(get(), connectionId);
        set((state) => {
            const tabs = state.terminals[connectionId] || [];

            if (!options.preservePendingRestore) {
                // Kill/destroy only when not preserving (for reconnect/restore flow).
                tabs.forEach((t) => {
                    ipc.send('terminal:kill', { termId: t.id });
                    terminalService.destroy(t.id);
                });
            }

            if (options.preservePendingRestore) {
                // Preserve tab list with pendingRestore metadata for SSH reconnect/restore flow (roadmap 5.9)
                // Do not delete active/synced so reconnect can wake the tabs.
                return {
                    terminals: {
                        ...state.terminals,
                        [connectionId]: tabs.map((t) => ({ ...t, pendingRestore: true })),
                    },
                };
            }

            const newTerminals = { ...state.terminals };
            delete newTerminals[connectionId];

            const newActiveIds = { ...state.activeTerminalIds };
            delete newActiveIds[connectionId];

            const newSyncedIds = { ...state.syncedTerminalId };
            delete newSyncedIds[connectionId];

            const nextLayouts = { ...state.paneLayouts };
            delete nextLayouts[connectionId];

            // 🗑️ Prune AI history for all cleared terminals
            const termIdsToRemove = new Set(tabs.map((t) => t.id));
            const nextConversations = Object.fromEntries(
                Object.entries(state.aiConversations).filter(([id]) => !termIdsToRemove.has(id)),
            );
            const nextDisplay = Object.fromEntries(
                Object.entries(state.aiDisplayHistory).filter(([id]) => !termIdsToRemove.has(id)),
            );

            return {
                terminals: newTerminals,
                activeTerminalIds: newActiveIds,
                syncedTerminalId: newSyncedIds,
                paneLayouts: nextLayouts,
                aiConversations: nextConversations,
                aiDisplayHistory: nextDisplay,
            };
        });
        forgetClosedContent(get, connectionId, before);
        scheduleSaveSession(() => get().saveSession());
    },

    /** @inheritdoc */
    setTerminalCwd: (connectionId, termId, path) => {
        set((state) => {
            const currentTabs = state.terminals[connectionId] || [];
            const newTabs = currentTabs.map((t) =>
                t.id === termId ? { ...t, lastKnownCwd: path } : t,
            );
            return {
                terminals: {
                    ...state.terminals,
                    [connectionId]: newTabs,
                },
            };
        });
        // CWD changes on every `cd` — debounce to avoid flooding disk.
        scheduleSaveSession(() => get().saveSession());
    },

    /** @inheritdoc */
    setTerminalInitialPath: (connectionId, termId, path) => {
        set((state) => {
            const currentTabs = state.terminals[connectionId] || [];
            const newTabs = currentTabs.map((t) =>
                t.id === termId ? { ...t, initialPath: path } : t,
            );
            return {
                terminals: {
                    ...state.terminals,
                    [connectionId]: newTabs,
                },
            };
        });
        scheduleSaveSession(() => get().saveSession());
    },

    /** @inheritdoc */
    setTerminalShellOverride: (connectionId, termId, shellOverride) => {
        set((state) => {
            const currentTabs = state.terminals[connectionId] || [];
            const newTabs = currentTabs.map((t) => (t.id === termId ? { ...t, shellOverride } : t));
            return {
                terminals: {
                    ...state.terminals,
                    [connectionId]: newTabs,
                },
            };
        });
        scheduleSaveSession(() => get().saveSession());
    },

    /** @inheritdoc */
    restoreTerminalTabs: (connectionId, snapshots, activeTerminalId, paneLayout) => {
        const before = connectionContents(get(), connectionId);
        const isSSH = connectionId !== 'local';
        const tabs: TerminalTab[] = snapshots.map((s) => ({
            id: s.id,
            title: s.title,
            initialPath: s.initialPath,
            lastKnownCwd: s.cwd,
            isSynced: s.isSynced ?? false,
            shellOverride: s.shellOverride,
            tabVisible: s.tabVisible,
            pendingRestore: isSSH || undefined,
        }));

        const syncedTab = tabs.find((t) => t.isSynced);
        const known = new Set(tabs.map((t) => t.id));
        const restoredGroups = parsePaneLayoutGroups(paneLayout, known);
        const hidden = new Set<string>();
        for (const [owner, layout] of Object.entries(restoredGroups)) {
            for (const id of visibleTermIds(layout)) {
                if (id !== owner) {
                    hidden.add(id);
                }
            }
        }
        const tabsWithVisibility = tabs.map((t) => ({
            ...t,
            tabVisible: !hidden.has(t.id),
        }));
        const knownRequested = tabs.some((t) => t.id === activeTerminalId)
            ? activeTerminalId
            : null;
        const restoredActive = focusedTermIdForRestore(
            restoredGroups,
            knownRequested,
            tabs[0]?.id ?? null,
        );
        set((state) => {
            const nextLayouts = { ...state.paneLayouts };
            if (Object.keys(restoredGroups).length > 0) {
                nextLayouts[connectionId] = restoredGroups;
            } else {
                delete nextLayouts[connectionId];
            }
            return {
                terminals: {
                    ...state.terminals,
                    [connectionId]: tabsWithVisibility,
                },
                activeTerminalIds: {
                    ...state.activeTerminalIds,
                    [connectionId]: restoredActive,
                },
                syncedTerminalId: {
                    ...state.syncedTerminalId,
                    [connectionId]: syncedTab?.id ?? null,
                },
                paneLayouts: nextLayouts,
            };
        });
        forgetClosedContent(get, connectionId, before);
    },

    /** @inheritdoc */
    clearPendingRestore: (connectionId) => {
        set((state) => {
            const tabs = state.terminals[connectionId];
            if (!tabs?.some((t) => t.pendingRestore)) {
                return state;
            }
            return {
                terminals: {
                    ...state.terminals,
                    [connectionId]: tabs.map((t) =>
                        t.pendingRestore ? { ...t, pendingRestore: undefined } : t,
                    ),
                },
            };
        });
    },

    /** Duplicate visible content or create a requested shell after validating the proposed split. */
    splitPanes: (
        connectionId,
        direction = 'horizontal',
        insert = 'after',
        requestedTarget,
        terminal,
    ) => {
        const state = get();
        const tabs = state.terminals[connectionId] || [];
        const activeId =
            state.activeTerminalIds[connectionId] ?? tabs.find(isTabVisible)?.id ?? null;
        const groups = state.paneLayouts[connectionId];
        const dockFocus = state.workspaceDockFocus?.[connectionId];
        const requested = requestedTarget ?? (dockFocus ? { contentId: dockFocus } : undefined);
        const exact =
            requested !== undefined
                ? findWorkspacePane(workspaceCanvases(tabs, groups), requested)
                : undefined;
        if (requested !== undefined && !exact) {
            return false;
        }
        const targetPaneId = exact?.leaf.id;
        const standaloneTargetId =
            exact && !groups?.[exact.owner] && isTermContent(exact.leaf.content)
                ? exact.leaf.content.termId
                : undefined;
        const owner =
            exact?.owner ??
            resolveDockOwner(
                groups,
                activeId,
                targetPaneId,
                state.activePaneGroupOwner[connectionId],
            );
        if (targetPaneId !== undefined && !standaloneTargetId) {
            const requested =
                owner && groups?.[owner] ? findNode(groups[owner].root, targetPaneId) : undefined;
            if (!requested || !isPaneLeaf(requested)) {
                return false;
            }
        }
        const seedTermId = standaloneTargetId ?? activeId;
        const layout =
            exact?.layout ??
            (owner
                ? (groups?.[owner] ??
                  (seedTermId && tabs.some((tab) => tab.id === seedTermId)
                      ? singlePane(seedTermId, standaloneTargetId)
                      : undefined))
                : undefined);
        if (!owner || !layout || !canSplit(layout)) {
            return false;
        }

        const visible = visibleLayout(state, connectionId, layout);
        if (!visible) {
            return false;
        }
        const target = findNode(layout.root, targetPaneId ?? visible.activePaneId);
        if (
            !target ||
            !isPaneLeaf(target) ||
            isContentHidden(state, connectionId, target.content, target.id)
        ) {
            return false;
        }
        if (!terminal && !permitsPluginDuplicate(state, target.content)) {
            return false;
        }
        if (
            state.workspaceDocking?.[connectionId]?.placements?.[
                paneContentKey(target.content, target.id)
            ] &&
            (!state.sessionLoaded || state.isRestoring || state.sessionPersistenceBlocked)
        ) {
            return false;
        }

        let nextTabs = tabs;
        let nextContent = target.content;
        let nextActiveId = activeId;
        if (terminal || isTermContent(target.content)) {
            const sourceTermId = isTermContent(target.content) ? target.content.termId : undefined;
            const sourceTab = tabs.find((tab) => tab.id === sourceTermId);
            if (!terminal && !sourceTab) {
                return false;
            }
            const duplicateId = `term-${crypto.randomUUID()}`;
            nextContent = termPaneContent(duplicateId);
            nextTabs = [
                ...tabs,
                {
                    id: duplicateId,
                    title:
                        terminal?.title ??
                        (terminal?.isSynced ? 'Synced Terminal' : nextShellTitle(tabs)),
                    tabVisible: false,
                    shellOverride: terminal ? terminal.shellOverride : sourceTab?.shellOverride,
                    initialPath: terminal
                        ? terminal.initialPath
                        : (sourceTab?.lastKnownCwd ?? sourceTab?.initialPath),
                    lastKnownCwd: terminal ? terminal.initialPath : sourceTab?.lastKnownCwd,
                    ...(terminal?.isSynced && { isSynced: true }),
                },
            ];
            nextActiveId = duplicateId;
        } else if (target.content.kind === 'feature') {
            const instanceId = newFeatureInstanceId(target.content.featureId);
            nextContent = featurePaneContent(target.content.featureId, instanceId);
        } else if (target.content.kind === 'plugin') {
            nextContent = pluginPaneContent(target.content.pluginId);
        }

        const result = splitPane(layout, target.id, direction, nextContent, undefined, insert);
        if (!result.ok) {
            return false;
        }
        const duplicateKey = paneContentKey(nextContent, result.newPaneId);
        const allocation = dockingForDuplicate(
            state.workspaceDocking,
            connectionId,
            paneContentKey(target.content, target.id),
            duplicateKey,
        );
        if (!allocation.ok) {
            discardPlannedSplitIntros(state, connectionId, { [owner]: result.layout });
            return false;
        }
        const destination = allocation.value[connectionId]?.placements[duplicateKey];
        if (
            destination &&
            !registrationForContent(
                state.workspaceViewRegistry,
                nextContent,
            )?.allowedLocations.includes(destination)
        ) {
            discardPlannedSplitIntros(state, connectionId, { [owner]: result.layout });
            return false;
        }
        const docked = Boolean(destination);
        const focused = docked
            ? { ...result.layout, activePaneId: layout.activePaneId }
            : focusPaneInLayout(result.layout, result.newPaneId);
        if (
            !acceptsDockingTopology(
                { ...state, workspaceDocking: allocation.value },
                connectionId,
                nextTabs,
                { ...(groups ?? {}), [owner]: focused },
            )
        ) {
            return false;
        }
        if (
            target.content.kind === 'feature' &&
            target.content.featureId === 'files' &&
            nextContent.kind === 'feature'
        ) {
            get().copyFilesListing(connectionId, target.content.instanceId, nextContent.instanceId);
        }
        set({
            terminals: { ...state.terminals, [connectionId]: nextTabs },
            ...(terminal?.isSynced && {
                syncedTerminalId: { ...state.syncedTerminalId, [connectionId]: nextActiveId },
            }),
            paneLayouts: {
                ...state.paneLayouts,
                [connectionId]: { ...(groups ?? {}), [owner]: focused },
            },
            ...(docked && {
                workspaceDocking: allocation.value,
                workspaceDockFocus: { ...state.workspaceDockFocus, [connectionId]: duplicateKey },
            }),
            ...(!docked &&
                state.workspaceDockFocus?.[connectionId] && {
                    workspaceDockFocus: { ...state.workspaceDockFocus, [connectionId]: null },
                }),
            activeTerminalIds:
                !docked && nextActiveId
                    ? { ...state.activeTerminalIds, [connectionId]: nextActiveId }
                    : state.activeTerminalIds,
            ...(!docked &&
                targetPaneId !== undefined && {
                    activePaneGroupOwner: { ...state.activePaneGroupOwner, [connectionId]: owner },
                }),
        });
        scheduleSaveSession(() => get().saveSession());
        track('split');
        if (terminal) {
            track('terminal');
        }
        if (nextContent.kind === 'feature' && nextContent.featureId === 'files') {
            track('split_files');
        }
        return true;
    },

    /** Ensure a feature instance has a canvas, seeding Files state only after capacity admission. */
    ensureFeaturePane: (connectionId, featureId, instanceId) => {
        const state = get();
        const groups = state.paneLayouts[connectionId];
        if (layoutForFeatureInstance(groups, instanceId)) {
            return true;
        }
        const nextGroups = {
            ...(groups ?? {}),
            [instanceId]: singleFeaturePane(featureId, undefined, instanceId),
        };
        if (
            !allowsDockingTopology(
                state,
                connectionId,
                state.terminals[connectionId] ?? [],
                nextGroups,
            )
        ) {
            reportDockingReservation(state);
            return false;
        }
        if (featureId === 'files') {
            get().copyFilesListing(connectionId, undefined, instanceId);
        }
        set({
            paneLayouts: {
                ...state.paneLayouts,
                [connectionId]: nextGroups,
            },
        });
        scheduleSaveSession(() => get().saveSession());
        return true;
    },

    /** Reuse a plugin's existing canvas or create one admitted standalone instance. */
    ensurePluginPane: (connectionId, pluginId) => {
        const state = get();
        const groups = state.paneLayouts[connectionId];
        if (layoutForPlugin(groups, pluginId)) {
            return true;
        }
        const content = pluginPaneContent(pluginId);
        const owner = content.instanceId!;
        const nextGroups = {
            ...(groups ?? {}),
            [owner]: singlePluginPane(pluginId, undefined, owner),
        };
        if (
            !allowsDockingTopology(
                state,
                connectionId,
                state.terminals[connectionId] ?? [],
                nextGroups,
            )
        ) {
            reportDockingReservation(state);
            return false;
        }
        set({
            paneLayouts: {
                ...state.paneLayouts,
                [connectionId]: nextGroups,
            },
        });
        scheduleSaveSession(() => get().saveSession());
        return true;
    },

    /** Remove a plugin's panes and release metadata for content actually removed. */
    closePluginPanes: (connectionId, pluginId) => {
        const before = connectionContents(get(), connectionId);
        set((state) => {
            const groups = state.paneLayouts[connectionId];
            if (!groups) {
                return state;
            }
            const next: PaneLayoutGroups = {};
            const releasedTerms = new Set<string>();
            let activeOwner = state.activePaneGroupOwner[connectionId] ?? null;
            for (const [owner, layout] of Object.entries(groups)) {
                const remaining = dropPlugin(layout, pluginId);
                if (isKeepableRemainder(remaining)) {
                    const candidateOwner = ownerForLayout(remaining, owner);
                    // Reserve original keys too: a later group must not overwrite
                    // a remainder that was promoted into its owner slot.
                    const occupied =
                        Object.prototype.hasOwnProperty.call(next, candidateOwner) ||
                        (candidateOwner !== owner &&
                            Object.prototype.hasOwnProperty.call(groups, candidateOwner));
                    const nextOwner = occupied ? owner : candidateOwner;
                    next[nextOwner] = remaining;
                    if (activeOwner === owner) {
                        activeOwner = nextOwner;
                    }
                } else {
                    for (const termId of remaining ? visibleTermIds(remaining) : []) {
                        releasedTerms.add(termId);
                    }
                    if (activeOwner === owner) {
                        activeOwner = null;
                    }
                }
            }
            return {
                terminals: {
                    ...state.terminals,
                    [connectionId]: (state.terminals[connectionId] ?? []).map((tab) =>
                        releasedTerms.has(tab.id) ? { ...tab, tabVisible: true } : tab,
                    ),
                },
                paneLayouts: writeConnectionGroups(state.paneLayouts, connectionId, next),
                activePaneGroupOwner: {
                    ...state.activePaneGroupOwner,
                    [connectionId]: activeOwner,
                },
            };
        });
        forgetClosedContent(get, connectionId, before);
        scheduleSaveSession(() => get().saveSession());
    },

    /** Select visible canvas focus, routing entirely docked groups through content focus instead. */
    activatePaneGroup: (connectionId, owner) => {
        const current = get();
        const canonical = current.paneLayouts[connectionId]?.[owner];
        const visible = canonical && visibleLayout(current, connectionId, canonical);
        if (!visible) {
            return;
        }
        const leaves = collectLeaves(visible.root);
        const placements = current.workspaceDocking?.[connectionId]?.placements;
        // An entirely docked group has no center allocation to select.
        if (leaves.every((leaf) => placements?.[paneContentKey(leaf.content, leaf.id)])) {
            const focused = leaves.find((leaf) => leaf.id === visible.activePaneId) ?? leaves[0];
            current.focusWorkspaceContent(
                connectionId,
                paneContentKey(focused.content, focused.id),
            );
            return;
        }
        set((state) => {
            const layout = state.paneLayouts[connectionId]?.[owner];
            if (!layout) {
                return state;
            }
            const visible = visibleLayout(state, connectionId, layout);
            if (!visible) {
                return state;
            }
            const termId = layoutActiveTermId(visible);
            return {
                ...(state.workspaceDockFocus?.[connectionId] && {
                    workspaceDockFocus: { ...state.workspaceDockFocus, [connectionId]: null },
                }),
                activePaneGroupOwner: {
                    ...state.activePaneGroupOwner,
                    [connectionId]: owner,
                },
                activeTerminalIds: termId
                    ? { ...state.activeTerminalIds, [connectionId]: termId }
                    : state.activeTerminalIds,
                ...(visible.activePaneId !== layout.activePaneId && {
                    paneLayouts: {
                        ...state.paneLayouts,
                        [connectionId]: {
                            ...state.paneLayouts[connectionId],
                            [owner]: focusPaneInLayout(layout, visible.activePaneId),
                        },
                    },
                }),
            };
        });
    },

    /** Close a guarded group, including hidden members, and release its content owners. */
    closePaneGroup: (connectionId, owner) => {
        const before = connectionContents(get(), connectionId);
        const layout = get().paneLayouts[connectionId]?.[owner];
        if (!layout) {
            return false;
        }
        if (isPaneLayoutCloseBlocked(connectionId, layout)) {
            get().showToast('warning', 'Close the unsaved editor before closing this pane.');
            return false;
        }
        const closedTermIds = visibleTermIds(layout);
        for (const termId of closedTermIds) {
            ipc.send('terminal:kill', { termId });
            terminalService.destroy(termId);
        }

        set((state) => {
            const groups = state.paneLayouts[connectionId];
            if (!groups?.[owner]) {
                return state;
            }
            const nextGroups = { ...groups };
            delete nextGroups[owner];
            const closedTermSet = new Set(closedTermIds);
            const currentTabs = state.terminals[connectionId] || [];
            const firstClosedIndex = currentTabs.findIndex((tab) => closedTermSet.has(tab.id));
            const nextTabs = currentTabs.filter((tab) => !closedTermSet.has(tab.id));
            let nextActiveId = state.activeTerminalIds[connectionId] ?? null;
            if (nextActiveId && closedTermSet.has(nextActiveId)) {
                const visibleTabs = nextTabs.filter(isTabVisible);
                const fallbackIndex =
                    firstClosedIndex < 0
                        ? visibleTabs.length - 1
                        : Math.min(firstClosedIndex, visibleTabs.length - 1);
                nextActiveId =
                    visibleTabs[Math.max(0, fallbackIndex)]?.id ?? nextTabs[0]?.id ?? null;
            }
            const nextSyncedIds = { ...state.syncedTerminalId };
            if (nextSyncedIds[connectionId] && closedTermSet.has(nextSyncedIds[connectionId]!)) {
                nextSyncedIds[connectionId] = null;
            }
            const nextConversations = Object.fromEntries(
                Object.entries(state.aiConversations).filter(([id]) => !closedTermSet.has(id)),
            );
            const nextDisplay = Object.fromEntries(
                Object.entries(state.aiDisplayHistory).filter(([id]) => !closedTermSet.has(id)),
            );
            const nextOwner =
                state.activePaneGroupOwner[connectionId] === owner
                    ? null
                    : (state.activePaneGroupOwner[connectionId] ?? null);
            return {
                terminals: { ...state.terminals, [connectionId]: nextTabs },
                activeTerminalIds: {
                    ...state.activeTerminalIds,
                    [connectionId]: nextActiveId,
                },
                syncedTerminalId: nextSyncedIds,
                paneLayouts: writeConnectionGroups(
                    state.paneLayouts,
                    connectionId,
                    Object.keys(nextGroups).length > 0 ? nextGroups : undefined,
                ),
                activePaneGroupOwner: {
                    ...state.activePaneGroupOwner,
                    [connectionId]: nextOwner,
                },
                aiConversations: nextConversations,
                aiDisplayHistory: nextDisplay,
            };
        });
        forgetClosedContent(get, connectionId, before);
        scheduleSaveSession(() => get().saveSession());
        return true;
    },

    /** Create a fresh feature split, delaying listing copies until topology and allocation pass. */
    splitFeaturePane: (connectionId, featureId, direction = 'horizontal', instanceId) => {
        const state = get();
        const pendingFilesCopies: Array<[string | undefined, string]> = [];
        if (allContentHidden(state, connectionId)) {
            return 'no-target';
        }
        const groups = state.paneLayouts[connectionId];
        const activeId = state.activeTerminalIds[connectionId];
        const matchingFeatures = Object.values(groups ?? {})
            .flatMap((group) => collectLeaves(group.root))
            .filter(
                (pane) =>
                    isFeatureContent(pane.content) &&
                    pane.content.featureId === featureId &&
                    (!instanceId || pane.content.instanceId === instanceId),
            );
        if (
            matchingFeatures.length > 0 &&
            matchingFeatures.every((pane) =>
                isContentHidden(state, connectionId, pane.content, pane.id),
            )
        ) {
            return 'no-target';
        }
        const instanceLayout = layoutForFeatureInstance(groups, instanceId);
        if (
            instanceId &&
            instanceLayout &&
            collectLeaves(instanceLayout.root).some(
                (pane) =>
                    isFeatureContent(pane.content) &&
                    pane.content.instanceId === instanceId &&
                    isContentHidden(state, connectionId, pane.content, pane.id),
            )
        ) {
            return 'no-target';
        }
        let owner = instanceId && groups?.[instanceId] ? instanceId : WORKSPACE_PANE_OWNER;
        let layout = instanceLayout ?? groups?.[WORKSPACE_PANE_OWNER];
        if (instanceLayout) {
            for (const [groupOwner, groupLayout] of Object.entries(groups ?? {})) {
                if (groupLayout === instanceLayout) {
                    owner = groupOwner;
                    break;
                }
            }
        }
        if (!layout || !layoutHasFeature(layout, featureId)) {
            const termOwner = activeId ? findLayoutOwner(groups, activeId) : null;
            const termLayout = termOwner ? groups?.[termOwner] : undefined;
            if (termOwner && termLayout && layoutHasFeature(termLayout, featureId)) {
                owner = termOwner;
                layout = termLayout;
            } else {
                const seedId = instanceId ?? newFeatureInstanceId(featureId);
                if (featureId === 'files') {
                    pendingFilesCopies.push([undefined, seedId]);
                    layout = singleFeaturePane('files', undefined, seedId);
                } else {
                    layout = singleFeaturePane(featureId, undefined, seedId);
                }
                owner = seedId;
            }
        }
        if (!canSplit(layout)) {
            return 'refused-cap';
        }
        const visible = visibleLayout(state, connectionId, layout);
        if (!visible) {
            return 'no-target';
        }
        const target = instanceId
            ? collectLeaves(visible.root).find(
                  (pane) =>
                      isFeatureContent(pane.content) &&
                      pane.content.featureId === featureId &&
                      pane.content.instanceId === instanceId,
              )
            : findNode(layout.root, visible.activePaneId);
        if (!target || !isPaneLeaf(target)) {
            return 'no-target';
        }
        const targetKey = paneContentKey(target.content, target.id);
        if (
            state.workspaceDocking?.[connectionId]?.placements[targetKey] &&
            (!state.sessionLoaded || state.isRestoring || state.sessionPersistenceBlocked)
        ) {
            return 'no-target';
        }
        const nextInstanceId = newFeatureInstanceId(featureId);
        let nextContent = featurePaneContent(featureId, nextInstanceId);
        if (featureId === 'files') {
            const fromInstance =
                isPaneLeaf(target) &&
                target.content.kind === 'feature' &&
                target.content.featureId === 'files'
                    ? target.content.instanceId
                    : undefined;
            pendingFilesCopies.push([fromInstance, nextInstanceId]);
        }
        const result = splitPane(layout, target.id, direction, nextContent);
        if (!result.ok) {
            return result.reason === 'cap' ? 'refused-cap' : 'no-target';
        }
        const duplicateKey = paneContentKey(nextContent, result.newPaneId);
        const allocation = dockingForDuplicate(
            state.workspaceDocking,
            connectionId,
            targetKey,
            duplicateKey,
        );
        if (!allocation.ok) {
            discardPlannedSplitIntros(state, connectionId, { [owner]: result.layout });
            return 'no-target';
        }
        const destination = allocation.value[connectionId]?.placements[duplicateKey];
        if (
            destination &&
            !registrationForContent(
                state.workspaceViewRegistry,
                nextContent,
            )?.allowedLocations.includes(destination)
        ) {
            discardPlannedSplitIntros(state, connectionId, { [owner]: result.layout });
            return 'no-target';
        }
        const docked = Boolean(destination);
        const nextGroups = {
            ...(groups ?? {}),
            [owner]: docked
                ? { ...result.layout, activePaneId: layout.activePaneId }
                : focusPaneInLayout(result.layout, result.newPaneId),
        };
        if (
            !acceptsDockingTopology(
                { ...state, workspaceDocking: allocation.value },
                connectionId,
                state.terminals[connectionId] ?? [],
                nextGroups,
            )
        ) {
            return 'refused-cap';
        }
        for (const [from, to] of pendingFilesCopies) {
            get().copyFilesListing(connectionId, from, to);
        }
        set({
            paneLayouts: {
                ...state.paneLayouts,
                [connectionId]: nextGroups,
            },
            ...(docked
                ? {
                      workspaceDocking: allocation.value,
                      workspaceDockFocus: {
                          ...state.workspaceDockFocus,
                          [connectionId]: duplicateKey,
                      },
                  }
                : {
                      activePaneGroupOwner: {
                          ...state.activePaneGroupOwner,
                          [connectionId]: owner,
                      },
                      workspaceDockFocus: { ...state.workspaceDockFocus, [connectionId]: null },
                  }),
        });
        scheduleSaveSession(() => get().saveSession());
        track('split');
        if (featureId === 'files') {
            track('split_files');
        }
        return 'opened';
    },

    /** Release the focused visible pane from its split or dock while retaining its resource. */
    unsplitPanes: (connectionId) => {
        const state = get();
        const dockId = state.workspaceDockFocus?.[connectionId];
        if (dockId) {
            get().releasePaneFromSplit(connectionId, { contentId: dockId });
            return;
        }
        const activeId = state.activeTerminalIds[connectionId];
        const groups = state.paneLayouts[connectionId];
        const owner = resolveDockOwner(
            groups,
            activeId,
            undefined,
            state.activePaneGroupOwner[connectionId],
        );
        const layout = owner ? groups?.[owner] : undefined;
        if (!owner || !layout || !isSplitLayout(layout)) {
            return;
        }
        const visible = visibleLayout(state, connectionId, layout);
        const focused = visible && findNode(visible.root, visible.activePaneId);
        if (focused && isPaneLeaf(focused)) {
            get().releasePaneFromSplit(connectionId, {
                contentId: paneContentKey(focused.content, focused.id),
            });
        }
    },

    togglePanes: (connectionId) => {
        const state = get();
        const activeId = state.activeTerminalIds[connectionId];
        const layout = layoutForCanvas(
            state.paneLayouts[connectionId],
            activeId,
            state.activePaneGroupOwner[connectionId],
        );
        if (canSplit(layout ?? null)) {
            get().splitPanes(connectionId);
        } else if (layout && isSplitLayout(layout)) {
            get().unsplitPanes(connectionId);
        }
    },

    /** Resize one unambiguous split and persist only an accepted requested resize. */
    resizePanes: (connectionId, splitId, sizes, persist = false, layoutOwner) => {
        let accepted = false;
        set((state) => {
            const groups = state.paneLayouts[connectionId];
            const matches = Object.entries(groups ?? {}).filter(
                ([owner, layout]) =>
                    (layoutOwner === undefined || owner === layoutOwner) &&
                    findNode(layout.root, splitId)?.type === 'split',
            );
            if (matches.length !== 1) {
                return state;
            }
            const [owner, layout] = matches[0];
            accepted = true;
            const nextGroups = {
                ...(groups ?? {}),
                [owner]: setSplitSizes(layout, splitId, sizes),
            };
            return {
                paneLayouts: { ...state.paneLayouts, [connectionId]: nextGroups },
            };
        });
        if (persist && accepted) {
            scheduleSaveSession(() => get().saveSession());
        }
    },

    /** An explicit layout owner is authoritative; resolve a canvas only when it is omitted. */
    focusPane: (connectionId, paneId, layoutOwner) => {
        const current = get();
        const currentOwner =
            layoutOwner ??
            resolveDockOwner(
                current.paneLayouts[connectionId],
                current.activeTerminalIds[connectionId],
                paneId,
            );
        const currentLayout = currentOwner
            ? current.paneLayouts[connectionId]?.[currentOwner]
            : undefined;
        const target = currentLayout ? findNode(currentLayout.root, paneId) : undefined;
        if (
            !target ||
            !isPaneLeaf(target) ||
            isContentHidden(current, connectionId, target.content, target.id)
        ) {
            return;
        }
        const key = paneContentKey(target.content, target.id);
        if (current.workspaceDocking?.[connectionId]?.placements[key]) {
            current.focusWorkspaceContent(connectionId, key);
            return;
        }
        set((state) => {
            const activeId = state.activeTerminalIds[connectionId];
            const groups = state.paneLayouts[connectionId];
            const owner = layoutOwner ?? resolveDockOwner(groups, activeId, paneId);
            const layout = owner ? groups?.[owner] : undefined;
            if (!owner || !layout) {
                return state;
            }
            const next = focusPaneInLayout(layout, paneId);
            const termId = layoutActiveTermId(visibleLayout(state, connectionId, next));
            return {
                ...(state.workspaceDockFocus?.[connectionId] && {
                    workspaceDockFocus: { ...state.workspaceDockFocus, [connectionId]: null },
                }),
                paneLayouts: {
                    ...state.paneLayouts,
                    [connectionId]: { ...(groups ?? {}), [owner]: next },
                },
                activeTerminalIds: termId
                    ? { ...state.activeTerminalIds, [connectionId]: termId }
                    : state.activeTerminalIds,
                activePaneGroupOwner: {
                    ...state.activePaneGroupOwner,
                    [connectionId]: owner,
                },
            };
        });
        scheduleSaveSession(() => get().saveSession());
    },

    /** Scope navigation to an explicit canvas and retain its owner through visible focus repair. */
    focusPaneInDirection: (connectionId, direction, targetPaneId, layoutOwner) => {
        const state = get();
        const activeId = state.activeTerminalIds[connectionId];
        const groups = state.paneLayouts[connectionId];
        const owner =
            layoutOwner ??
            resolveDockOwner(
                groups,
                activeId,
                targetPaneId,
                state.activePaneGroupOwner[connectionId],
            );
        const layout = owner ? groups?.[owner] : undefined;
        if (!owner || !layout || !isSplitLayout(layout)) {
            return false;
        }
        const projected = visibleLayout(state, connectionId, layout);
        if (!projected) {
            return false;
        }
        if (targetPaneId !== undefined) {
            const target = findNode(projected.root, targetPaneId);
            if (!target || !isPaneLeaf(target)) {
                return false;
            }
        }
        const visible =
            targetPaneId === undefined ? projected : focusPaneInLayout(projected, targetPaneId);
        const needsFocusRepair = visible.activePaneId !== layout.activePaneId;
        if (!isSplitLayout(visible)) {
            if (needsFocusRepair) {
                get().focusPane(connectionId, visible.activePaneId, owner);
            }
            return needsFocusRepair;
        }
        const nextId = neighborPaneId(visible, direction);
        // Repair determines the origin, not a separate keystroke. Commit once to
        // its neighbor, or to the repaired origin when the requested edge is empty.
        if (nextId || needsFocusRepair) {
            get().focusPane(connectionId, nextId ?? visible.activePaneId, owner);
        }
        return true;
    },

    openFeatureInSplit: (connectionId, featureId, edge = 'right') => {
        return get().dockInSplit(connectionId, { kind: 'feature', featureId }, edge);
    },

    /** Plan a content move or permitted clone, then commit topology, allocation and focus together. */
    dockInSplit: (
        connectionId,
        payload,
        edge,
        targetPaneId,
        canvasTermId,
        targetContent,
        launch,
    ) => {
        const state = get();
        // Planning must not create file-listing state before the complete topology
        // passes the connection-wide reservation check.
        const pendingFilesCopies: Array<[string | undefined, string | undefined]> = [];
        /** Seed queued Files listings only after the docking plan passes admission. */
        const copyPlannedListings = () => {
            for (const [from, to] of pendingFilesCopies) {
                get().copyFilesListing(connectionId, from, to);
            }
        };
        if (allContentHidden(state, connectionId)) {
            return 'no-target';
        }
        const existingTabs = state.terminals[connectionId] || [];
        if (
            launch &&
            (payload.kind !== 'term' ||
                payload.sourcePaneId ||
                existingTabs.some((tab) => tab.id === payload.termId))
        ) {
            return 'no-target';
        }
        const created =
            launch && payload.kind === 'term'
                ? {
                      id: payload.termId,
                      title:
                          launch.title ??
                          (launch.isSynced ? 'Synced Terminal' : nextShellTitle(existingTabs)),
                      initialPath: launch.initialPath,
                      lastKnownCwd: launch.initialPath,
                      shellOverride: launch.shellOverride,
                      isSynced: launch.isSynced ?? false,
                      tabVisible: false,
                  }
                : undefined;
        // The pending tab participates in planning only. commitDockPlan publishes
        // it after topology, allocation and destination guards have all passed.
        const tabs = created ? [...existingTabs, created] : existingTabs;
        const groups = state.paneLayouts[connectionId];
        const canvases = workspaceCanvases(tabs, groups);
        const requested =
            targetPaneId ??
            (state.workspaceDockFocus?.[connectionId]
                ? { contentId: state.workspaceDockFocus[connectionId]! }
                : undefined);
        const isOverlay = typeof requested === 'string' && requested.startsWith('overlay:');
        const exactTarget =
            requested && !isOverlay ? findWorkspacePane(canvases, requested) : undefined;
        if (requested && !isOverlay && !exactTarget) {
            return 'no-target';
        }
        const requestedPaneId =
            exactTarget?.leaf.id ?? (typeof requested === 'string' ? requested : undefined);
        const standaloneTargetId =
            requestedPaneId &&
            tabs.some((tab) => tab.id === requestedPaneId) &&
            !findLayoutOwner(groups, requestedPaneId)
                ? requestedPaneId
                : undefined;
        const owner =
            exactTarget?.owner ??
            standaloneTargetId ??
            resolveDockOwner(
                groups,
                canvasTermId ?? state.activeTerminalIds[connectionId],
                requestedPaneId,
                state.activePaneGroupOwner[connectionId],
            ) ??
            tabs.find(isTabVisible)?.id ??
            WORKSPACE_PANE_OWNER;
        // An omitted target means the focused pane, including a standalone shell.
        // Resolve it before deciding whether this request moves or clones content.
        const implicitTargetLayout =
            !groups?.[owner] &&
            tabs.some((tab) => tab.id === owner) &&
            (!requestedPaneId || standaloneTargetId)
                ? singlePane(owner, standaloneTargetId)
                : undefined;
        const canonicalTargetLayout = groups?.[owner] ?? implicitTargetLayout;
        const projectedTarget = canonicalTargetLayout
            ? visibleLayout(state, connectionId, canonicalTargetLayout)
            : undefined;
        if (canonicalTargetLayout && !projectedTarget) {
            return 'no-target';
        }
        const explicitTarget =
            requestedPaneId && canonicalTargetLayout
                ? findNode(canonicalTargetLayout.root, requestedPaneId)
                : undefined;
        if (
            requestedPaneId &&
            !requestedPaneId.startsWith('overlay:') &&
            (!explicitTarget || !isPaneLeaf(explicitTarget))
        ) {
            return 'no-target';
        }
        if (
            explicitTarget &&
            isPaneLeaf(explicitTarget) &&
            isContentHidden(state, connectionId, explicitTarget.content, explicitTarget.id)
        ) {
            return 'no-target';
        }
        if (
            targetContent &&
            isContentHidden(state, connectionId, targetContent, requestedPaneId ?? '')
        ) {
            return 'no-target';
        }
        if (targetContent && targetContent.kind !== 'term' && !targetContent.instanceId) {
            const legacyTargets = Object.values(groups ?? {})
                .flatMap((group) => collectLeaves(group.root))
                .filter(
                    (pane) =>
                        pane.content.kind === targetContent.kind &&
                        !pane.content.instanceId &&
                        (isFeatureContent(pane.content) && isFeatureContent(targetContent)
                            ? pane.content.featureId === targetContent.featureId
                            : isPluginContent(pane.content) &&
                              isPluginContent(targetContent) &&
                              pane.content.pluginId === targetContent.pluginId),
                );
            if (
                legacyTargets.length > 0 &&
                legacyTargets.every((pane) =>
                    isContentHidden(state, connectionId, pane.content, pane.id),
                )
            ) {
                return 'no-target';
            }
        }
        const paneId = requestedPaneId ?? projectedTarget?.activePaneId;
        const resolvedSource = workspacePaneForDockPayload(canvases, payload);
        if (!resolvedSource.ok) {
            return 'no-target';
        }
        const sourceLocation = resolvedSource.pane;
        const sourcePaneId = sourceLocation?.leaf.id;
        const sourceOwner = sourceLocation?.owner;
        const source = sourceLocation?.leaf;
        if (
            source &&
            isPaneLeaf(source) &&
            isContentHidden(state, connectionId, source.content, source.id)
        ) {
            return 'no-target';
        }
        if (
            payload.kind === 'term' &&
            isContentHidden(state, connectionId, termPaneContent(payload.termId), payload.termId)
        ) {
            return 'no-target';
        }

        const targetLeaf =
            explicitTarget?.type === 'pane'
                ? explicitTarget
                : projectedTarget &&
                  collectLeaves(projectedTarget.root).find((leaf) => leaf.id === paneId);
        const targetKey = targetLeaf ? paneContentKey(targetLeaf.content, targetLeaf.id) : '';
        const selfTarget = Boolean(
            source && targetLeaf && paneContentKey(source.content, source.id) === targetKey,
        );

        /** Publish resource topology, allocation and focus together after all guards pass. */
        const commitDockPlan = (
            nextGroups: PaneLayoutGroups,
            nextTabs: TerminalTab[],
            nextOwner: string,
            incomingId: string,
            centerTerminalId = state.activeTerminalIds[connectionId],
        ): DockResult | null => {
            const allocation = dockingBesideTarget(
                state.workspaceDocking,
                connectionId,
                targetKey,
                incomingId,
            );
            /** Discard tentative split animation markers before returning a rejected docking result. */
            const refuse = (reason: DockResult) => {
                discardPlannedSplitIntros(state, connectionId, nextGroups);
                return reason;
            };
            if (!allocation.ok) {
                return refuse('no-target');
            }
            const destination = allocation.value[connectionId]?.placements[incomingId];
            const priorRegion = state.workspaceDocking?.[connectionId]?.placements[incomingId];
            if (
                (destination || priorRegion) &&
                (!state.sessionLoaded || state.isRestoring || state.sessionPersistenceBlocked)
            ) {
                return refuse('no-target');
            }
            const incoming = findWorkspacePane(workspaceCanvases(nextTabs, nextGroups), {
                contentId: incomingId,
            });
            if (!incoming) {
                return refuse('no-target');
            }
            if (
                destination &&
                !registrationForContent(
                    state.workspaceViewRegistry,
                    incoming.leaf.content,
                )?.allowedLocations.includes(destination)
            ) {
                return refuse('no-target');
            }
            if (
                !acceptsDockingTopology(
                    { ...state, workspaceDocking: allocation.value },
                    connectionId,
                    nextTabs,
                    nextGroups,
                )
            ) {
                return 'refused-cap';
            }
            if (destination) {
                const previous = groups?.[nextOwner]?.activePaneId;
                if (previous && findNode(nextGroups[nextOwner].root, previous)?.type === 'pane') {
                    nextGroups = {
                        ...nextGroups,
                        [nextOwner]: { ...nextGroups[nextOwner], activePaneId: previous },
                    };
                }
            }
            const selectedOwner = state.activePaneGroupOwner[connectionId];
            const retainedOwner =
                selectedOwner && nextGroups[selectedOwner]
                    ? selectedOwner
                    : sourceOwner === selectedOwner && sourceLocation
                      ? (collectLeaves(sourceLocation.layout.root)
                            .map((leaf) =>
                                findWorkspacePane(workspaceCanvases(nextTabs, nextGroups), {
                                    contentId: paneContentKey(leaf.content, leaf.id),
                                }),
                            )
                            .find((found) => found && found.owner !== nextOwner)?.owner ?? null)
                      : null;
            copyPlannedListings();
            set({
                terminals: { ...state.terminals, [connectionId]: nextTabs },
                paneLayouts: writeConnectionGroups(state.paneLayouts, connectionId, nextGroups),
                ...(created?.isSynced && {
                    syncedTerminalId: { ...state.syncedTerminalId, [connectionId]: created.id },
                }),
                ...((destination || priorRegion) && { workspaceDocking: allocation.value }),
                workspaceDockFocus: {
                    ...state.workspaceDockFocus,
                    [connectionId]: destination ? incomingId : null,
                },
                activePaneGroupOwner: {
                    ...state.activePaneGroupOwner,
                    [connectionId]: destination ? retainedOwner : nextOwner,
                },
                activeTerminalIds: destination
                    ? state.activeTerminalIds
                    : centerTerminalId
                      ? { ...state.activeTerminalIds, [connectionId]: centerTerminalId }
                      : state.activeTerminalIds,
            });
            scheduleSaveSession(() => get().saveSession());
            if (created) {
                track('terminal');
            }
            return null;
        };

        // Dropping onto another pane relocates that exact pane. Dropping back
        // onto itself (an edge of the same pane) still splits on self.
        if (sourcePaneId && paneId && !selfTarget) {
            const sourceLayout = sourceLocation?.layout;
            if (sourceOwner && sourceLayout) {
                const sourceNode = findNode(sourceLayout.root, sourcePaneId);
                if (!sourceNode || !isPaneLeaf(sourceNode)) {
                    return 'no-target';
                }
                const withoutSource = isSplitLayout(sourceLayout)
                    ? unsplitPane(sourceLayout, sourcePaneId)
                    : null;
                let targetLayout =
                    sourceOwner === owner
                        ? withoutSource
                        : (groups?.[owner] ?? implicitTargetLayout);
                if (!targetLayout && owner === WORKSPACE_PANE_OWNER && targetContent) {
                    if (targetContent.kind === 'feature') {
                        const instanceId =
                            targetContent.instanceId ??
                            newFeatureInstanceId(targetContent.featureId);
                        if (targetContent.featureId === 'files' && !targetContent.instanceId) {
                            pendingFilesCopies.push([undefined, instanceId]);
                        }
                        targetLayout = singleFeaturePane(
                            targetContent.featureId,
                            undefined,
                            instanceId,
                        );
                    } else if (targetContent.kind === 'plugin') {
                        targetLayout = singlePluginPane(
                            targetContent.pluginId,
                            undefined,
                            targetContent.instanceId,
                        );
                    } else if (targetContent.kind === 'term') {
                        targetLayout = singlePane(targetContent.termId);
                    }
                }
                if (!targetLayout) {
                    return 'no-target';
                }
                // Local leaf IDs may collide across canvases. Modern content keeps
                // its stable instance identity if its container needs a fresh ID.
                let incomingPaneId = sourcePaneId;
                if (findNode(targetLayout.root, incomingPaneId)) {
                    if (sourceNode.content.kind !== 'term' && !sourceNode.content.instanceId) {
                        return 'no-target';
                    }
                    incomingPaneId = `pane-${crypto.randomUUID()}`;
                }
                const moved = dockIntoLayout(
                    targetLayout,
                    sourceNode.content,
                    edge,
                    undefined,
                    paneId,
                    incomingPaneId,
                );
                if (!moved.ok) {
                    return moved.reason === 'cap' ? 'refused-cap' : 'no-target';
                }

                if (sourceOwner !== owner) {
                    const remainingTerms = withoutSource ? visibleTermIds(withoutSource) : [];
                    const keepSourceGroup = isKeepableRemainder(withoutSource);
                    const candidateOwner =
                        keepSourceGroup && withoutSource
                            ? ownerForLayout(withoutSource, sourceOwner)
                            : null;
                    const nextSourceOwner =
                        candidateOwner &&
                        candidateOwner !== sourceOwner &&
                        (candidateOwner === owner ||
                            Object.prototype.hasOwnProperty.call(groups ?? {}, candidateOwner))
                            ? sourceOwner
                            : candidateOwner;
                    const nextGroups: PaneLayoutGroups = {};
                    for (const [groupOwner, groupLayout] of Object.entries(groups ?? {})) {
                        if (groupOwner === sourceOwner) {
                            if (nextSourceOwner && withoutSource) {
                                nextGroups[nextSourceOwner] = withoutSource;
                            }
                            continue;
                        }
                        nextGroups[groupOwner] = groupOwner === owner ? moved.layout : groupLayout;
                    }
                    nextGroups[owner] = moved.layout;
                    const releasedTerms = keepSourceGroup
                        ? new Set<string>()
                        : new Set(remainingTerms);
                    const movedTermId =
                        sourceNode.content.kind === 'term' ? sourceNode.content.termId : null;
                    const nextTabs = tabs.map((tab) => {
                        if (tab.id === movedTermId) {
                            return { ...tab, tabVisible: owner === WORKSPACE_PANE_OWNER };
                        }
                        if (tab.id === nextSourceOwner || releasedTerms.has(tab.id)) {
                            return { ...tab, tabVisible: true };
                        }
                        return tab;
                    });
                    const refused = commitDockPlan(
                        nextGroups,
                        nextTabs,
                        owner,
                        paneContentKey(sourceNode.content, moved.paneId),
                        layoutActiveTermId(moved.layout),
                    );
                    if (refused) {
                        return refused;
                    }
                    return 'moved';
                }

                const refused = commitDockPlan(
                    { ...(groups ?? {}), [owner]: moved.layout },
                    tabs,
                    owner,
                    paneContentKey(sourceNode.content, moved.paneId),
                    sourceNode.content.kind === 'term'
                        ? sourceNode.content.termId
                        : state.activeTerminalIds[connectionId],
                );
                if (refused) {
                    return refused;
                }
                return 'moved';
            }
        }

        if (payload.kind === 'term') {
            if (!tabs.some((tab) => tab.id === payload.termId)) {
                return 'no-target';
            }
            const selfDock = sameGroupTermDock(groups, owner, payload.termId);
            let targetLayout = groups?.[owner] ?? implicitTargetLayout;
            if (!targetLayout && targetContent?.kind === 'feature') {
                const instanceId =
                    targetContent.instanceId ?? newFeatureInstanceId(targetContent.featureId);
                if (targetContent.featureId === 'files' && !targetContent.instanceId) {
                    pendingFilesCopies.push([undefined, instanceId]);
                }
                targetLayout = singleFeaturePane(targetContent.featureId, undefined, instanceId);
            } else if (!targetLayout && targetContent?.kind === 'plugin') {
                targetLayout = singlePluginPane(
                    targetContent.pluginId,
                    undefined,
                    targetContent.instanceId,
                );
            } else if (!targetLayout && owner !== WORKSPACE_PANE_OWNER) {
                targetLayout = singlePane(owner);
            }
            if (!targetLayout) {
                return 'no-target';
            }
            if (!canSplit(targetLayout)) {
                return 'refused-cap';
            }

            // A tab dropped back onto a pane in its own layout means "split this
            // shell here". One PTY cannot be mounted twice, so create a sibling
            // shell with the same launch context and keep it off the tab bar.
            if (selfDock) {
                const sourceTab = tabs.find((tab) => tab.id === payload.termId);
                if (!sourceTab) {
                    return 'no-target';
                }
                const duplicateId = `term-${crypto.randomUUID()}`;
                const docked = dockIntoLayout(
                    targetLayout,
                    termPaneContent(duplicateId),
                    edge,
                    undefined,
                    paneId,
                );
                if (!docked.ok) {
                    return docked.reason === 'cap' ? 'refused-cap' : 'no-target';
                }
                const duplicate: TerminalTab = {
                    id: duplicateId,
                    title: nextShellTitle(tabs),
                    tabVisible: false,
                    shellOverride: sourceTab.shellOverride,
                    initialPath: sourceTab.lastKnownCwd ?? sourceTab.initialPath,
                    lastKnownCwd: sourceTab.lastKnownCwd,
                };
                const refused = commitDockPlan(
                    { ...(groups ?? {}), [owner]: docked.layout },
                    [...tabs, duplicate],
                    owner,
                    paneContentKey(termPaneContent(duplicateId), docked.paneId),
                    duplicateId,
                );
                if (refused) {
                    return refused;
                }
                return 'opened';
            }

            const detached = detachTermFromGroups(groups, payload.termId);
            const groupsNext: PaneLayoutGroups = { ...(detached.next ?? {}) };
            const docked = dockIntoLayout(
                groupsNext[owner] ?? targetLayout,
                termPaneContent(payload.termId),
                edge,
                undefined,
                paneId,
            );
            if (!docked.ok) {
                return docked.reason === 'cap' ? 'refused-cap' : 'no-target';
            }
            if (paneId?.startsWith('overlay:') && isPaneSplit(docked.layout.root)) {
                dropSplitIntro(docked.layout.root.id);
            }
            const nextOwner = owner === WORKSPACE_PANE_OWNER ? payload.termId : owner;
            if (nextOwner !== owner) {
                delete groupsNext[owner];
            }
            groupsNext[nextOwner] = docked.layout;

            const nextTabs = tabs.map((tab) => {
                if (tab.id === payload.termId) {
                    return { ...tab, tabVisible: owner === WORKSPACE_PANE_OWNER };
                }
                if (detached.nextOwner && tab.id === detached.nextOwner) {
                    return { ...tab, tabVisible: true };
                }
                return tab;
            });

            const refused = commitDockPlan(
                groupsNext,
                nextTabs,
                nextOwner,
                paneContentKey(termPaneContent(payload.termId), docked.paneId),
                payload.termId,
            );
            if (refused) {
                return refused;
            }
            return 'moved';
        }

        const existingLayout = groups?.[owner];
        let layout = existingLayout ?? implicitTargetLayout;
        let seededFromPluginPayload = false;
        if (!layout) {
            // A split command from a shell tab must start with that shell as the
            // canvas. Starting with the incoming feature/plugin would duplicate
            // it (Files | Files) and leave the shell stranded in the tab bar.
            if (owner !== WORKSPACE_PANE_OWNER && tabs.some((tab) => tab.id === owner)) {
                layout = singlePane(owner);
            } else if (targetContent?.kind === 'feature') {
                const baseInstanceId =
                    targetContent.instanceId ?? newFeatureInstanceId(targetContent.featureId);
                if (targetContent.featureId === 'files' && !targetContent.instanceId) {
                    pendingFilesCopies.push([undefined, baseInstanceId]);
                }
                layout = singleFeaturePane(targetContent.featureId, undefined, baseInstanceId);
            } else if (targetContent?.kind === 'plugin') {
                layout = singlePluginPane(
                    targetContent.pluginId,
                    undefined,
                    targetContent.instanceId,
                );
            } else if (payload.kind === 'plugin') {
                layout = singlePluginPane(payload.pluginId, undefined, payload.instanceId);
                seededFromPluginPayload = true;
            } else if (payload.kind === 'feature') {
                const baseInstanceId =
                    payload.instanceId ?? newFeatureInstanceId(payload.featureId);
                if (payload.featureId === 'files') {
                    if (!payload.instanceId) {
                        pendingFilesCopies.push([undefined, baseInstanceId]);
                    }
                    layout = singleFeaturePane('files', undefined, baseInstanceId);
                } else {
                    layout = singleFeaturePane(payload.featureId, undefined, baseInstanceId);
                }
            } else if (owner !== WORKSPACE_PANE_OWNER) {
                layout = singlePane(owner);
            }
        }
        if (!layout) {
            return 'no-target';
        }
        if (!canSplit(layout)) {
            return 'refused-cap';
        }
        const duplicateFeature =
            payload.kind === 'feature' &&
            (selfTarget ||
                (!existingLayout &&
                    targetContent?.kind === 'feature' &&
                    targetContent.featureId === payload.featureId &&
                    targetContent.instanceId === payload.instanceId));
        const duplicatePlugin =
            payload.kind === 'plugin' &&
            (seededFromPluginPayload ||
                selfTarget ||
                (!existingLayout &&
                    targetContent?.kind === 'plugin' &&
                    targetContent.pluginId === payload.pluginId &&
                    targetContent.instanceId === payload.instanceId));
        if (
            payload.kind === 'plugin' &&
            (duplicatePlugin ||
                (!payload.instanceId &&
                    Object.values(groups ?? {}).some((group) =>
                        collectLeaves(group.root).some(
                            (leaf) =>
                                isPluginContent(leaf.content) &&
                                leaf.content.pluginId === payload.pluginId,
                        ),
                    ))) &&
            !permitsPluginDuplicate(state, payload)
        ) {
            return 'no-target';
        }
        let content =
            payload.kind === 'plugin'
                ? pluginPaneContent(
                      payload.pluginId,
                      duplicatePlugin ? undefined : payload.instanceId,
                  )
                : featurePaneContent(
                      payload.featureId,
                      duplicateFeature
                          ? newFeatureInstanceId(payload.featureId)
                          : (payload.instanceId ?? newFeatureInstanceId(payload.featureId)),
                  );
        if (content.kind === 'feature' && content.featureId === 'files') {
            const focused = findNode(layout.root, layout.activePaneId) ?? firstLeaf(layout.root);
            const fromInstance =
                payload.kind === 'feature' && payload.featureId === 'files' && payload.instanceId
                    ? payload.instanceId
                    : isPaneLeaf(focused) &&
                        focused.content.kind === 'feature' &&
                        focused.content.featureId === 'files'
                      ? focused.content.instanceId
                      : undefined;
            if (content.instanceId !== fromInstance) {
                pendingFilesCopies.push([fromInstance, content.instanceId]);
            }
        }
        const docked = dockIntoLayout(layout, content, edge, undefined, paneId);
        if (!docked.ok) {
            return docked.reason === 'cap' ? 'refused-cap' : 'no-target';
        }
        if (paneId?.startsWith('overlay:') && isPaneSplit(docked.layout.root)) {
            dropSplitIntro(docked.layout.root.id);
        }
        const refused = commitDockPlan(
            { ...(groups ?? {}), [owner]: docked.layout },
            tabs,
            owner,
            paneContentKey(content, docked.paneId),
        );
        if (refused) {
            return refused;
        }
        if (docked.created) {
            track('split');
            if (content.kind === 'feature' && content.featureId === 'files') {
                track('split_files');
            }
        }
        return docked.created ? 'opened' : 'focused';
    },

    /** Remove the selected feature from its canvas and dispose resources no longer owned. */
    closeFeatureInSplit: (connectionId, featureId) => {
        const before = connectionContents(get(), connectionId);
        set((state) => {
            const activeId = state.activeTerminalIds[connectionId];
            const groups = state.paneLayouts[connectionId];
            const owner = resolveDockOwner(
                groups,
                activeId,
                undefined,
                state.activePaneGroupOwner[connectionId],
            );
            const layout = owner ? groups?.[owner] : undefined;
            if (!owner || !layout) {
                return state;
            }
            const dropped = dropFeature(layout, featureId);
            if (dropped === layout) {
                return state;
            }
            const nextGroups: PaneLayoutGroups = { ...(groups ?? {}) };
            delete nextGroups[owner];
            let nextOwner: string | null = null;
            if (isKeepableRemainder(dropped)) {
                nextOwner = ownerForLayout(dropped, owner);
                nextGroups[nextOwner] = dropped;
            }
            const remainingTerm = dropped ? layoutActiveTermId(dropped) : activeId;
            return {
                activePaneGroupOwner: { ...state.activePaneGroupOwner, [connectionId]: nextOwner },
                terminals: {
                    ...state.terminals,
                    [connectionId]: (state.terminals[connectionId] ?? []).map((tab) =>
                        !nextOwner && tab.id === remainingTerm ? { ...tab, tabVisible: true } : tab,
                    ),
                },
                paneLayouts: writeConnectionGroups(
                    state.paneLayouts,
                    connectionId,
                    Object.keys(nextGroups).length > 0 ? nextGroups : undefined,
                ),
                activeTerminalIds: remainingTerm
                    ? { ...state.activeTerminalIds, [connectionId]: remainingTerm }
                    : state.activeTerminalIds,
            };
        });
        forgetClosedContent(get, connectionId, before);
        scheduleSaveSession(() => get().saveSession());
    },

    /** Remove the selected plugin from its canvas through the shared closure lifecycle. */
    closePluginInSplit: (connectionId, pluginId) => {
        const before = connectionContents(get(), connectionId);
        set((state) => {
            const activeId = state.activeTerminalIds[connectionId];
            const groups = state.paneLayouts[connectionId];
            const owner = resolveDockOwner(
                groups,
                activeId,
                undefined,
                state.activePaneGroupOwner[connectionId],
            );
            const layout = owner ? groups?.[owner] : undefined;
            if (!owner || !layout) {
                return state;
            }
            const dropped = dropPlugin(layout, pluginId);
            if (dropped === layout) {
                return state;
            }
            const nextGroups: PaneLayoutGroups = { ...(groups ?? {}) };
            delete nextGroups[owner];
            let nextOwner: string | null = null;
            if (isKeepableRemainder(dropped)) {
                nextOwner = ownerForLayout(dropped, owner);
                nextGroups[nextOwner] = dropped;
            }
            const remainingTerm = dropped ? layoutActiveTermId(dropped) : activeId;
            return {
                activePaneGroupOwner: { ...state.activePaneGroupOwner, [connectionId]: nextOwner },
                terminals: {
                    ...state.terminals,
                    [connectionId]: (state.terminals[connectionId] ?? []).map((tab) =>
                        !nextOwner && tab.id === remainingTerm ? { ...tab, tabVisible: true } : tab,
                    ),
                },
                paneLayouts: writeConnectionGroups(
                    state.paneLayouts,
                    connectionId,
                    Object.keys(nextGroups).length > 0 ? nextGroups : undefined,
                ),
                activeTerminalIds: remainingTerm
                    ? { ...state.activeTerminalIds, [connectionId]: remainingTerm }
                    : state.activeTerminalIds,
            };
        });
        forgetClosedContent(get, connectionId, before);
        scheduleSaveSession(() => get().saveSession());
    },

    /** Return an existing pane to its own center canvas without recreating or disposing its resource. */
    releasePaneFromSplit: (connectionId, requestedTarget, insertion) => {
        const state = get();
        const groups = state.paneLayouts[connectionId];
        const target = findWorkspacePane(
            workspaceCanvases(state.terminals[connectionId] ?? [], groups),
            requestedTarget,
        );
        if (!target) {
            return false;
        }
        const contentId = paneContentKey(target.leaf.content, target.leaf.id);
        if (state.contentPresentation?.[connectionId]?.items[contentId]?.hidden) {
            return false;
        }
        let presentationPatch: Partial<AppStore> = {};
        if (insertion) {
            if (
                !state.sessionLoaded ||
                state.isRestoring ||
                state.sessionPersistenceBlocked ||
                !isPresentationScopeId(connectionId) ||
                insertion.source.contentId !== contentId ||
                !parseContentPresentation(state.contentPresentation).ok
            ) {
                return false;
            }
            const scope = state.contentPresentation[connectionId];
            if (
                !scope &&
                Object.keys(state.contentPresentation).length >= MAX_PRESENTATION_SCOPES
            ) {
                return false;
            }
            const order = planPaneTabInsertion(
                state.terminals[connectionId] ?? [],
                groups,
                scope,
                insertion,
            );
            if (!order) {
                return false;
            }
            presentationPatch = {
                contentPresentation: {
                    ...state.contentPresentation,
                    [connectionId]: {
                        version: CONTENT_PRESENTATION_VERSION,
                        items: scope?.items ?? {},
                        order,
                    },
                },
            };
        }
        const allocation = withoutWorkspaceDocking(
            state.workspaceDocking,
            connectionId,
            new Set([contentId]),
        );
        if (!allocation.ok) {
            return false;
        }
        const wasDocked = Boolean(state.workspaceDocking?.[connectionId]?.placements?.[contentId]);
        if (
            wasDocked &&
            (!state.sessionLoaded || state.isRestoring || state.sessionPersistenceBlocked)
        ) {
            return false;
        }
        if (wasDocked && !isSplitLayout(target.layout)) {
            if (
                !allowsDockingTopology(
                    { workspaceDocking: allocation.value },
                    connectionId,
                    state.terminals[connectionId] ?? [],
                    groups,
                )
            ) {
                return false;
            }
            const termId = isTermContent(target.leaf.content)
                ? target.leaf.content.termId
                : undefined;
            const revealShell =
                termId !== undefined &&
                state.terminals[connectionId]?.some((tab) => tab.id === termId && !tab.tabVisible);
            // A single-pane canvas has no tree to detach. Release its region
            // allocation and select the same resource without rebuilding hosts.
            set({
                ...presentationPatch,
                workspaceDocking: allocation.value,
                workspaceDockFocus: { ...state.workspaceDockFocus, [connectionId]: null },
                activePaneGroupOwner: {
                    ...state.activePaneGroupOwner,
                    [connectionId]: groups?.[target.owner] ? target.owner : null,
                },
                ...(termId !== undefined && {
                    activeTerminalIds: { ...state.activeTerminalIds, [connectionId]: termId },
                }),
                ...(revealShell && {
                    terminals: {
                        ...state.terminals,
                        [connectionId]: state.terminals[connectionId].map((tab) =>
                            tab.id === termId ? { ...tab, tabVisible: true } : tab,
                        ),
                    },
                }),
            });
            scheduleSaveSession(() => get().saveSession());
            return true;
        }
        const result = releasePaneFromGroups(groups, target.leaf.id, target.owner);
        if (!result) {
            return false;
        }
        const visible = new Set(result.visibleTermIds);
        const terminals = (state.terminals[connectionId] ?? []).map((tab) =>
            visible.has(tab.id) ? { ...tab, tabVisible: true } : tab,
        );
        if (
            !allowsDockingTopology(
                { workspaceDocking: allocation.value },
                connectionId,
                terminals,
                result.groups,
            )
        ) {
            return false;
        }
        // Ungroup returns this same resource to its own center tab. Placement and
        // focus change together; no disposal, listing copy or editor-close guard.
        set({
            ...presentationPatch,
            paneLayouts: writeConnectionGroups(state.paneLayouts, connectionId, result.groups),
            terminals: { ...state.terminals, [connectionId]: terminals },
            ...(wasDocked && { workspaceDocking: allocation.value }),
            workspaceDockFocus: { ...state.workspaceDockFocus, [connectionId]: null },
            activePaneGroupOwner: {
                ...state.activePaneGroupOwner,
                [connectionId]: result.releasedOwner,
            },
            activeTerminalIds: isTermContent(result.released.content)
                ? { ...state.activeTerminalIds, [connectionId]: result.released.content.termId }
                : state.activeTerminalIds,
        });
        scheduleSaveSession(() => get().saveSession());
        return true;
    },

    /** Close an exact guarded pane while preserving surviving content and resource identity. */
    closePaneInSplit: (connectionId, requestedTarget) => {
        const state = get();
        const before = connectionContents(state, connectionId);
        const groups = state.paneLayouts[connectionId];
        const target = findWorkspacePane(
            workspaceCanvases(state.terminals[connectionId] ?? [], groups),
            requestedTarget,
        );
        if (!target) {
            return false;
        }
        const { leaf: node } = target;
        if (isPaneCloseBlocked(paneCloseScope(connectionId, node.content))) {
            get().showToast('warning', 'Close the unsaved editor before closing this pane.');
            return false;
        }
        const contentId = paneContentKey(node.content, node.id);
        const releaseDock =
            isTermContent(node.content) &&
            Boolean(state.workspaceDocking?.[connectionId]?.placements?.[contentId]);
        let allocationPatch: Partial<AppStore> = {};
        if (releaseDock) {
            if (!state.sessionLoaded || state.isRestoring || state.sessionPersistenceBlocked) {
                return false;
            }
            const allocation = withoutWorkspaceDocking(
                state.workspaceDocking,
                connectionId,
                new Set([contentId]),
            );
            if (!allocation.ok) {
                return false;
            }
            allocationPatch = {
                workspaceDocking: allocation.value,
                ...(state.workspaceDockFocus[connectionId] === contentId && {
                    workspaceDockFocus: { ...state.workspaceDockFocus, [connectionId]: null },
                }),
            };
        }
        if (!groups?.[target.owner]) {
            // The existing pane-close contract releases shells to their tab; it
            // does not terminate the PTY. A standalone dock must also lose its
            // allocation, otherwise closing its header would leave it displayed.
            if (!releaseDock || !isTermContent(node.content)) {
                return false;
            }
            const termId = node.content.termId;
            set({
                ...allocationPatch,
                terminals: {
                    ...state.terminals,
                    [connectionId]: (state.terminals[connectionId] ?? []).map((tab) =>
                        tab.id === termId ? { ...tab, tabVisible: true } : tab,
                    ),
                },
            });
            scheduleSaveSession(() => get().saveSession());
            return true;
        }
        set((state) => {
            const groups = state.paneLayouts[connectionId];
            const current = findWorkspacePane(
                workspaceCanvases(state.terminals[connectionId] ?? [], groups),
                requestedTarget,
            );
            if (!current || !groups?.[current.owner]) {
                return state;
            }
            const { owner, layout, leaf: node } = current;
            const paneId = node.id;
            const closingTermId = isTermContent(node.content) ? node.content.termId : null;
            if (isPaneLeaf(layout.root)) {
                const nextGroups = { ...(groups ?? {}) };
                delete nextGroups[owner];
                const nextTabs = closingTermId
                    ? (state.terminals[connectionId] || []).map((tab) =>
                          tab.id === closingTermId ? { ...tab, tabVisible: true } : tab,
                      )
                    : state.terminals[connectionId] || [];
                return {
                    ...allocationPatch,
                    terminals: { ...state.terminals, [connectionId]: nextTabs },
                    paneLayouts: writeConnectionGroups(
                        state.paneLayouts,
                        connectionId,
                        Object.keys(nextGroups).length > 0 ? nextGroups : undefined,
                    ),
                    activePaneGroupOwner:
                        state.activePaneGroupOwner[connectionId] === owner
                            ? { ...state.activePaneGroupOwner, [connectionId]: null }
                            : state.activePaneGroupOwner,
                };
            }
            const dropped = unsplitPane(layout, paneId);
            const releasedTermIds = new Set(closingTermId ? [closingTermId] : []);
            if (!isSplitLayout(dropped)) {
                for (const termId of visibleTermIds(dropped)) {
                    releasedTermIds.add(termId);
                }
            }
            const nextTabs =
                releasedTermIds.size > 0
                    ? (state.terminals[connectionId] || []).map((tab) =>
                          releasedTermIds.has(tab.id) ? { ...tab, tabVisible: true } : tab,
                      )
                    : state.terminals[connectionId] || [];
            const nextGroups: PaneLayoutGroups = { ...(groups ?? {}) };
            delete nextGroups[owner];
            let nextActiveTermId = state.activeTerminalIds[connectionId] ?? null;
            let nextLayoutOwner: string | null = null;
            if (isSplitLayout(dropped)) {
                const remainingTerms = visibleTermIds(dropped);
                const candidateOwner = ownerForLayout(dropped, owner);
                const nextOwner = Object.prototype.hasOwnProperty.call(nextGroups, candidateOwner)
                    ? owner
                    : candidateOwner;
                nextGroups[nextOwner] = dropped;
                nextLayoutOwner = nextOwner;
                if (
                    state.activePaneGroupOwner[connectionId] === owner &&
                    remainingTerms.length > 0 &&
                    (!nextActiveTermId || !remainingTerms.includes(nextActiveTermId))
                ) {
                    nextActiveTermId = remainingTerms[0];
                }
            } else if (
                dropped &&
                isPaneLeaf(dropped.root) &&
                !isTermContent(dropped.root.content)
            ) {
                const candidateOwner = ownerForLayout(dropped, owner);
                const nextOwner = Object.prototype.hasOwnProperty.call(nextGroups, candidateOwner)
                    ? owner
                    : candidateOwner;
                nextGroups[nextOwner] = dropped;
                nextLayoutOwner = nextOwner;
            }
            return {
                ...allocationPatch,
                terminals: { ...state.terminals, [connectionId]: nextTabs },
                paneLayouts: writeConnectionGroups(
                    state.paneLayouts,
                    connectionId,
                    Object.keys(nextGroups).length > 0 ? nextGroups : undefined,
                ),
                activeTerminalIds: nextActiveTermId
                    ? { ...state.activeTerminalIds, [connectionId]: nextActiveTermId }
                    : state.activeTerminalIds,
                activePaneGroupOwner:
                    state.activePaneGroupOwner[connectionId] === owner
                        ? { ...state.activePaneGroupOwner, [connectionId]: nextLayoutOwner }
                        : state.activePaneGroupOwner,
            };
        });
        forgetClosedContent(get, connectionId, before);
        scheduleSaveSession(() => get().saveSession());
        return true;
    },
});
