import { create } from 'zustand';
import { ConnectionSlice, createConnectionSlice } from './connectionSlice';
import { SettingsSlice, createSettingsSlice } from './settingsSlice';
import { TransferSlice, createTransferSlice } from './transferSlice';
import { ToastSlice, createToastSlice } from './toastSlice';
import { SnippetsSlice, createSnippetsSlice } from './snippetsSlice';

// Re-export types for convenience
export type { Connection, Folder, Tab } from './connectionSlice';
export type { AppSettings } from './settingsSlice';
export type { Transfer } from './transferSlice';
export type { Toast, ToastType } from './toastSlice';
export type { Snippet } from './snippetsSlice';

export type AppStore = ConnectionSlice & SettingsSlice & TransferSlice & ToastSlice & SnippetsSlice;

export const useAppStore = create<AppStore>()((...a) => ({
    ...createConnectionSlice(...a),
    ...createSettingsSlice(...a),
    ...createTransferSlice(...a),
    ...createToastSlice(...a),
    ...createSnippetsSlice(...a),
}));
