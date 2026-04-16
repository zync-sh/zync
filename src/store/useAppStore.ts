import { create } from 'zustand';
import { ConnectionSlice, createConnectionSlice } from './connectionSlice';
import { SettingsSlice, createSettingsSlice } from './settingsSlice';
import { TransferSlice, createTransferSlice } from './transferSlice';
import { ToastSlice, createToastSlice } from './toastSlice';
import { SnippetsSlice, createSnippetsSlice } from './snippetsSlice';
import { TunnelSlice, createTunnelSlice } from './tunnelSlice';
import { TerminalSlice, createTerminalSlice } from './terminalSlice';
import { FileSystemSlice, createFileSystemSlice } from './fileSystemSlice';
import { UpdateSlice, createUpdateSlice } from './updateSlice';
import { UiSlice, createUiSlice } from './uiSlice';
import { AiSlice, createAiSlice } from './aiSlice';
import { AiUiSlice, createAiUiSlice } from '../ai/store/agentStore';
import { SessionSlice, createSessionSlice } from './sessionSlice';

export type { Connection, Folder, Tab } from './connectionSlice';
export type { AppSettings } from './settingsSlice';
export type { Transfer } from './transferSlice';
export type { Toast, ToastType } from './toastSlice';
export type { Snippet } from './snippetsSlice';
export type { TunnelConfig } from './tunnelSlice';
export type { TerminalTab } from './terminalSlice';

export type AppStore =
    ConnectionSlice &
    SettingsSlice &
    TransferSlice &
    ToastSlice &
    SnippetsSlice &
    TunnelSlice &
    TerminalSlice &
    FileSystemSlice &
    UpdateSlice &
    UiSlice &
    AiUiSlice &
    AiSlice &
    SessionSlice & {
        lastAction: { message: string; type: 'success' | 'date' | 'info' | 'error' } | null;
        setLastAction: (message: string, type?: 'success' | 'info' | 'error') => void;
    };

export const useAppStore = create<AppStore>()(
    (...a) => ({
        ...createConnectionSlice(...a),
        ...createSettingsSlice(...a),
        ...createTransferSlice(...a),
        ...createToastSlice(...a),
        ...createSnippetsSlice(...a),
        ...createTunnelSlice(...a),
        ...createTerminalSlice(...a),
        ...createFileSystemSlice(...a),
        ...createUpdateSlice(...a),
        ...createUiSlice(...a),
        ...createAiUiSlice(...a),
        ...createAiSlice(...a),
        ...createSessionSlice(...a),

        lastAction: null,
        setLastAction: (message, type = 'info') => {
            // @ts-ignore
            a[0]({ lastAction: { message, type, date: Date.now() } });

            setTimeout(() => {
                // @ts-ignore
                const current = a[1]().lastAction;
                if (current && current.message === message) {
                    // @ts-ignore
                    a[0]({ lastAction: null });
                }
            }, 4000);
        }
    })
);
