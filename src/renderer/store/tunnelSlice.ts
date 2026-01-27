import { StateCreator } from 'zustand';
import type { AppStore } from './useAppStore';

export interface TunnelConfig {
    id: string;
    connectionId: string;
    name: string;
    type: 'local' | 'remote';
    localPort: number;
    remoteHost: string;
    remotePort: number;
    bindToAny?: boolean;
    status: 'active' | 'error' | 'stopped';
    autoStart?: boolean;
    error?: string;
}

export interface TunnelSlice {
    tunnels: Record<string, TunnelConfig[]>;
    isLoadingTunnels: boolean;

    // Actions
    loadTunnels: (connectionId: string) => Promise<void>;
    saveTunnel: (tunnel: TunnelConfig) => Promise<void>;
    deleteTunnel: (id: string, connectionId: string) => Promise<void>;
    startTunnel: (id: string, connectionId: string) => Promise<void>;
    stopTunnel: (id: string, connectionId: string) => Promise<void>;
    updateTunnelStatus: (id: string, connectionId: string, status: TunnelConfig['status'], error?: string) => void;
}

// @ts-ignore
const ipc = window.ipcRenderer;

export const createTunnelSlice: StateCreator<AppStore, [], [], TunnelSlice> = (set, get) => ({
    tunnels: {},
    isLoadingTunnels: false,

    loadTunnels: async (connectionId) => {
        set({ isLoadingTunnels: true });
        try {
            const list = await ipc.invoke('tunnel:list', connectionId);
            set(state => ({
                tunnels: {
                    ...state.tunnels,
                    [connectionId]: list || []
                },
                isLoadingTunnels: false
            }));
        } catch (error) {
            console.error('Failed to load tunnels:', error);
            set({ isLoadingTunnels: false });
        }
    },

    saveTunnel: async (tunnel) => {
        const connectionId = tunnel.connectionId;
        const oldList = get().tunnels[connectionId] || [];
        const exists = oldList.some(t => t.id === tunnel.id);

        let newList;
        if (exists) {
            newList = oldList.map(t => t.id === tunnel.id ? tunnel : t);
        } else {
            newList = [...oldList, tunnel];
        }

        // Optimistic
        set(state => ({
            tunnels: {
                ...state.tunnels,
                [connectionId]: newList
            }
        }));

        try {
            await ipc.invoke('tunnel:save', tunnel);
        } catch (error) {
            console.error('Failed to save tunnel:', error);
            // Revert
            set(state => ({
                tunnels: {
                    ...state.tunnels,
                    [connectionId]: oldList
                }
            }));
            get().showToast('error', 'Failed to save tunnel');
            throw error;
        }
    },

    deleteTunnel: async (id, connectionId) => {
        const oldList = get().tunnels[connectionId] || [];
        const newList = oldList.filter(t => t.id !== id);

        // Optimistic
        set(state => ({
            tunnels: {
                ...state.tunnels,
                [connectionId]: newList
            }
        }));

        try {
            await ipc.invoke('tunnel:delete', id);
        } catch (error) {
            console.error('Failed to delete tunnel:', error);
            // Revert
            set(state => ({
                tunnels: {
                    ...state.tunnels,
                    [connectionId]: oldList
                }
            }));
            get().showToast('error', 'Failed to delete tunnel');
            throw error;
        }
    },

    startTunnel: async (id, connectionId) => {
        try {
            await ipc.invoke('tunnel:start', id);
            get().updateTunnelStatus(id, connectionId, 'active');
        } catch (error: any) {
            console.error('Failed to start tunnel:', error);
            get().updateTunnelStatus(id, connectionId, 'error', error.message);
            throw error;
        }
    },

    stopTunnel: async (id, connectionId) => {
        try {
            await ipc.invoke('tunnel:stop', id);
            get().updateTunnelStatus(id, connectionId, 'stopped');
        } catch (error: any) {
            console.error('Failed to stop tunnel:', error);
            get().showToast('error', 'Failed to stop tunnel');
            throw error;
        }
    },

    updateTunnelStatus: (id, connectionId, status, error) => {
        set(state => {
            const currentList = state.tunnels[connectionId] || [];
            return {
                tunnels: {
                    ...state.tunnels,
                    [connectionId]: currentList.map(t => t.id === id ? { ...t, status, error } : t)
                }
            };
        });
    }
});
