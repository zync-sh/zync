import { StateCreator } from 'zustand';
import type { AppStore } from './useAppStore';
import type { Connection, CoreTabView, Folder, Tab } from '../features/connections/domain/types.js';
import {
    addFolderToState,
    deleteFolderFromState,
    mergeImportedConnections,
    renameFolderInState,
    upsertConnectionInState,
    updateConnectionFolderInState,
} from '../features/connections/application/connectionService';
import {
    activateExistingConnectionTab,
    createConnectionTabState,
    createLocalTerminalTabState,
    ensureGlobalSnippetsTab,
    ensureSingleTabByType,
    findConnectionTab,
    GLOBAL_SNIPPETS_CONNECTION_ID,
    LOCAL_TERMINAL_CONNECTION_ID,
} from '../features/connections/application/tabService';
import {
    getCloseTabPreActions,
    markConnectionConnected,
    markConnectionErrorIfNeeded,
    markConnectionStatus,
    reduceTabCloseState,
} from '../features/connections/application/connectionLifecycleService';
import {
    pinFeatureOnConnectionIfNeeded,
    startAutoStartTunnels,
} from '../features/connections/application/tunnelAutoStartService';
import { buildConnectConfig, normalizeFolderPath, type ImportPlanItem } from '../features/connections/domain';
import { connectIpc, disconnectIpc, getRemoteCwdIpc } from '../features/connections/infrastructure/connectionIpc';
import { loadConnectionsIpc, saveConnectionsIpc } from '../features/connections/infrastructure/connectionPersistence';
import { clearRemoteShellCache } from '../lib/shells/cache';
import type { TabSnapshot } from './sessionPersistence';
export type { Connection, Folder, Tab } from '../features/connections/domain/types.js';

export interface ConnectionSlice {
    connections: Connection[];
    tabs: Tab[];
    activeTabId: string | null;
    activeConnectionId: string | null;
    lastRealConnectionId: string | null;
    showWelcomeScreen: boolean;
    folders: Folder[];

    // UI State
    isAddConnectionModalOpen: boolean;
    editingConnectionId: string | null;
    setAddConnectionModalOpen: (open: boolean) => void;
    /** Open the add/edit connection modal. Pass a connection id to edit, omit to add new. */
    openConnectionModal: (id?: string | null) => void;

    // Actions
    addConnection: (conn: Connection, isTemp?: boolean) => void;
    editConnection: (conn: Connection) => void;
    deleteConnection: (id: string) => void;
    importConnections: (conns: Connection[] | ImportPlanItem[], importedFolders?: Folder[]) => void;
    clearConnections: () => void;

    // Connection Actions
    connect: (id: string) => Promise<void>;
    disconnect: (id: string) => Promise<void>;

    // Tab Actions
    openTab: (connectionId: string, startView?: CoreTabView) => void;
    openPortForwardingTab: () => void;
    openSnippetsTab: () => void;
    openReleaseNotesTab: () => void;
    openSettingsJsonTab: () => void;
    closeTab: (tabId: string) => void;
    activateTab: (tabId: string) => void;
    /** Deactivate all tabs and show the welcome screen without closing anything. */
    goHome: () => void;
    setTabView: (tabId: string, view: Tab['view']) => void;

    // Folder Actions
    addFolder: (name: string, tags?: string[]) => void;
    deleteFolder: (name: string) => void;
    renameFolder: (oldName: string, newName: string, newTags?: string[]) => void;
    updateConnectionFolder: (connectionId: string, folderName: string) => void;

    // Favorite Actions
    toggleFavorite: (connectionId: string) => void;

    // Feature Pinning
    toggleConnectionFeature: (connectionId: string, feature: string) => void;

    // Tab Reordering
    reorderTabs: (oldIndex: number, newIndex: number) => void;

    // Session Restore
    /**
     * Restore persisted sidebar tabs on app start. Only called by sessionSlice.loadSession().
     * Filters out tabs whose connections no longer exist.
     */
    restoreTabState: (
        tabs: TabSnapshot[],
        activeTabId: string | null,
        activeConnectionId: string | null,
        showWelcomeScreen?: boolean,
    ) => void;

    // Initialization
    loadConnections: () => Promise<void>;
}

const VALID_RESTORABLE_VIEWS = new Set<CoreTabView>(['terminal', 'files', 'port-forwarding', 'snippets', 'dashboard']);

export const createConnectionSlice: StateCreator<AppStore, [], [], ConnectionSlice> = (set, get) => ({
    connections: [],
    tabs: [],
    activeTabId: null,
    activeConnectionId: null,
    lastRealConnectionId: null,
    showWelcomeScreen: false,
    folders: [],
    isAddConnectionModalOpen: false,
    editingConnectionId: null,

    setAddConnectionModalOpen: (open) => set(
        open ? { isAddConnectionModalOpen: true }
             : { isAddConnectionModalOpen: false, editingConnectionId: null }
    ),

    openConnectionModal: (id = null) => set({ isAddConnectionModalOpen: true, editingConnectionId: id }),

    loadConnections: async () => {
        try {
            // console.error('[RENDERER] Migrating keys if needed...');
            // const migratedCount = await window.ipcRenderer.invoke('ssh:migrate-all-keys');
            // if (migratedCount > 0) {
            //     console.log(`[RENDERER] Migrated ${migratedCount} connection keys`);
            // }

            console.error('[RENDERER] Loading connections...');
            const loaded = await loadConnectionsIpc();
            console.error('[RENDERER] Loaded connections from IPC:', loaded);
            if (loaded && (Array.isArray(loaded) || 'connections' in loaded)) {
                const conns = Array.isArray(loaded) ? loaded : loaded.connections;
                const foldersSource = Array.isArray(loaded) ? [] : (loaded.folders || []);
                const folders = foldersSource.map((f: any) => typeof f === 'string' ? { name: f } : f);

                // Deduplicate connections by ID to prevent React key collisions
                const uniqueConns = Array.from(new Map(conns.map((c: any) => [c.id, c])).values());

                if (uniqueConns.length !== conns.length) {
                    console.warn(`[RENDERER] Found ${conns.length - uniqueConns.length} duplicate connection IDs. Deduplicated.`);
                }

                console.log('Setting connections state:', uniqueConns);
                set({
                    connections: uniqueConns.map((c: any) => ({ ...c, status: 'disconnected' })),
                    folders
                });
            } else {
                console.warn('No connections found in loaded data', loaded);
            }
        } catch (error) {
            console.error('Failed to load connections:', error);
        }
    },

    addConnection: (conn, isTemp = false) => {
        set(state => {
            const next = upsertConnectionInState(state, conn);
            if (!isTemp) {
                saveToMain(next.connections, next.folders);
            }
            return { connections: next.connections, folders: next.folders };
        });
    },

    editConnection: (updatedConn) => {
        const existing = get().connections.find(connection => connection.id === updatedConn.id);
        if (existing && hasRemoteTargetChanged(existing, updatedConn)) {
            clearRemoteShellCache(updatedConn.id);
        }
        set(state => {
            const next = upsertConnectionInState(state, updatedConn);
            saveToMain(next.connections, next.folders);
            return { connections: next.connections, folders: next.folders };
        });
    },

    deleteConnection: (id) => {
        clearRemoteShellCache(id);
        set(state => {
            const newConns = state.connections.filter(c => c.id !== id);
            // Also close related tabs
            const newTabs = state.tabs.filter(t => t.connectionId !== id);
            // If active tab was closed, pick new active
            let newActiveId = state.activeTabId;
            if (state.activeTabId && !newTabs.find(t => t.id === state.activeTabId)) {
                newActiveId = newTabs.length > 0 ? newTabs[newTabs.length - 1].id : null;
            }
            const newActiveConnectionId = newTabs.find(t => t.id === newActiveId)?.connectionId ?? null;

            saveToMain(newConns, state.folders);
            const showWelcomeScreen = newTabs.length === 0 ? true : state.showWelcomeScreen;
            return {
                connections: newConns,
                tabs: newTabs,
                activeTabId: newActiveId,
                activeConnectionId: newActiveConnectionId,
                showWelcomeScreen,
            };
        });
        get().saveSession();
    },

    importConnections: (newConns, importedFolders = []) => {
        set(state => {
            console.log('[IMPORT] Raw Imported Connections:', newConns);
            const isPlanItems = Array.isArray(newConns)
                && newConns.length > 0
                && typeof newConns[0] === 'object'
                && newConns[0] !== null
                && 'connection' in (newConns[0] as object);

            let finalConns: Connection[];

            if (isPlanItems) {
                const planItems = newConns as ImportPlanItem[];
                let nextConnections = [...state.connections];
                const creates: Connection[] = [];

                // Pre-pass: build importedId → existingId remap and pendingAdds set for
                // the entire batch so jumpServerId references can be resolved even when the
                // jump server itself is later in the list (or not in this batch at all).
                const idRemap = new Map<string, string>();
                // pendingAdds: imported IDs that will land as new connections — either
                // they have no targetId, OR their targetId doesn't exist in nextConnections
                // (target was deleted since last import). Kept as a set so resolveJumpServerId
                // can preserve imported references for connections being added in this batch.
                const pendingAdds = new Set<string>();
                planItems.forEach((item) => {
                    if (item.targetId && item.connection.id !== item.targetId) {
                        idRemap.set(item.connection.id, item.targetId);
                    }
                    if (!item.targetId || !nextConnections.some(c => c.id === item.targetId)) {
                        pendingAdds.add(item.connection.id);
                    }
                });

                // Resolves an imported jumpServerId to a stable store ID.
                // Two fallback semantics:
                // - UPDATE path (existingJumpId provided): if the imported ID doesn't
                //   resolve, fall back to the existing connection's jumpServerId so a
                //   partial re-import doesn't silently break a working jump chain.
                // - CREATE path (existingJumpId = undefined): if the imported ID doesn't
                //   resolve and no existing record exists, drop it (return undefined) to
                //   avoid persisting a dangling reference on brand-new connections.
                const resolveJumpServerId = (
                    importedJumpId: string | undefined,
                    existingJumpId: string | undefined,
                ): string | undefined => {
                    if (!importedJumpId) return importedJumpId;
                    // Follow the remap chain (jump server was also in this batch)
                    const remapped = idRemap.get(importedJumpId) ?? importedJumpId;
                    // If remapped ID exists in the store, use it
                    if (nextConnections.some(c => c.id === remapped)) return remapped;
                    // Jump server is being added as new in this batch — keep imported reference
                    if (pendingAdds.has(importedJumpId)) return importedJumpId;
                    // importedJumpId doesn't resolve → preserve the existing working reference
                    return existingJumpId;
                };

                planItems.forEach((item) => {
                    const normalizedFolder = normalizeFolderPath(item.connection.folder || '');
                    const normalizedConnection = { ...item.connection, folder: normalizedFolder };

                    if (item.targetId) {
                        const targetIndex = nextConnections.findIndex((connection) => connection.id === item.targetId);
                        if (targetIndex >= 0) {
                            const existing = nextConnections[targetIndex];
                            const preservedMetadata: Partial<Connection> = {
                                isFavorite: existing.isFavorite,
                                pinnedFeatures: existing.pinnedFeatures,
                                icon: existing.icon,
                                lastConnected: existing.lastConnected,
                                homePath: existing.homePath,
                                createdAt: existing.createdAt,
                            };
                            nextConnections[targetIndex] = {
                                ...normalizedConnection,
                                ...preservedMetadata,
                                id: existing.id,
                                status: existing.status,
                                jumpServerId: resolveJumpServerId(normalizedConnection.jumpServerId, existing.jumpServerId),
                            };
                            return;
                        }
                    }

                    creates.push({
                        ...normalizedConnection,
                        jumpServerId: resolveJumpServerId(normalizedConnection.jumpServerId, undefined),
                    });
                });

                finalConns = creates.length > 0
                    ? mergeImportedConnections(nextConnections, creates)
                    : nextConnections;
            } else {
                finalConns = mergeImportedConnections(state.connections, newConns as Connection[]);
            }

            finalConns = finalConns.map((connection) => ({
                ...connection,
                folder: normalizeFolderPath(connection.folder || ''),
            }));
            const existingById = new Map(state.connections.map(connection => [connection.id, connection] as const));
            finalConns.forEach((connection) => {
                const existing = existingById.get(connection.id);
                if (!existing) return;
                if (!hasRemoteTargetChanged(existing, connection)) return;
                clearRemoteShellCache(connection.id);
            });
            const folderMap = new Map(state.folders.map((folder) => [normalizeFolderPath(folder.name), folder] as const));
            importedFolders.forEach((folder) => {
                const normalized = normalizeFolderPath(folder.name);
                if (!normalized) return;
                const existing = folderMap.get(normalized);
                if (existing) {
                    if (folder.tags && folder.tags.length > 0) {
                        existing.tags = folder.tags;
                    }
                    return;
                }
                folderMap.set(normalized, { ...folder, name: normalized });
            });
            finalConns.forEach((connection) => {
                const normalized = normalizeFolderPath(connection.folder || '');
                if (!normalized) return;
                if (!folderMap.has(normalized)) {
                    folderMap.set(normalized, { name: normalized });
                }
            });
            const updatedFolders = Array.from(folderMap.values());

            saveToMain(finalConns, updatedFolders);
            return { connections: finalConns, folders: updatedFolders };
        });
    },

    clearConnections: () => {
        get().connections.forEach(conn => {
            clearRemoteShellCache(conn.id);
        });
        set({
            connections: [],
            folders: [],
            tabs: [],
            activeTabId: null,
            activeConnectionId: null,
            showWelcomeScreen: true,
        });
        saveToMain([], []);
        get().saveSession();
    },

    connect: async (id) => {
        // Optimistic update
        set(state => ({
            connections: markConnectionStatus(state.connections, id, 'connecting')
        }));

        try {
            if (id === 'local') {
                return; // Local connects instantly usually
            }

            const connections = get().connections;
            const conn = connections.find(c => c.id === id);
            if (!conn) throw new Error('Connection not found');

            const fullConfig = buildConnectConfig(connections, id);
            if (!fullConfig) {
                set(state => ({ connections: markConnectionStatus(state.connections, id, 'error') }));
                get().showToast('error', `Couldn't build connection config for "${conn.name}". If this uses a jump host, re-import your SSH config to repair the reference.`, 8000);
                return;
            }

            console.log('[CONNECT] Connecting with config:', fullConfig);

            const response = await connectIpc(fullConfig);

            // Fetch home path after connection
            let homePath = '/';
            try {
                homePath = await getRemoteCwdIpc(id);
            } catch (e) {
                console.error('[CONNECT] Failed to fetch home path:', e);
            }

            set(state => {
                const newConns = markConnectionConnected(state.connections, id, homePath, response?.detected_os);
                saveToMain(newConns, state.folders);
                return { connections: newConns };
            });

            // Clear pendingRestore so SSH terminal tabs can now spawn their PTYs.
            get().clearPendingRestore(id);


            // Auto-start tunnels
            try {
                await get().loadTunnels(id);
                // @ts-ignore - tunnels slice access
                const tunnels = get().tunnels[id] || [];
                // @ts-ignore
                const startTunnel = get().startTunnel;

                const autoStartCount = await startAutoStartTunnels(
                    tunnels,
                    id,
                    startTunnel,
                    (tunnel, error) => console.error(`Failed to auto-start tunnel ${tunnel.name}:`, error),
                );

                if (autoStartCount > 0) {
                    // 1. Pin 'port-forwarding' feature if not already pinned
                    const conn = get().connections.find(c => c.id === id);
                    if (conn) {
                        pinFeatureOnConnectionIfNeeded<Connection>(conn, 'port-forwarding', (next) => get().editConnection(next));
                    }

                    // User requested silent open, so we do NOT switch view.
                    // The terminal view remains active by default.
                }
            } catch (err) {
                console.error('Failed to load/start tunnels:', err);
            }
        } catch (error) {
            console.error('Connection failed:', error);
            // Only update to error state if not already in error to prevent loops
            set(state => {
                const nextConnections = markConnectionErrorIfNeeded(state.connections, id);
                if (nextConnections === state.connections) return state;
                return { connections: nextConnections };
            });
        }
    },

    disconnect: async (id) => {
        try {
            await disconnectIpc(id);
        } catch (error) {
            console.error('Failed to disconnect backend:', error);
        } finally {
            // Clear terminals for this connection to ensure fresh terminals on reconnect
            get().clearTerminals(id);

            // Always update state to disconnected to ensure UI reflects closure
            set(state => ({
                connections: markConnectionStatus(state.connections, id, 'disconnected')
            }));
        }
    },

    openTab: (connectionId, startView: CoreTabView = 'terminal') => {
        set(state => {
            if (connectionId === LOCAL_TERMINAL_CONNECTION_ID) {
                return { ...createLocalTerminalTabState(state.tabs), lastRealConnectionId: LOCAL_TERMINAL_CONNECTION_ID, showWelcomeScreen: false };
            }

            const conn = state.connections.find(c => c.id === connectionId);
            if (!conn) {
                console.warn('[connectionSlice] openTab: missing connection', { connectionId, connectionCount: state.connections.length });
                return state;
            }

            const existingTab = findConnectionTab(state.tabs, conn.id);

            if (existingTab) {
                // Auto connect if disconnected or error even if tab exists (e.g. user clicked to reconnect)
                if (conn.status === 'disconnected' || conn.status === 'error') {
                    get().connect(conn.id);
                }

                return { ...activateExistingConnectionTab(state.tabs, existingTab, startView), lastRealConnectionId: conn.id, showWelcomeScreen: false };
            }

            // Auto connect if disconnected or error
            if (conn.status === 'disconnected' || conn.status === 'error') {
                get().connect(conn.id);
            }

            return { ...createConnectionTabState(state.tabs, conn, startView), lastRealConnectionId: conn.id, showWelcomeScreen: false };
        });
        // Dirty-checked in sessionSlice — redundant calls are harmless.
        get().saveSession();
    },

    openPortForwardingTab: () => {
        set(state => {
            return { ...ensureSingleTabByType(state.tabs, 'port-forwarding', () => ({
                id: crypto.randomUUID(),
                type: 'port-forwarding',
                title: 'Port Forwarding',
                view: 'port-forwarding',
            })), showWelcomeScreen: false };
        });
        // Dirty-checked in sessionSlice — redundant calls are harmless.
        get().saveSession();
    },

    openReleaseNotesTab: () => {
        set(state => {
            return { ...ensureSingleTabByType(state.tabs, 'release-notes', () => ({
                id: crypto.randomUUID(),
                type: 'release-notes',
                title: "What's New",
                view: 'terminal', // placeholder, not used for this type
            })), showWelcomeScreen: false };
        });
        // Dirty-checked in sessionSlice — redundant calls are harmless.
        get().saveSession();
    },

    openSettingsJsonTab: () => {
        set(state => {
            // Reuse a single settings.json workspace tab instance.
            return {
                ...ensureSingleTabByType(state.tabs, 'settings', () => ({
                    id: crypto.randomUUID(),
                    type: 'settings',
                    title: 'settings.json',
                    view: 'terminal',
                })),
                showWelcomeScreen: false,
            };
        });
        get().saveSession();
    },

    openSnippetsTab: () => {
        set(state => {
            return { ...ensureGlobalSnippetsTab(state.tabs), showWelcomeScreen: false };
        });
        // Dirty-checked in sessionSlice — redundant calls are harmless.
        get().saveSession();
    },

    closeTab: (tabId) => {
        const state = get();
        const tab = state.tabs.find(t => t.id === tabId);

        const preActions = getCloseTabPreActions(tab, state.tabs, state.connections);
        if (preActions.disconnectConnectionId) {
            get().disconnect(preActions.disconnectConnectionId);
        }
        if (preActions.clearLocalTerminals) {
            get().clearTerminals('local');
        }

        set(state => {
            const next = reduceTabCloseState(state.tabs, state.activeTabId, tabId);
            return {
                ...next,
                showWelcomeScreen: next.tabs.length === 0 || next.activeTabId === null,
            };
        });
        // Dirty-checked in sessionSlice — redundant calls are harmless.
        get().saveSession();
    },

    activateTab: (tabId) => {
        let didActivate = false;
        set(state => {
            const tab = state.tabs.find(t => t.id === tabId);
            if (!tab) return state;
            didActivate = true;
            const newConnId = tab.connectionId || null;
            const isReal = newConnId !== null && newConnId !== GLOBAL_SNIPPETS_CONNECTION_ID;
            return {
                activeTabId: tabId,
                activeConnectionId: newConnId,
                showWelcomeScreen: false,
                ...(isReal && { lastRealConnectionId: newConnId }),
            };
        });
        if (!didActivate) return;
        // Dirty-checked in sessionSlice — redundant calls are harmless.
        get().saveSession();
    },

    goHome: () => {
        set({ activeTabId: null, activeConnectionId: null, showWelcomeScreen: true });
        get().saveSession();
    },

    setTabView: (tabId, view) => {
        set(state => ({
            tabs: state.tabs.map(t => t.id === tabId ? { ...t, view } : t)
        }));
    },

    addFolder: (name, tags) => {
        set(state => {
            const next = addFolderToState(state, name, tags);
            if (next.folders === state.folders) return state;
            saveToMain(state.connections, next.folders);
            return { folders: next.folders };
        });
    },

    deleteFolder: (name) => {
        // Simplified Logic: Just remove for now, full recursive logic is huge to copy-paste blindly.
        // We should really try to preserve that logic if possible.
        // Implementation note: The original deleteFolder logic was complex. 
        // I will copy the simple removal for now to ensure structural integrity, 
        // then we can refine the recursive move logic.
        /* 
           Original Context logic was handling sub-folders and moving connections up.
           For this migration step, let's implement basic deletion to pass Typescript.
        */
        set(state => {
            const next = deleteFolderFromState(state, name);
            saveToMain(next.connections, next.folders);
            return { folders: next.folders, connections: next.connections };
        });
    },

    renameFolder: (oldName, newName, newTags) => {
        set(state => {
            const next = renameFolderInState(state, oldName, newName, newTags);

            saveToMain(next.connections, next.folders);
            return { folders: next.folders, connections: next.connections };
        });
    },

    updateConnectionFolder: (connectionId, folderName) => {
        set(state => {
            const next = updateConnectionFolderInState(state, connectionId, folderName);
            saveToMain(next.connections, next.folders);
            return { connections: next.connections, folders: next.folders };
        });
    },

    reorderTabs: (oldIndex, newIndex) => {
        set(state => {
            const newTabs = [...state.tabs];
            const [movedTab] = newTabs.splice(oldIndex, 1);
            newTabs.splice(newIndex, 0, movedTab);
            return { tabs: newTabs };
        });
        // Dirty-checked in sessionSlice — redundant calls are harmless.
        get().saveSession();
    },

    restoreTabState: (snapshots, activeTabId, activeConnectionId, showWelcomeScreen = false) => {
        set(state => {
        const RESTORABLE_TYPES = new Set(['connection', 'port-forwarding', 'release-notes', 'snippets', 'settings']);
            const tabs: Tab[] = snapshots
                .filter(s => RESTORABLE_TYPES.has(s.tabType))
                .filter(s => {
                    // Drop connection tabs whose connection was deleted.
                    // 'local' is always valid — it is not in the connections array.
                    if (s.tabType === 'connection') {
                        return s.connectionId === 'local' || state.connections.some(c => c.id === s.connectionId);
                    }
                    return true;
                })
                .map(s => {
                    const isPluginView = typeof s.view === 'string' && s.view.startsWith('plugin:');
                    const view: Tab['view'] = VALID_RESTORABLE_VIEWS.has(s.view as CoreTabView) || isPluginView
                        ? (s.view as Tab['view'])
                        : 'terminal';
                    return {
                        id: s.id,
                        type: s.tabType as Tab['type'],
                        title: s.title,
                        connectionId: s.connectionId,
                        view,
                    };
                });

            if (tabs.length === 0) {
                return {
                    tabs: [],
                    activeTabId: null,
                    activeConnectionId: null,
                    showWelcomeScreen: true,
                };
            }

            const resolvedActiveId =
                activeTabId && tabs.some(t => t.id === activeTabId)
                    ? activeTabId
                    : tabs[0].id;
            const resolvedTab = tabs.find(t => t.id === resolvedActiveId);
            // Validate activeConnectionId against loaded connections before using as fallback.
            const activeConnectionIdValid =
                activeConnectionId === 'local' ||
                state.connections.some(c => c.id === activeConnectionId);
            const resolvedConnId =
                resolvedTab?.connectionId ?? (activeConnectionIdValid ? activeConnectionId : null);

            // When the restored active tab is the global snippets tab (a pseudo-tab with
            // no real connection), fall back to the most recent real connection tab so
            // SnippetsManager has a valid target even before the user switches tabs.
            const lastConnectionTabIdFallback =
                [...tabs].reverse().find((t: Tab) =>
                    t.type === 'connection' && !!t.connectionId && t.connectionId !== GLOBAL_SNIPPETS_CONNECTION_ID
                )?.connectionId ?? null;
            const lastRealConnectionId =
                resolvedConnId !== null && resolvedConnId !== GLOBAL_SNIPPETS_CONNECTION_ID
                    ? resolvedConnId
                    : lastConnectionTabIdFallback;

            return showWelcomeScreen
                ? { tabs, activeTabId: null, activeConnectionId: null, lastRealConnectionId, showWelcomeScreen: true }
                : { tabs, activeTabId: resolvedActiveId, activeConnectionId: resolvedConnId, lastRealConnectionId, showWelcomeScreen: false };
        });
    },

    toggleFavorite: (connectionId) => {
        set(state => {
            const newConns = state.connections.map(c =>
                c.id === connectionId ? { ...c, isFavorite: !c.isFavorite } : c
            );
            saveToMain(newConns, state.folders);
            return { connections: newConns };
        });
    },

    toggleConnectionFeature: (connectionId, feature) => {
        if (connectionId === 'local') {
            const current = get().settings.localTerm?.pinnedFeatures || [];
            const updated = current.includes(feature)
                ? current.filter(f => f !== feature)
                : [...current, feature];
            // Use specific store method to sync pined features to local terminal settings
            (get() as any as AppStore).updateLocalTermSettings({ pinnedFeatures: updated });
            return;
        }

        set(state => {
            const newConns = state.connections.map(c => {
                if (c.id !== connectionId) return c;
                const current = c.pinnedFeatures || [];
                const updated = current.includes(feature)
                    ? current.filter(f => f !== feature)
                    : [...current, feature];
                return { ...c, pinnedFeatures: updated };
            });
            saveToMain(newConns, state.folders);
            return { connections: newConns };
        });
    }
});

let pendingSave: Promise<void> = Promise.resolve();

function hasRemoteTargetChanged(previous: Connection, next: Connection): boolean {
    return previous.host !== next.host
        || previous.port !== next.port
        || previous.username !== next.username
        || previous.jumpServerId !== next.jumpServerId
        || previous.privateKeyPath !== next.privateKeyPath
        || previous.password !== next.password;
}

const saveToMain = (connections: Connection[], folders: Folder[]): Promise<void> => {
    pendingSave = pendingSave
        .then(() => saveConnectionsIpc(connections, folders))
        .catch((error) => {
            console.error('Failed to save connections:', error);
        });
    return pendingSave;
};
