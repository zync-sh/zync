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
    lastUpdated: number;
    speed: number; // bytes per second
    speedBaseline: number; // transferred value at the start of the current speed window
    label?: string; // optional custom phase label (e.g. 'Compressing')
}

export interface TransferSlice {
    transfers: Transfer[];
    addTransfer: (transfer: Omit<Transfer, 'id' | 'status' | 'progress' | 'startTime' | 'lastUpdated' | 'speed' | 'speedBaseline'>) => string;
    updateTransferProgress: (id: string, progress: Transfer['progress']) => void;
    completeTransfer: (id: string) => void;
    failTransfer: (id: string, error: string) => void;
    cancelTransfer: (id: string) => void;
    removeTransfer: (id: string) => void;
}

export const createTransferSlice: StateCreator<AppStore, [], [], TransferSlice> = (set) => ({
    transfers: [],

    addTransfer: (transfer: Omit<Transfer, 'id' | 'status' | 'progress' | 'startTime' | 'lastUpdated' | 'speed' | 'speedBaseline'>) => {
        const id = Math.random().toString(36).substring(2, 11);
        const newTransfer: Transfer = {
            ...transfer,
            id,
            status: 'pending',
            progress: { transferred: 0, total: 0, percentage: 0 },
            startTime: Date.now(),
            lastUpdated: Date.now(),
            speed: 0,
            speedBaseline: 0,
        };
        set((state: AppStore) => ({ transfers: [...state.transfers, newTransfer] }));
        return id;
    },

    updateTransferProgress: (id: string, progress: Transfer['progress']) => {
        const now = Date.now();
        set((state: AppStore) => ({
            transfers: state.transfers.map((t: Transfer) => {
                if (t.id !== id) return t;

                // Calculate Speed
                const timeDiff = (now - t.lastUpdated) / 1000; // seconds
                let newSpeed = t.speed;

                if (timeDiff >= 0.5) { // Update speed every 0.5s to avoid jitter
                    // Use speedBaseline (transferred at window start), NOT t.progress.transferred
                    // because t.progress gets updated every event while speedBaseline only resets here
                    const bytesDiff = progress.transferred - t.speedBaseline;
                    const currentSpeed = bytesDiff / timeDiff;

                    // Weighted Average (Erasure factor 0.3 -> 30% new, 70% old) for smoothness
                    if (t.speed === 0) {
                        newSpeed = currentSpeed;
                    } else {
                        newSpeed = (t.speed * 0.7) + (currentSpeed * 0.3);
                    }

                    // Advance window: reset both time and byte baseline
                    return { ...t, status: 'transferring', progress, speed: newSpeed, lastUpdated: now, speedBaseline: progress.transferred };
                }

                // Progress bar updates every event; speed window hasn't elapsed yet
                return { ...t, status: 'transferring', progress };
            })
        }));
    },

    completeTransfer: (id: string) => {
        // Step 1: Snap progress to 100% while still 'transferring' so the bar fills visually
        set((state: AppStore) => ({
            transfers: state.transfers.map((t: Transfer) => {
                if (t.id !== id) return t;
                const total = t.progress.total || 1;
                return { ...t, progress: { transferred: total, total, percentage: 100 } };
            })
        }));
        // Step 2: After the CSS transition (duration-300) plays, switch to 'completed' card
        setTimeout(() => {
            set((state: AppStore) => ({
                transfers: state.transfers.map((t: Transfer) => {
                    if (t.id !== id) return t;
                    // Guard: don't overwrite if already cancelled/failed during the delay
                    return t.status === 'transferring' ? { ...t, status: 'completed' } : t;
                })
            }));
        }, 400);
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
