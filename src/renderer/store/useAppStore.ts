import { create } from 'zustand';
import { ConnectionSlice, createConnectionSlice } from './connectionSlice';
import { SettingsSlice, createSettingsSlice } from './settingsSlice';
import { TransferSlice, createTransferSlice } from './transferSlice';
import { ToastSlice, createToastSlice } from './toastSlice';
import { SnippetsSlice, createSnippetsSlice } from './snippetsSlice';
import { TunnelSlice, createTunnelSlice } from './tunnelSlice';
import { TerminalSlice, createTerminalSlice } from './terminalSlice';
import { FileSystemSlice, createFileSystemSlice } from './fileSystemSlice';

// Re-export types for convenience
export type { Connection, Folder, Tab } from './connectionSlice';
export type { AppSettings } from './settingsSlice';
export type { Transfer } from './transferSlice';
export type { Toast, ToastType } from './toastSlice';
export type { Snippet } from './snippetsSlice';
export type { TunnelConfig } from './tunnelSlice';
export type { TerminalTab } from './terminalSlice';

export type AppStore = ConnectionSlice & SettingsSlice & TransferSlice & ToastSlice & SnippetsSlice & TunnelSlice & TerminalSlice & FileSystemSlice;

export const useAppStore = create<AppStore>()((...a) => ({
    ...createConnectionSlice(...a),
    ...createSettingsSlice(...a),
    ...createTransferSlice(...a),
    ...createToastSlice(...a),
    ...createSnippetsSlice(...a),
    ...createTunnelSlice(...a),
    ...createTerminalSlice(...a),
    ...createFileSystemSlice(...a),
}));
