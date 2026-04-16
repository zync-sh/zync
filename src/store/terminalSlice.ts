import { StateCreator } from 'zustand';
import type { AppStore } from './useAppStore';
import { destroyTerminalInstance } from '../components/Terminal';
import type { TerminalTabSnapshot } from './sessionSlice';
import { scheduleSaveSession } from './sessionSlice';

export interface TerminalTab {
    id: string;
    title: string;
    initialPath?: string;
    lastKnownCwd?: string;
    isSynced?: boolean;
    /** True for SSH terminal tabs restored from session — PTY not yet spawned, waiting for reconnect. */
    pendingRestore?: boolean;
}

export interface TerminalSlice {
    /** Keyed by connectionId, stores the list of terminal tabs for each connection */
    terminals: Record<string, TerminalTab[]>;
    /** Keyed by connectionId, stores the ID of the currently active terminal tab */
    activeTerminalIds: Record<string, string | null>;
    /** Keyed by connectionId, stores the ID of the terminal that is currently synced with the File Manager */
    syncedTerminalId: Record<string, string | null>;

    // Actions
    /**
     * Creates a new terminal tab for a specific connection.
     * @param connectionId The ID of the connection to create the terminal for.
     * @param initialPath Optional starting directory.
     * @param isSynced Whether this terminal should sync with File Manager navigation.
     * @returns The generated ID of the new terminal.
     */
    createTerminal: (connectionId: string, initialPath?: string, isSynced?: boolean) => string;

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

    /**
     * Sets a specific terminal as the active one for a connection.
     * @param connectionId The ID of the connection.
     * @param termId The ID of the terminal to make active.
     */
    setActiveTerminal: (connectionId: string, termId: string) => void;

    /**
     * Clears all terminal tabs for a specific connection and prunes all associated AI history.
     * @param connectionId The ID of the connection to clear terminals for.
     */
    clearTerminals: (connectionId: string) => void;

    /**
     * Updates the last known CWD of a terminal.
     */
    setTerminalCwd: (connectionId: string, termId: string, path: string) => void;

    /**
     * Updates the initialPath of a terminal tab record.
     */
    setTerminalInitialPath: (connectionId: string, termId: string, path: string) => void;

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
    ) => void;

    /**
     * Clears the pendingRestore flag on all terminal tabs for a connection.
     * Called after a successful SSH reconnect so tabs can spawn their PTYs.
     */
    clearPendingRestore: (connectionId: string) => void;
}

// @ts-ignore
const ipc = window.ipcRenderer;

export const createTerminalSlice: StateCreator<AppStore, [], [], TerminalSlice> = (set, get) => ({
    terminals: {},
    activeTerminalIds: {},
    syncedTerminalId: {},

    /** @inheritdoc */
    createTerminal: (connectionId, initialPath, isSynced) => {
        const newId = `term-${crypto.randomUUID()}`;
        set(state => {
            const currentTabs = state.terminals[connectionId] || [];
            const newTab: TerminalTab = {
                id: newId,
                title: isSynced ? `Synced Terminal` : `Terminal ${currentTabs.length + 1}`,
                initialPath,
                isSynced
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
                syncedTerminalId: nextSyncedIds
            };
        });
        get().saveSession();
        return newId;
    },

    /** @inheritdoc */
    ensureTerminal: (connectionId, initialPath) => {
        const state = get();
        const currentTabs = state.terminals[connectionId] || [];
        if (currentTabs.length === 0) {
            return get().createTerminal(connectionId, initialPath);
        }
        const activeId = state.activeTerminalIds[connectionId];
        if (activeId) {
            return activeId;
        }
        return currentTabs[0].id;
    },

    /** @inheritdoc */
    closeTerminal: (connectionId, termId) => {
        // Kill backend process first
        ipc.send('terminal:kill', { termId });

        // Destroy the xterm instance from cache (frees memory, clears history)
        destroyTerminalInstance(termId);

        set(state => {
            const currentTabs = state.terminals[connectionId] || [];
            const newTabs = currentTabs.filter(t => t.id !== termId);

            // Determine new active tab if we closed the active one
            let newActiveId = state.activeTerminalIds[connectionId];
            if (newActiveId === termId) {
                newActiveId = newTabs.length > 0 ? newTabs[newTabs.length - 1].id : null;
            }

            // Cleanup synced terminal reference if closed
            const nextSyncedIds = { ...state.syncedTerminalId };
            if (nextSyncedIds[connectionId] === termId) {
                nextSyncedIds[connectionId] = null;
            }

            // 🗑️ Free AI conversation history for the closed tab (memory-safe)
            const { [termId]: _, ...nextConversations } = state.aiConversations;

            // 🗑️ Free AI display history for the closed tab
            const { [termId]: __, ...nextDisplay } = state.aiDisplayHistory;

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
                aiConversations: nextConversations,
                aiDisplayHistory: nextDisplay,
            };
        });
        get().saveSession();
    },

    /** @inheritdoc */
    setActiveTerminal: (connectionId, termId) => {
        set(state => ({
            activeTerminalIds: {
                ...state.activeTerminalIds,
                [connectionId]: termId
            }
        }));
        get().saveSession();
    },

    /** @inheritdoc */
    clearTerminals: (connectionId) => {
        set(state => {
            // Kill all known terminals for this connection and destroy cached instances
            const tabs = state.terminals[connectionId] || [];
            tabs.forEach(t => {
                ipc.send('terminal:kill', { termId: t.id });
                destroyTerminalInstance(t.id);
            });

            const newTerminals = { ...state.terminals };
            delete newTerminals[connectionId];

            const newActiveIds = { ...state.activeTerminalIds };
            delete newActiveIds[connectionId];

            const newSyncedIds = { ...state.syncedTerminalId };
            delete newSyncedIds[connectionId];

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
                aiConversations: nextConversations,
                aiDisplayHistory: nextDisplay
            };
        });
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
    },

    /** @inheritdoc */
    restoreTerminalTabs: (connectionId, snapshots, activeTerminalId) => {
        const isSSH = connectionId !== 'local';
        const tabs: TerminalTab[] = snapshots.map(s => ({
            id: s.id,
            title: s.title,
            initialPath: s.initialPath,
            lastKnownCwd: s.cwd,
            isSynced: s.isSynced ?? false,
            pendingRestore: isSSH || undefined,
        }));

        const syncedTab = tabs.find(t => t.isSynced);
        set(state => ({
            terminals: {
                ...state.terminals,
                [connectionId]: tabs,
            },
            activeTerminalIds: {
                ...state.activeTerminalIds,
                [connectionId]: activeTerminalId ?? (tabs[0]?.id ?? null),
            },
            syncedTerminalId: {
                ...state.syncedTerminalId,
                [connectionId]: syncedTab?.id ?? null,
            },
        }));
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
});
