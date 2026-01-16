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
    tunnels: TunnelConfig[];
    isLoadingTunnels: boolean;

    // Actions
    loadTunnels: (connectionId: string) => Promise<void>;
    saveTunnel: (tunnel: TunnelConfig) => Promise<void>;
    deleteTunnel: (id: string, connectionId: string) => Promise<void>;
    startTunnel: (id: string, connectionId: string) => Promise<void>;
    stopTunnel: (id: string, connectionId: string) => Promise<void>;
    updateTunnelStatus: (id: string, status: TunnelConfig['status'], error?: string) => void;
}

// @ts-ignore
const ipc = window.ipcRenderer;

export const createTunnelSlice: StateCreator<AppStore, [], [], TunnelSlice> = (set, get) => ({
    tunnels: [],
    isLoadingTunnels: false,

    loadTunnels: async (connectionId) => {
        set({ isLoadingTunnels: true });
        try {
            const list = await ipc.invoke('tunnel:list', connectionId);
            set({ tunnels: list || [], isLoadingTunnels: false });
        } catch (error) {
            console.error('Failed to load tunnels:', error);
            set({ isLoadingTunnels: false });
        }
    },

    saveTunnel: async (tunnel) => {
        // Optimistic Update
        const oldTunnels = get().tunnels;
        const exists = oldTunnels.some(t => t.id === tunnel.id);

        let newTunnels;
        if (exists) {
            newTunnels = oldTunnels.map(t => t.id === tunnel.id ? tunnel : t);
        } else {
            newTunnels = [...oldTunnels, tunnel];
        }

        set({ tunnels: newTunnels });

        try {
            await ipc.invoke('tunnel:save', tunnel);
            // Optionally reload to ensure consistency
        } catch (error) {
            console.error('Failed to save tunnel:', error);
            set({ tunnels: oldTunnels }); // Revert
            get().showToast('error', 'Failed to save tunnel');
            throw error;
        }
    },

    deleteTunnel: async (id, _connectionId) => {
        const oldTunnels = get().tunnels;
        const newTunnels = oldTunnels.filter(t => t.id !== id);
        set({ tunnels: newTunnels });

        try {
            await ipc.invoke('tunnel:delete', id);
        } catch (error) {
            console.error('Failed to delete tunnel:', error);
            set({ tunnels: oldTunnels }); // Revert
            get().showToast('error', 'Failed to delete tunnel');
            throw error;
        }
    },

    startTunnel: async (id, _connectionId) => {
        try {
            await ipc.invoke('tunnel:start', id);
            // Status update will likely come via IPC event, but we can optimistically set it?
            // Better to wait for event or just set it to 'active' if successful.
            get().updateTunnelStatus(id, 'active');
        } catch (error: any) {
            console.error('Failed to start tunnel:', error);
            get().updateTunnelStatus(id, 'error', error.message);
            throw error;
        }
    },

    stopTunnel: async (id, _connectionId) => {
        try {
            await ipc.invoke('tunnel:stop', id);
            get().updateTunnelStatus(id, 'stopped');
        } catch (error: any) {
            console.error('Failed to stop tunnel:', error);
            get().showToast('error', 'Failed to stop tunnel');
            throw error;
        }
    },

    updateTunnelStatus: (id, status, error) => {
        set(state => ({
            tunnels: state.tunnels.map(t => t.id === id ? { ...t, status, error } : t)
        }));
    }
});
