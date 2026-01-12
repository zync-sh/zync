import { StateCreator } from 'zustand';
import type { AppStore } from './useAppStore';

export interface Transfer {
    id: string;
    sourceConnectionId: string;
    sourcePath: string;
    destinationConnectionId: string;
    destinationPath: string;
    status: 'pending' | 'transferring' | 'completed' | 'failed' | 'cancelled';
    progress: {
        transferred: number;
        total: number;
        percentage: number;
    };
    error?: string;
    startTime: number;
}

export interface TransferSlice {
    transfers: Transfer[];
    addTransfer: (transfer: Omit<Transfer, 'id' | 'status' | 'progress' | 'startTime'>) => string;
    updateTransferProgress: (id: string, progress: Transfer['progress']) => void;
    completeTransfer: (id: string) => void;
    failTransfer: (id: string, error: string) => void;
    cancelTransfer: (id: string) => void;
    removeTransfer: (id: string) => void;
}

export const createTransferSlice: StateCreator<AppStore, [], [], TransferSlice> = (set) => ({
    transfers: [],

    addTransfer: (transfer: Omit<Transfer, 'id' | 'status' | 'progress' | 'startTime'>) => {
        const id = Math.random().toString(36).substr(2, 9);
        const newTransfer: Transfer = {
            ...transfer,
            id,
            status: 'pending',
            progress: { transferred: 0, total: 0, percentage: 0 },
            startTime: Date.now(),
        };
        set((state: AppStore) => ({ transfers: [...state.transfers, newTransfer] }));
        return id;
    },

    updateTransferProgress: (id: string, progress: Transfer['progress']) => {
        set((state: AppStore) => ({
            transfers: state.transfers.map((t: Transfer) => t.id === id ? { ...t, status: 'transferring', progress } : t)
        }));
    },

    completeTransfer: (id: string) => {
        set((state: AppStore) => ({
            transfers: state.transfers.map((t: Transfer) => t.id === id ? { ...t, status: 'completed' } : t)
        }));
    },

    failTransfer: (id: string, error: string) => {
        set((state: AppStore) => ({
            transfers: state.transfers.map((t: Transfer) => t.id === id ? { ...t, status: 'failed', error } : t)
        }));
    },

    cancelTransfer: (id: string) => {
        set((state: AppStore) => ({
            transfers: state.transfers.map((t: Transfer) => t.id === id ? { ...t, status: 'cancelled' } : t)
        }));
    },

    removeTransfer: (id: string) => {
        set((state: AppStore) => ({
            transfers: state.transfers.filter((t: Transfer) => t.id !== id)
        }));
    }
});
