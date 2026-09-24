import { StateCreator } from 'zustand';
import type { AppStore } from './useAppStore';
import { track } from '../features/usage';
import { terminalService } from '../lib/terminal';
import type { TerminalTabSnapshot } from './sessionPersistence';
import { scheduleSaveSession } from './sessionSlice';
import {
    canSplit,
    collectLeaves,
    dockIntoLayout,
    dropFeature,
    dropPlugin,
    dropTerm,
    featureToPromoteOnLastShellExit,
    findNode,
    firstLeaf,
    focusPane as focusPaneInLayout,
    isFeatureContent,
    isPaneLeaf,
    isPluginContent,
    isSplitLayout,
    isTermContent,
    layoutActiveTermId,
    findLayoutOwner,
    WORKSPACE_PANE_OWNER,
    focusedTermIdForRestore,
    detachTermFromGroups,
    featurePaneContent,
    newFeatureInstanceId,
    pluginPaneContent,
    isPaneSplit,
    layoutHasFeature,
    layoutForCanvas,
    layoutForFeatureInstance,
    dropSplitIntro,
    neighborPaneId,
    parsePaneLayoutGroups,
    sameGroupTermDock,
    setSplitSizes,
    singleFeaturePane,
    singlePane,
    singlePluginPane,
    splitPane,
    termPaneContent,
    unsplitPane,
    visibleTermIds,
    type DockEdge,
    type DockPayload,
    type DockResult,
    type OpenSplitFeatureResult,
    type PaneContent,
    type PaneLayoutGroups,
    type PaneNavDirection,
    type SplitDirection,
    type SplitFeatureId,
    type SplitInsert,
} from '../lib/paneLayout';

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
     * @returns The generated ID of the new terminal.
     */
    createTerminal: (connectionId: string, opts?: { initialPath?: string; isSynced?: boolean; shellOverride?: string; title?: string }) => string;

    /**
     * Ensures at least one terminal exists for a connection. Creates one if none exist.
     * @param connectionId The ID of the connection to check.
     * @param initialPath Optional starting directory for the new terminal if one is created.
     * @returns The ID of the ensured terminal.
     */
    ensureTerminal: (connectionId: string, initialPath?: string) => string;

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
     * @param connectionId The ID of the connection.
     * @param termId The ID of the terminal to make active.
     */
    setActiveTerminal: (connectionId: string, termId: string) => void;
    activatePaneGroup: (connectionId: string, owner: string) => void;
    closePaneGroup: (connectionId: string, owner: string) => void;

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

    splitPanes: (connectionId: string, direction?: SplitDirection, insert?: SplitInsert) => void;
    /** Split the current feature pane (Files | Files, etc.) even when no shell is open. */
    splitFeaturePane: (connectionId: string, featureId: SplitFeatureId, direction?: SplitDirection, instanceId?: string) => DockResult;
    /** Ungrouped Files/Dashboard/… is a real pane, not an overlay. */
    ensureFeaturePane: (connectionId: string, featureId: SplitFeatureId, instanceId: string) => void;
    unsplitPanes: (connectionId: string) => void;
    togglePanes: (connectionId: string) => void;
    resizePanes: (connectionId: string, splitId: string, sizes: [number, number], persist?: boolean) => void;
    focusPane: (connectionId: string, paneId: string) => void;
    /** Move keyboard focus to the neighboring pane. False if there is no split. */
    focusPaneInDirection: (connectionId: string, direction: PaneNavDirection) => boolean;
    /** Open or focus a split-capable feature beside the focused pane. Never replaces a shell. */
    openFeatureInSplit: (connectionId: string, featureId: SplitFeatureId, edge?: DockEdge) => OpenSplitFeatureResult;
    /** Dock a feature tab or move a shell tab into this group's split. */
    dockInSplit: (
        connectionId: string,
        payload: DockPayload,
        edge: DockEdge,
        targetPaneId?: string | null,
        canvasTermId?: string | null,
        targetContent?: PaneContent,
    ) => DockResult;
    /** Remove a feature leaf; leftover shells stay. */
    closeFeatureInSplit: (connectionId: string, featureId: SplitFeatureId) => void;
    /** Remove a plugin leaf; leftover shells stay. */
    closePluginInSplit: (connectionId: string, pluginId: string) => void;
    /** Close one split pane by id (feature, plugin, or extra shell). */
    closePaneInSplit: (connectionId: string, paneId: string) => void;

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

function nextShellTitle(tabs: readonly TerminalTab[]): string {
    const used = new Set<number>();
    for (const tab of tabs) {
        const match = /^(?:Shell|Terminal)\s+(\d+)\b/i.exec(tab.title.trim());
        if (match) used.add(Number(match[1]));
    }
    let n = 1;
    while (used.has(n)) n += 1;
    return `Shell ${n}`;
}

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
            if (findNode(layout.root, targetPaneId)) return owner;
        }
    }
    if (activeGroupOwner && groups?.[activeGroupOwner]) return activeGroupOwner;
    if (activeId) {
        const activeOwner = findLayoutOwner(groups, activeId);
        if (activeOwner) return activeOwner;
    }
    if (groups?.[WORKSPACE_PANE_OWNER]) return WORKSPACE_PANE_OWNER;
    return activeId ?? WORKSPACE_PANE_OWNER;
}

/** Header drags send sourcePaneId; tab drags of an already-mounted pane must resolve it. */
function sourcePaneIdForPayload(
    groups: PaneLayoutGroups | undefined,
    payload: DockPayload,
): string | undefined {
    if (payload.sourcePaneId) return payload.sourcePaneId;
    if (!groups) return undefined;
    for (const layout of Object.values(groups)) {
        for (const leaf of collectLeaves(layout.root)) {
            if (payload.kind === 'term' && isTermContent(leaf.content) && leaf.content.termId === payload.termId) {
                return leaf.id;
            }
            if (
                payload.kind === 'feature'
                && isFeatureContent(leaf.content)
                && leaf.content.featureId === payload.featureId
                && payload.instanceId
                && leaf.content.instanceId === payload.instanceId
            ) {
                return leaf.id;
            }
            if (payload.kind === 'plugin' && isPluginContent(leaf.content) && leaf.content.pluginId === payload.pluginId) {
                return leaf.id;
            }
        }
    }
    return undefined;
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
        set(state => {
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
                    [connectionId]: [...currentTabs, newTab]
                },
                activeTerminalIds: {
                    ...state.activeTerminalIds,
                    [connectionId]: newId
                },
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
        const barTabs = currentTabs.filter(isTabVisible);
        if (barTabs.length === 0) {
            return get().createTerminal(connectionId, { initialPath });
        }
        const activeId = state.activeTerminalIds[connectionId];
        if (activeId && currentTabs.some((tab) => tab.id === activeId)) {
            return activeId;
        }
        const fallbackId = barTabs[0].id;
        set(prev => ({
            activeTerminalIds: {
                ...prev.activeTerminalIds,
                [connectionId]: fallbackId,
            },
        }));
        scheduleSaveSession(() => get().saveSession());
        return fallbackId;
    },

    /** @inheritdoc */
    closeTerminalGroup: (connectionId, termId) => {
        const owner = findLayoutOwner(get().paneLayouts[connectionId], termId) ?? termId;
        const owned = get().paneLayouts[connectionId]?.[owner];
        const extraIds = owned
            ? visibleTermIds(owned).filter((id) => id !== owner)
            : [];
        const groupId = owned ? owner : termId;
        for (const id of [groupId, ...extraIds]) {
            ipc.send('terminal:kill', { termId: id });
            terminalService.destroy(id);
        }

        set(state => {
            const currentTabs = state.terminals[connectionId] || [];
            const groups = state.paneLayouts[connectionId];
            const removeIds = new Set([groupId, ...extraIds]);

            const newTabs = currentTabs.filter(t => !removeIds.has(t.id));

            // Determine new active tab if we closed the active one
            let newActiveId = state.activeTerminalIds[connectionId];
            if (newActiveId && removeIds.has(newActiveId)) {
                const barTabs = newTabs.filter(isTabVisible);
                newActiveId = barTabs.length > 0 ? barTabs[barTabs.length - 1].id : (newTabs[0]?.id ?? null);
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
                const dropped = dropTerm(layout, groupId);
                if (dropped && isSplitLayout(dropped)) {
                    nextGroups[layoutOwner] = dropped;
                    if (contained) {
                        const remaining = layoutActiveTermId(dropped);
                        if (remaining) newActiveId = remaining;
                    }
                } else {
                    if (contained) {
                        const remaining = dropped ? layoutActiveTermId(dropped) : null;
                        if (remaining) newActiveId = remaining;
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
                    [connectionId]: newTabs
                },
                activeTerminalIds: {
                    ...state.activeTerminalIds,
                    [connectionId]: newActiveId
                },
                syncedTerminalId: nextSyncedIds,
                paneLayouts: nextLayouts,
                aiConversations: nextConversations,
                aiDisplayHistory: nextDisplay,
            };
        });
        get().saveSession();
    },

    /** @inheritdoc */
    closeTerminal: (connectionId, termId) => {
        const owner = findLayoutOwner(get().paneLayouts[connectionId], termId);
        const layout = owner ? get().paneLayouts[connectionId]?.[owner] : undefined;
        if (!owner || !layout || !isSplitLayout(layout)) {
            get().closeTerminalGroup(connectionId, termId);
            return;
        }

        ipc.send('terminal:kill', { termId });
        terminalService.destroy(termId);

        set(state => {
            const tabs = state.terminals[connectionId] || [];
            const ownerTab = tabs.find(t => t.id === owner);
            const { next, nextOwner } = detachTermFromGroups(
                state.paneLayouts[connectionId],
                termId,
            );
            const diedWasOwner = owner === termId;
            let newTabs = tabs.filter(t => t.id !== termId);
            if (nextOwner && nextOwner !== termId) {
                newTabs = newTabs.map(t => {
                    if (t.id !== nextOwner) return t;
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
                    newActiveId = barTabs.length > 0 ? barTabs[barTabs.length - 1].id : newTabs[0]?.id ?? null;
                } else {
                    nextGroupOwner = null;
                    const barTabs = newTabs.filter(isTabVisible);
                    newActiveId = barTabs.length > 0 ? barTabs[barTabs.length - 1].id : newTabs[0]?.id ?? null;
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
        get().saveSession();
    },

    closePaneOnShellExit: (connectionId, termId) => {
        const owner = findLayoutOwner(get().paneLayouts[connectionId], termId);
        const layout = owner ? get().paneLayouts[connectionId]?.[owner] : undefined;
        const promote = featureToPromoteOnLastShellExit(layout, termId);
        get().closeTerminal(connectionId, termId);
        if (!promote) return;
        const groups = get().paneLayouts[connectionId];
        const remaining = Object.entries(groups ?? {}).find(([, group]) => layoutHasFeature(group, promote));
        const tab = get().tabs.find((item) => item.connectionId === connectionId && item.id === get().activeTabId)
            ?? get().tabs.find((item) => item.connectionId === connectionId);
        if (remaining && isSplitLayout(remaining[1])) {
            get().activatePaneGroup(connectionId, remaining[0]);
            if (tab) get().setTabView(tab.id, 'terminal');
            return;
        }
        if (tab) get().setTabView(tab.id, promote);
    },

    /** @inheritdoc */
    setActiveTerminal: (connectionId, termId) => {
        set(state => {
            const groups = state.paneLayouts[connectionId];
            const tab = (state.terminals[connectionId] || []).find(t => t.id === termId);
            let nextActive = termId;
            if (tab && isTabVisible(tab)) {
                const layout = groups?.[termId];
                if (layout && isSplitLayout(layout)) {
                    nextActive = layoutActiveTermId(layout) ?? termId;
                }
            }
            const groupOwner = findLayoutOwner(groups, nextActive);
            return {
                activeTerminalIds: {
                    ...state.activeTerminalIds,
                    [connectionId]: nextActive
                },
                activePaneGroupOwner: {
                    ...state.activePaneGroupOwner,
                    [connectionId]: groupOwner,
                },
            };
        });
        scheduleSaveSession(() => get().saveSession());
    },

    /** @inheritdoc */
    clearTerminals: (connectionId, options = {}) => {
        set(state => {
            const tabs = state.terminals[connectionId] || [];

            if (!options.preservePendingRestore) {
                // Kill/destroy only when not preserving (for reconnect/restore flow).
                tabs.forEach(t => {
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
                        [connectionId]: tabs.map(t => ({ ...t, pendingRestore: true }))
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
            const termIdsToRemove = new Set(tabs.map(t => t.id));
            const nextConversations = Object.fromEntries(
                Object.entries(state.aiConversations).filter(([id]) => !termIdsToRemove.has(id))
            );
            const nextDisplay = Object.fromEntries(
                Object.entries(state.aiDisplayHistory).filter(([id]) => !termIdsToRemove.has(id))
            );

            return {
                terminals: newTerminals,
                activeTerminalIds: newActiveIds,
                syncedTerminalId: newSyncedIds,
                paneLayouts: nextLayouts,
                aiConversations: nextConversations,
                aiDisplayHistory: nextDisplay
            };
        });
        scheduleSaveSession(() => get().saveSession());
    },

    /** @inheritdoc */
    setTerminalCwd: (connectionId, termId, path) => {
        set(state => {
            const currentTabs = state.terminals[connectionId] || [];
            const newTabs = currentTabs.map(t =>
                t.id === termId ? { ...t, lastKnownCwd: path } : t
            );
            return {
                terminals: {
                    ...state.terminals,
                    [connectionId]: newTabs
                }
            };
        });
        // CWD changes on every `cd` — debounce to avoid flooding disk.
        scheduleSaveSession(() => get().saveSession());
    },

    /** @inheritdoc */
    setTerminalInitialPath: (connectionId, termId, path) => {
        set(state => {
            const currentTabs = state.terminals[connectionId] || [];
            const newTabs = currentTabs.map(t =>
                t.id === termId ? { ...t, initialPath: path } : t
            );
            return {
                terminals: {
                    ...state.terminals,
                    [connectionId]: newTabs
                }
            };
        });
        scheduleSaveSession(() => get().saveSession());
    },

    /** @inheritdoc */
    setTerminalShellOverride: (connectionId, termId, shellOverride) => {
        set(state => {
            const currentTabs = state.terminals[connectionId] || [];
            const newTabs = currentTabs.map(t =>
                t.id === termId ? { ...t, shellOverride } : t
            );
            return {
                terminals: {
                    ...state.terminals,
                    [connectionId]: newTabs
                }
            };
        });
        scheduleSaveSession(() => get().saveSession());
    },

    /** @inheritdoc */
    restoreTerminalTabs: (connectionId, snapshots, activeTerminalId, paneLayout) => {
        const isSSH = connectionId !== 'local';
        const tabs: TerminalTab[] = snapshots.map(s => ({
            id: s.id,
            title: s.title,
            initialPath: s.initialPath,
            lastKnownCwd: s.cwd,
            isSynced: s.isSynced ?? false,
            shellOverride: s.shellOverride,
            tabVisible: s.tabVisible,
            pendingRestore: isSSH || undefined,
        }));

        const syncedTab = tabs.find(t => t.isSynced);
        const known = new Set(tabs.map(t => t.id));
        const restoredGroups = parsePaneLayoutGroups(paneLayout, known);
        const hidden = new Set<string>();
        for (const [owner, layout] of Object.entries(restoredGroups)) {
            for (const id of visibleTermIds(layout)) {
                if (id !== owner) hidden.add(id);
            }
        }
        const tabsWithVisibility = tabs.map(t => ({
            ...t,
            tabVisible: !hidden.has(t.id),
        }));
        const knownRequested = tabs.some(t => t.id === activeTerminalId) ? activeTerminalId : null;
        const restoredActive = focusedTermIdForRestore(
            restoredGroups,
            knownRequested,
            tabs[0]?.id ?? null,
        );
        set(state => {
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
    },

    /** @inheritdoc */
    clearPendingRestore: (connectionId) => {
        set(state => {
            const tabs = state.terminals[connectionId];
            if (!tabs?.some(t => t.pendingRestore)) return state;
            return {
                terminals: {
                    ...state.terminals,
                    [connectionId]: tabs.map(t =>
                        t.pendingRestore ? { ...t, pendingRestore: undefined } : t
                    ),
                },
            };
        });
    },

    splitPanes: (connectionId, direction = 'horizontal', insert = 'after') => {
        const state = get();
        const tabs = state.terminals[connectionId] || [];
        const activeId = state.activeTerminalIds[connectionId] ?? tabs.find(isTabVisible)?.id ?? null;
        const groups = state.paneLayouts[connectionId];
        const owner = resolveDockOwner(
            groups,
            activeId,
            undefined,
            state.activePaneGroupOwner[connectionId],
        );
        const layout = owner
            ? groups?.[owner] ?? (activeId ? singlePane(activeId) : undefined)
            : undefined;
        if (!owner || !layout || !canSplit(layout)) return;

        const target = findNode(layout.root, layout.activePaneId) ?? firstLeaf(layout.root);
        if (!isPaneLeaf(target)) return;

        let nextTabs = tabs;
        let nextContent = target.content;
        let nextActiveId = activeId;
        if (isTermContent(target.content)) {
            const sourceTermId = target.content.termId;
            const sourceTab = tabs.find(tab => tab.id === sourceTermId);
            if (!sourceTab) return;
            const duplicateId = `term-${crypto.randomUUID()}`;
            nextContent = termPaneContent(duplicateId);
            nextTabs = [
                ...tabs,
                {
                    id: duplicateId,
                    title: nextShellTitle(tabs),
                    tabVisible: false,
                    shellOverride: sourceTab.shellOverride,
                    initialPath: sourceTab.lastKnownCwd ?? sourceTab.initialPath,
                    lastKnownCwd: sourceTab.lastKnownCwd,
                },
            ];
            nextActiveId = duplicateId;
        } else if (target.content.kind === 'feature') {
            const instanceId = newFeatureInstanceId(target.content.featureId);
            if (target.content.featureId === 'files') {
                get().copyFilesListing(connectionId, target.content.instanceId, instanceId);
            }
            nextContent = featurePaneContent(target.content.featureId, instanceId);
        }

        const result = splitPane(layout, target.id, direction, nextContent, undefined, insert);
        if (!result.ok) return;
        const focused = focusPaneInLayout(result.layout, result.newPaneId);
        set({
            terminals: { ...state.terminals, [connectionId]: nextTabs },
            paneLayouts: {
                ...state.paneLayouts,
                [connectionId]: { ...(groups ?? {}), [owner]: focused },
            },
            activeTerminalIds: nextActiveId
                ? { ...state.activeTerminalIds, [connectionId]: nextActiveId }
                : state.activeTerminalIds,
        });
        scheduleSaveSession(() => get().saveSession());
        track('split');
        if (nextContent.kind === 'feature' && nextContent.featureId === 'files') track('split_files');
    },

    ensureFeaturePane: (connectionId, featureId, instanceId) => {
        const state = get();
        const groups = state.paneLayouts[connectionId];
        if (layoutForFeatureInstance(groups, instanceId)) return;
        if (featureId === 'files') {
            get().copyFilesListing(connectionId, undefined, instanceId);
        }
        set({
            paneLayouts: {
                ...state.paneLayouts,
                [connectionId]: {
                    ...(groups ?? {}),
                    [instanceId]: singleFeaturePane(featureId, undefined, instanceId),
                },
            },
        });
        scheduleSaveSession(() => get().saveSession());
    },

    activatePaneGroup: (connectionId, owner) => {
        set(state => {
            const layout = state.paneLayouts[connectionId]?.[owner];
            if (!layout) return state;
            const termId = layoutActiveTermId(layout);
            return {
                activePaneGroupOwner: {
                    ...state.activePaneGroupOwner,
                    [connectionId]: owner,
                },
                activeTerminalIds: termId
                    ? { ...state.activeTerminalIds, [connectionId]: termId }
                    : state.activeTerminalIds,
            };
        });
    },

    closePaneGroup: (connectionId, owner) => {
        const layout = get().paneLayouts[connectionId]?.[owner];
        if (!layout) return;
        const closedTermIds = visibleTermIds(layout);
        for (const termId of closedTermIds) {
            ipc.send('terminal:kill', { termId });
            terminalService.destroy(termId);
        }

        set(state => {
            const groups = state.paneLayouts[connectionId];
            if (!groups?.[owner]) return state;
            const nextGroups = { ...groups };
            delete nextGroups[owner];
            const closedTermSet = new Set(closedTermIds);
            const currentTabs = state.terminals[connectionId] || [];
            const firstClosedIndex = currentTabs.findIndex(tab => closedTermSet.has(tab.id));
            const nextTabs = currentTabs.filter(tab => !closedTermSet.has(tab.id));
            let nextActiveId = state.activeTerminalIds[connectionId] ?? null;
            if (nextActiveId && closedTermSet.has(nextActiveId)) {
                const visibleTabs = nextTabs.filter(isTabVisible);
                const fallbackIndex = firstClosedIndex < 0
                    ? visibleTabs.length - 1
                    : Math.min(firstClosedIndex, visibleTabs.length - 1);
                nextActiveId = visibleTabs[Math.max(0, fallbackIndex)]?.id ?? nextTabs[0]?.id ?? null;
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
            const nextOwner = state.activePaneGroupOwner[connectionId] === owner
                ? null
                : state.activePaneGroupOwner[connectionId] ?? null;
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
        scheduleSaveSession(() => get().saveSession());
    },

    splitFeaturePane: (connectionId, featureId, direction = 'horizontal', instanceId) => {
        const state = get();
        const groups = state.paneLayouts[connectionId];
        const activeId = state.activeTerminalIds[connectionId];
        const instanceLayout = layoutForFeatureInstance(groups, instanceId);
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
                    get().copyFilesListing(connectionId, undefined, seedId);
                    layout = singleFeaturePane('files', undefined, seedId);
                } else {
                    layout = singleFeaturePane(featureId, undefined, seedId);
                }
                owner = seedId;
            }
        }
        if (!canSplit(layout)) return 'refused-cap';
        const target = findNode(layout.root, layout.activePaneId) ?? firstLeaf(layout.root);
        const nextInstanceId = newFeatureInstanceId(featureId);
        let nextContent = featurePaneContent(featureId, nextInstanceId);
        if (featureId === 'files') {
            const fromInstance = isPaneLeaf(target) && target.content.kind === 'feature' && target.content.featureId === 'files'
                ? target.content.instanceId
                : undefined;
            get().copyFilesListing(connectionId, fromInstance, nextInstanceId);
        }
        const result = splitPane(layout, target.id, direction, nextContent);
        if (!result.ok) return result.reason === 'cap' ? 'refused-cap' : 'no-target';
        set({
            paneLayouts: {
                ...state.paneLayouts,
                [connectionId]: { ...(groups ?? {}), [owner]: focusPaneInLayout(result.layout, result.newPaneId) },
            },
            activePaneGroupOwner: {
                ...state.activePaneGroupOwner,
                [connectionId]: owner,
            },
        });
        scheduleSaveSession(() => get().saveSession());
        track('split');
        if (featureId === 'files') track('split_files');
        return 'opened';
    },

    unsplitPanes: (connectionId) => {
        const state = get();
        const activeId = state.activeTerminalIds[connectionId];
        const groups = state.paneLayouts[connectionId];
        const owner = resolveDockOwner(groups, activeId, undefined, state.activePaneGroupOwner[connectionId]);
        const layout = owner ? groups?.[owner] : undefined;
        if (!owner || !layout || !isSplitLayout(layout)) return;
        const focused = findNode(layout.root, layout.activePaneId);
        if (focused && isPaneLeaf(focused) && !isTermContent(focused.content)) {
            get().closePaneInSplit(connectionId, focused.id);
            return;
        }

        set(state => {
            const focusedTermLeaf = findNode(layout.root, layout.activePaneId);
            if (!focusedTermLeaf || !isPaneLeaf(focusedTermLeaf) || focusedTermLeaf.content.kind !== 'term') {
                return state;
            }
            const focusedTerm = focusedTermLeaf.content.termId;
            const { next, nextOwner } = detachTermFromGroups(state.paneLayouts[connectionId], focusedTerm);

            const nextTabs = (state.terminals[connectionId] || []).map(t => {
                if (t.id === focusedTerm || (nextOwner && t.id === nextOwner)) {
                    return { ...t, tabVisible: true };
                }
                return t;
            });

            const nextLayouts = { ...state.paneLayouts };
            if (next) {
                nextLayouts[connectionId] = next;
            } else {
                delete nextLayouts[connectionId];
            }
            return {
                terminals: { ...state.terminals, [connectionId]: nextTabs },
                paneLayouts: nextLayouts,
                activeTerminalIds: { ...state.activeTerminalIds, [connectionId]: focusedTerm },
                activePaneGroupOwner: {
                    ...state.activePaneGroupOwner,
                    [connectionId]: nextOwner,
                },
            };
        });
        scheduleSaveSession(() => get().saveSession());
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

    resizePanes: (connectionId, splitId, sizes, persist = false) => {
        set(state => {
            const activeId = state.activeTerminalIds[connectionId];
            const groups = state.paneLayouts[connectionId];
            const owner = resolveDockOwner(groups, activeId, splitId);
            const layout = owner ? groups?.[owner] : undefined;
            if (!owner || !layout) return state;
            const nextGroups = { ...(groups ?? {}), [owner]: setSplitSizes(layout, splitId, sizes) };
            return {
                paneLayouts: { ...state.paneLayouts, [connectionId]: nextGroups },
            };
        });
        if (persist) {
            scheduleSaveSession(() => get().saveSession());
        }
    },

    focusPane: (connectionId, paneId) => {
        set(state => {
            const activeId = state.activeTerminalIds[connectionId];
            const groups = state.paneLayouts[connectionId];
            const owner = resolveDockOwner(groups, activeId, paneId);
            const layout = owner ? groups?.[owner] : undefined;
            if (!owner || !layout) return state;
            const next = focusPaneInLayout(layout, paneId);
            const termId = layoutActiveTermId(next);
            return {
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

    focusPaneInDirection: (connectionId, direction) => {
        const state = get();
        const activeId = state.activeTerminalIds[connectionId];
        const groups = state.paneLayouts[connectionId];
        const owner = resolveDockOwner(groups, activeId, undefined, state.activePaneGroupOwner[connectionId]);
        const layout = owner ? groups?.[owner] : undefined;
        if (!owner || !layout || !isSplitLayout(layout)) return false;
        const nextId = neighborPaneId(layout, direction);
        if (!nextId) return true;
        get().focusPane(connectionId, nextId);
        return true;
    },

    openFeatureInSplit: (connectionId, featureId, edge = 'right') => {
        return get().dockInSplit(connectionId, { kind: 'feature', featureId }, edge);
    },

    dockInSplit: (connectionId, payload, edge, targetPaneId, canvasTermId, targetContent) => {
        const state = get();
        const tabs = state.terminals[connectionId] || [];
        const groups = state.paneLayouts[connectionId];
        const paneId = targetPaneId || undefined;
        const owner = resolveDockOwner(
            groups,
            canvasTermId ?? state.activeTerminalIds[connectionId],
            paneId,
            state.activePaneGroupOwner[connectionId],
        )
            ?? tabs.find(isTabVisible)?.id
            ?? WORKSPACE_PANE_OWNER;
        const sourcePaneId = sourcePaneIdForPayload(groups, payload);

        // Dropping onto another pane relocates that exact pane. Dropping back
        // onto itself (an edge of the same pane) still splits on self.
        if (sourcePaneId && paneId && sourcePaneId !== paneId) {
            const sourceOwner = resolveDockOwner(groups, state.activeTerminalIds[connectionId], sourcePaneId);
            const sourceLayout = sourceOwner ? groups?.[sourceOwner] : undefined;
            if (sourceOwner && sourceLayout) {
                const sourceNode = findNode(sourceLayout.root, sourcePaneId);
                if (!sourceNode || !isPaneLeaf(sourceNode)) return 'no-target';
                const withoutSource = isSplitLayout(sourceLayout)
                    ? unsplitPane(sourceLayout, sourcePaneId)
                    : null;
                let targetLayout = sourceOwner === owner ? withoutSource : groups?.[owner];
                if (!targetLayout && owner === WORKSPACE_PANE_OWNER && targetContent) {
                    if (targetContent.kind === 'feature') {
                        const instanceId = targetContent.instanceId ?? newFeatureInstanceId(targetContent.featureId);
                        if (targetContent.featureId === 'files' && !targetContent.instanceId) {
                            get().copyFilesListing(connectionId, undefined, instanceId);
                        }
                        targetLayout = singleFeaturePane(targetContent.featureId, undefined, instanceId);
                    } else if (targetContent.kind === 'plugin') {
                        targetLayout = singlePluginPane(targetContent.pluginId);
                    } else if (targetContent.kind === 'term') {
                        targetLayout = singlePane(targetContent.termId);
                    }
                }
                if (!targetLayout) return 'no-target';
                const moved = dockIntoLayout(targetLayout, sourceNode.content, edge, undefined, paneId);
                if (!moved.ok) {
                    return moved.reason === 'cap' ? 'refused-cap' : 'no-target';
                }

                if (sourceOwner !== owner) {
                    const remainingTerms = withoutSource ? visibleTermIds(withoutSource) : [];
                    const keepSourceGroup = Boolean(withoutSource && isSplitLayout(withoutSource));
                    const remainingFeatureOwner = withoutSource
                        ? collectLeaves(withoutSource.root).find((leaf) => (
                            isFeatureContent(leaf.content) && leaf.content.instanceId
                        ))
                        : undefined;
                    const nextSourceOwner = keepSourceGroup
                        ? (remainingTerms.includes(sourceOwner)
                            ? sourceOwner
                            : remainingTerms[0]
                                ?? (remainingFeatureOwner && isFeatureContent(remainingFeatureOwner.content)
                                    ? remainingFeatureOwner.content.instanceId
                                    : undefined)
                                ?? WORKSPACE_PANE_OWNER)
                        : null;
                    const nextGroups: PaneLayoutGroups = {};
                    for (const [groupOwner, groupLayout] of Object.entries(groups ?? {})) {
                        if (groupOwner === sourceOwner) {
                            if (nextSourceOwner && withoutSource) nextGroups[nextSourceOwner] = withoutSource;
                            continue;
                        }
                        nextGroups[groupOwner] = groupOwner === owner ? moved.layout : groupLayout;
                    }
                    nextGroups[owner] = moved.layout;
                    const releasedTerms = keepSourceGroup ? new Set<string>() : new Set(remainingTerms);
                    const movedTermId = sourceNode.content.kind === 'term' ? sourceNode.content.termId : null;
                    const nextTabs = tabs.map((tab) => {
                        if (tab.id === movedTermId) {
                            return { ...tab, tabVisible: owner === WORKSPACE_PANE_OWNER };
                        }
                        if (tab.id === nextSourceOwner || releasedTerms.has(tab.id)) {
                            return { ...tab, tabVisible: true };
                        }
                        return tab;
                    });
                    set({
                        terminals: { ...state.terminals, [connectionId]: nextTabs },
                        paneLayouts: writeConnectionGroups(state.paneLayouts, connectionId, nextGroups),
                        activeTerminalIds: {
                            ...state.activeTerminalIds,
                            [connectionId]: layoutActiveTermId(moved.layout),
                        },
                        activePaneGroupOwner: {
                            ...state.activePaneGroupOwner,
                            [connectionId]: owner,
                        },
                    });
                    scheduleSaveSession(() => get().saveSession());
                    return 'moved';
                }

                set({
                    paneLayouts: {
                        ...state.paneLayouts,
                        [connectionId]: { ...(groups ?? {}), [owner]: moved.layout },
                    },
                    activeTerminalIds: sourceNode.content.kind === 'term'
                        ? { ...state.activeTerminalIds, [connectionId]: sourceNode.content.termId }
                        : state.activeTerminalIds,
                    activePaneGroupOwner: {
                        ...state.activePaneGroupOwner,
                        [connectionId]: owner,
                    },
                });
                scheduleSaveSession(() => get().saveSession());
                return 'moved';
            }
        }

        if (payload.kind === 'term') {
            if (!tabs.some((tab) => tab.id === payload.termId)) return 'no-target';
            const selfDock = sameGroupTermDock(groups, owner, payload.termId);
            let targetLayout = groups?.[owner];
            if (!targetLayout && targetContent?.kind === 'feature') {
                const instanceId = targetContent.instanceId ?? newFeatureInstanceId(targetContent.featureId);
                if (targetContent.featureId === 'files' && !targetContent.instanceId) {
                    get().copyFilesListing(connectionId, undefined, instanceId);
                }
                targetLayout = singleFeaturePane(targetContent.featureId, undefined, instanceId);
            } else if (!targetLayout && targetContent?.kind === 'plugin') {
                targetLayout = singlePluginPane(targetContent.pluginId);
            } else if (!targetLayout && owner !== WORKSPACE_PANE_OWNER) {
                targetLayout = singlePane(owner);
            }
            if (!targetLayout) return 'no-target';
            if (!canSplit(targetLayout)) return 'refused-cap';

            // A tab dropped back onto a pane in its own layout means "split this
            // shell here". One PTY cannot be mounted twice, so create a sibling
            // shell with the same launch context and keep it off the tab bar.
            if (selfDock) {
                const sourceTab = tabs.find((tab) => tab.id === payload.termId);
                if (!sourceTab) return 'no-target';
                const duplicateId = `term-${crypto.randomUUID()}`;
                const docked = dockIntoLayout(targetLayout, termPaneContent(duplicateId), edge, undefined, paneId);
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
                set({
                    terminals: { ...state.terminals, [connectionId]: [...tabs, duplicate] },
                    paneLayouts: {
                        ...state.paneLayouts,
                        [connectionId]: { ...(groups ?? {}), [owner]: docked.layout },
                    },
                    activeTerminalIds: { ...state.activeTerminalIds, [connectionId]: duplicateId },
                    activePaneGroupOwner: {
                        ...state.activePaneGroupOwner,
                        [connectionId]: owner,
                    },
                });
                scheduleSaveSession(() => get().saveSession());
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
            if (nextOwner !== owner) delete groupsNext[owner];
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

            set({
                terminals: { ...state.terminals, [connectionId]: nextTabs },
                paneLayouts: writeConnectionGroups(
                    state.paneLayouts,
                    connectionId,
                    Object.keys(groupsNext).length > 0 ? groupsNext : undefined,
                ),
                activeTerminalIds: {
                    ...state.activeTerminalIds,
                    [connectionId]: payload.termId,
                },
                activePaneGroupOwner: {
                    ...state.activePaneGroupOwner,
                    [connectionId]: nextOwner,
                },
            });
            scheduleSaveSession(() => get().saveSession());
            return 'moved';
        }

        const existingLayout = groups?.[owner];
        let layout = existingLayout;
        if (!layout) {
            // A split command from a shell tab must start with that shell as the
            // canvas. Starting with the incoming feature/plugin would duplicate
            // it (Files | Files) and leave the shell stranded in the tab bar.
            if (owner !== WORKSPACE_PANE_OWNER && tabs.some((tab) => tab.id === owner)) {
                layout = singlePane(owner);
            } else if (targetContent?.kind === 'feature') {
                const baseInstanceId = targetContent.instanceId ?? newFeatureInstanceId(targetContent.featureId);
                if (targetContent.featureId === 'files' && !targetContent.instanceId) {
                    get().copyFilesListing(connectionId, undefined, baseInstanceId);
                }
                layout = singleFeaturePane(targetContent.featureId, undefined, baseInstanceId);
            } else if (targetContent?.kind === 'plugin') {
                layout = singlePluginPane(targetContent.pluginId);
            } else if (payload.kind === 'plugin') {
                layout = singlePluginPane(payload.pluginId);
            } else if (payload.kind === 'feature') {
                const baseInstanceId = payload.instanceId ?? newFeatureInstanceId(payload.featureId);
                if (payload.featureId === 'files') {
                    if (!payload.instanceId) {
                        get().copyFilesListing(connectionId, undefined, baseInstanceId);
                    }
                    layout = singleFeaturePane('files', undefined, baseInstanceId);
                } else {
                    layout = singleFeaturePane(payload.featureId, undefined, baseInstanceId);
                }
            } else if (owner !== WORKSPACE_PANE_OWNER) {
                layout = singlePane(owner);
            }
        }
        if (!layout) return 'no-target';
        const duplicateFeature = payload.kind === 'feature' && (
            Boolean(sourcePaneId && paneId && sourcePaneId === paneId)
            || (!existingLayout
                && targetContent?.kind === 'feature'
                && targetContent.featureId === payload.featureId
                && targetContent.instanceId === payload.instanceId)
        );
        let content = payload.kind === 'plugin'
            ? pluginPaneContent(payload.pluginId)
            : featurePaneContent(
                payload.featureId,
                duplicateFeature
                    ? newFeatureInstanceId(payload.featureId)
                    : payload.instanceId ?? newFeatureInstanceId(payload.featureId),
            );
        if (content.kind === 'feature' && content.featureId === 'files') {
            const focused = findNode(layout.root, layout.activePaneId) ?? firstLeaf(layout.root);
            const fromInstance = payload.kind === 'feature' && payload.featureId === 'files' && payload.instanceId
                ? payload.instanceId
                : isPaneLeaf(focused) && focused.content.kind === 'feature' && focused.content.featureId === 'files'
                    ? focused.content.instanceId
                    : undefined;
            if (content.instanceId !== fromInstance) {
                get().copyFilesListing(connectionId, fromInstance, content.instanceId);
            }
        }
        const docked = dockIntoLayout(layout, content, edge, undefined, paneId);
        if (!docked.ok) {
            return docked.reason === 'cap' ? 'refused-cap' : 'no-target';
        }
        if (paneId?.startsWith('overlay:') && isPaneSplit(docked.layout.root)) {
            dropSplitIntro(docked.layout.root.id);
        }
        set({
            paneLayouts: {
                ...state.paneLayouts,
                [connectionId]: { ...(groups ?? {}), [owner]: docked.layout },
            },
            activePaneGroupOwner: {
                ...state.activePaneGroupOwner,
                [connectionId]: owner,
            },
        });
        scheduleSaveSession(() => get().saveSession());
        if (docked.created) {
            track('split');
            if (content.kind === 'feature' && content.featureId === 'files') track('split_files');
        }
        return docked.created ? 'opened' : 'focused';
    },

    closeFeatureInSplit: (connectionId, featureId) => {
        set(state => {
            const activeId = state.activeTerminalIds[connectionId];
            const groups = state.paneLayouts[connectionId];
            const owner = resolveDockOwner(
                groups,
                activeId,
                undefined,
                state.activePaneGroupOwner[connectionId],
            );
            const layout = owner ? groups?.[owner] : undefined;
            if (!owner || !layout) return state;
            const dropped = dropFeature(layout, featureId);
            if (dropped === layout) return state;
            const nextGroups: PaneLayoutGroups = { ...(groups ?? {}) };
            delete nextGroups[owner];
            if (dropped && isSplitLayout(dropped)) {
                nextGroups[owner] = dropped;
            }
            const remainingTerm = dropped ? layoutActiveTermId(dropped) : activeId;
            return {
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
        scheduleSaveSession(() => get().saveSession());
    },

    closePluginInSplit: (connectionId, pluginId) => {
        set(state => {
            const activeId = state.activeTerminalIds[connectionId];
            const groups = state.paneLayouts[connectionId];
            const owner = resolveDockOwner(
                groups,
                activeId,
                undefined,
                state.activePaneGroupOwner[connectionId],
            );
            const layout = owner ? groups?.[owner] : undefined;
            if (!owner || !layout) return state;
            const dropped = dropPlugin(layout, pluginId);
            if (dropped === layout) return state;
            const nextGroups: PaneLayoutGroups = { ...(groups ?? {}) };
            delete nextGroups[owner];
            if (dropped && isSplitLayout(dropped)) {
                nextGroups[owner] = dropped;
            }
            const remainingTerm = dropped ? layoutActiveTermId(dropped) : activeId;
            return {
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
        scheduleSaveSession(() => get().saveSession());
    },

    closePaneInSplit: (connectionId, paneId) => {
        set(state => {
            const groups = state.paneLayouts[connectionId];
            const owner = resolveDockOwner(groups, state.activeTerminalIds[connectionId], paneId);
            if (!owner) return state;
            const layout = groups?.[owner];
            if (!layout) return state;
            const node = findNode(layout.root, paneId);
            if (!node || !isPaneLeaf(node)) return state;
            const closingTermId = isTermContent(node.content) ? node.content.termId : null;
            if (isPaneLeaf(layout.root)) {
                const nextGroups = { ...(groups ?? {}) };
                delete nextGroups[owner];
                const nextTabs = closingTermId
                    ? (state.terminals[connectionId] || []).map(tab => (
                        tab.id === closingTermId ? { ...tab, tabVisible: true } : tab
                    ))
                    : state.terminals[connectionId] || [];
                return {
                    terminals: { ...state.terminals, [connectionId]: nextTabs },
                    paneLayouts: writeConnectionGroups(
                        state.paneLayouts,
                        connectionId,
                        Object.keys(nextGroups).length > 0 ? nextGroups : undefined,
                    ),
                    activePaneGroupOwner: state.activePaneGroupOwner[connectionId] === owner
                        ? { ...state.activePaneGroupOwner, [connectionId]: null }
                        : state.activePaneGroupOwner,
                };
            }
            const dropped = unsplitPane(layout, paneId);
            const releasedTermIds = new Set(closingTermId ? [closingTermId] : []);
            if (!isSplitLayout(dropped)) {
                for (const termId of visibleTermIds(dropped)) releasedTermIds.add(termId);
            }
            const nextTabs = releasedTermIds.size > 0
                ? (state.terminals[connectionId] || []).map(tab => (
                    releasedTermIds.has(tab.id) ? { ...tab, tabVisible: true } : tab
                ))
                : state.terminals[connectionId] || [];
            const nextGroups: PaneLayoutGroups = { ...(groups ?? {}) };
            delete nextGroups[owner];
            let nextActiveTermId = state.activeTerminalIds[connectionId] ?? null;
            let nextLayoutOwner: string | null = null;
            if (isSplitLayout(dropped)) {
                const remainingTerms = visibleTermIds(dropped);
                const nextOwner = remainingTerms.includes(owner)
                    ? owner
                    : remainingTerms[0] ?? owner;
                nextGroups[nextOwner] = dropped;
                nextLayoutOwner = nextOwner;
                if (remainingTerms.length > 0 && (!nextActiveTermId || !remainingTerms.includes(nextActiveTermId))) {
                    nextActiveTermId = remainingTerms[0];
                }
            } else if (dropped && isPaneLeaf(dropped.root) && !isTermContent(dropped.root.content)) {
                nextGroups[owner] = dropped;
                nextLayoutOwner = owner;
            }
            return {
                terminals: { ...state.terminals, [connectionId]: nextTabs },
                paneLayouts: writeConnectionGroups(
                    state.paneLayouts,
                    connectionId,
                    Object.keys(nextGroups).length > 0 ? nextGroups : undefined,
                ),
                activeTerminalIds: nextActiveTermId
                    ? { ...state.activeTerminalIds, [connectionId]: nextActiveTermId }
                    : state.activeTerminalIds,
                activePaneGroupOwner: state.activePaneGroupOwner[connectionId] === owner
                    ? { ...state.activePaneGroupOwner, [connectionId]: nextLayoutOwner }
                    : state.activePaneGroupOwner,
            };
        });
        scheduleSaveSession(() => get().saveSession());
    },
});
