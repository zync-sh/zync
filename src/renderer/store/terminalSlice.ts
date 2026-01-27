import { StateCreator } from 'zustand';
import type { AppStore } from './useAppStore';
import { destroyTerminalInstance } from '../components/Terminal';

export interface TerminalTab {
    id: string;
    title: string;
}

export interface TerminalSlice {
    // Keyed by connectionId
    terminals: Record<string, TerminalTab[]>;
    activeTerminalIds: Record<string, string | null>;

    // Actions
    createTerminal: (connectionId: string) => string; // Returns new ID
    ensureTerminal: (connectionId: string) => void;
    closeTerminal: (connectionId: string, termId: string) => void;
    setActiveTerminal: (connectionId: string, termId: string) => void;
    // Helper to clear terminals for a connection
    clearTerminals: (connectionId: string) => void;
}

// @ts-ignore
const ipc = window.ipcRenderer;

export const createTerminalSlice: StateCreator<AppStore, [], [], TerminalSlice> = (set, get) => ({
    terminals: {},
    activeTerminalIds: {},

    createTerminal: (connectionId) => {
        const newId = `term-${crypto.randomUUID()}`;
        set(state => {
            const currentTabs = state.terminals[connectionId] || [];
            const newTab: TerminalTab = { id: newId, title: `Terminal ${currentTabs.length + 1}` };

            return {
                terminals: {
                    ...state.terminals,
                    [connectionId]: [...currentTabs, newTab]
                },
                activeTerminalIds: {
                    ...state.activeTerminalIds,
                    [connectionId]: newId
                }
            };
        });
        return newId;
    },

    ensureTerminal: (connectionId) => {
        const state = get();
        const currentTabs = state.terminals[connectionId] || [];
        if (currentTabs.length === 0) {
            get().createTerminal(connectionId);
        }
    },

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

            return {
                terminals: {
                    ...state.terminals,
                    [connectionId]: newTabs
                },
                activeTerminalIds: {
                    ...state.activeTerminalIds,
                    [connectionId]: newActiveId
                }
            };
        });
    },

    setActiveTerminal: (connectionId, termId) => {
        set(state => ({
            activeTerminalIds: {
                ...state.activeTerminalIds,
                [connectionId]: termId
            }
        }));
    },

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

            return {
                terminals: newTerminals,
                activeTerminalIds: newActiveIds
            };
        });
    }
});
