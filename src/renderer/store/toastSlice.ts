import { StateCreator } from 'zustand';
import type { AppStore } from './useAppStore';

export type ToastType = 'success' | 'error' | 'warning' | 'info';

export interface Toast {
    id: string;
    type: ToastType;
    message: string;
    duration?: number;
}

export interface ToastSlice {
    toasts: Toast[];
    showToast: (type: ToastType, message: string, duration?: number) => void;
    removeToast: (id: string) => void;
}

export const createToastSlice: StateCreator<AppStore, [], [], ToastSlice> = (set) => ({
    toasts: [],

    showToast: (type: ToastType, message: string, duration: number = 3000) => {
        const id = Math.random().toString(36).substr(2, 9);
        const toast: Toast = { id, type, message, duration };

        set((state: ToastSlice) => ({ toasts: [...state.toasts, toast] }));

        if (duration > 0) {
            setTimeout(() => {
                set((state: ToastSlice) => ({ toasts: state.toasts.filter((t: Toast) => t.id !== id) }));
            }, duration);
        }
    },

    removeToast: (id: string) => {
        set((state: ToastSlice) => ({ toasts: state.toasts.filter((t: Toast) => t.id !== id) }));
    },
});
