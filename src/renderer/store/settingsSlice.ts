import { StateCreator } from 'zustand';
import type { AppStore } from './useAppStore';

export interface AppSettings {
    theme: 'dark' | 'light' | 'dracula' | 'monokai' | 'warm' | 'light-warm' | 'midnight' | 'system';
    accentColor?: string;
    windowOpacity: number;
    enableVibrancy: boolean;
    compactMode: boolean;
    sidebarWidth: number;
    sidebarCollapsed: boolean;
    terminal: {
        fontSize: number;
        fontFamily: string;
        cursorStyle: 'block' | 'underline' | 'bar';
        lineHeight: number;
        padding: number;
    };
    fileManager: {
        showHiddenFiles: boolean;
        confirmDelete: boolean;
        defaultDownloadPath: string;
    };
    localTerm: {
        windowsShell: string;
    };
    keybindings: {
        toggleSidebar: string;
        openNewConnection: string;
        newLocalTerminal: string;
        newHostTerminal: string;
        toggleSettings: string;
        closeTab: string;
        closeTerminalTab: string;
        commandPalette: string;
        switchTabNext: string;
        switchTabPrev: string;
        // Terminal
        termCopy: string;
        termPaste: string;
        termFind: string;
        // View
        zoomIn: string;
        zoomOut: string;
        // Tab Jumping (1-9)
        switchTab1: string;
        switchTab2: string;
        switchTab3: string;
        switchTab4: string;
        switchTab5: string;
        switchTab6: string;
        switchTab7: string;
        switchTab8: string;
        switchTab9: string;
    };
    expandedFolders: string[];
}

const defaultSettings: AppSettings = {
    theme: 'dark',
    accentColor: undefined,
    windowOpacity: 0.95,
    enableVibrancy: false,
    compactMode: true,
    sidebarWidth: 288,
    sidebarCollapsed: false,
    expandedFolders: [],
    terminal: {
        fontSize: 14,
        fontFamily: "'Fira Code', monospace",
        cursorStyle: 'block',
        lineHeight: 1.2,
        padding: 12
    },
    fileManager: {
        showHiddenFiles: true,
        confirmDelete: true,
        defaultDownloadPath: ''
    },
    localTerm: {
        windowsShell: 'default'
    },
    keybindings: {
        toggleSidebar: 'Mod+B',
        openNewConnection: 'Mod+N',
        newLocalTerminal: 'Mod+T',
        newHostTerminal: 'Mod+Shift+T',
        toggleSettings: 'Mod+,',
        closeTab: 'Mod+W',
        closeTerminalTab: 'Mod+Shift+W',
        commandPalette: 'Mod+P',
        switchTabNext: 'Ctrl+Tab',
        switchTabPrev: 'Ctrl+Shift+Tab',
        // Terminal
        termCopy: 'Mod+Shift+C',
        termPaste: 'Mod+Shift+V',
        termFind: 'Mod+F',
        // View
        zoomIn: 'Mod+=',
        zoomOut: 'Mod+-',
        // Tab Jumping
        switchTab1: 'Mod+1',
        switchTab2: 'Mod+2',
        switchTab3: 'Mod+3',
        switchTab4: 'Mod+4',
        switchTab5: 'Mod+5',
        switchTab6: 'Mod+6',
        switchTab7: 'Mod+7',
        switchTab8: 'Mod+8',
        switchTab9: 'Mod+9',
    }
};

export interface SettingsSlice {
    settings: AppSettings;
    isSettingsOpen: boolean;
    isLoadingSettings: boolean;

    // Actions
    updateSettings: (settings: Partial<AppSettings>) => Promise<void>;
    updateTerminalSettings: (updates: Partial<AppSettings['terminal']>) => Promise<void>;
    updateLocalTermSettings: (updates: Partial<AppSettings['localTerm']>) => Promise<void>;
    updateFileManagerSettings: (updates: Partial<AppSettings['fileManager']>) => Promise<void>;
    updateKeybindings: (updates: Partial<AppSettings['keybindings']>) => Promise<void>;
    toggleExpandedFolder: (folderPath: string) => Promise<void>;

    openSettings: () => void;
    closeSettings: () => void;
    loadSettings: () => Promise<void>;
}

// @ts-ignore
const ipc = window.ipcRenderer;

export const createSettingsSlice: StateCreator<AppStore, [], [], SettingsSlice> = (set, get) => ({
    settings: defaultSettings,
    isSettingsOpen: false,
    isLoadingSettings: true,

    loadSettings: async () => {
        try {
            const loaded = await ipc.invoke('settings:get');
            const merged = {
                ...defaultSettings,
                ...loaded,
                terminal: { ...defaultSettings.terminal, ...(loaded?.terminal || {}) },
                fileManager: { ...defaultSettings.fileManager, ...(loaded?.fileManager || {}) },
                localTerm: { ...defaultSettings.localTerm, ...(loaded?.localTerm || {}) },
                keybindings: { ...defaultSettings.keybindings, ...(loaded?.keybindings || {}) },
                expandedFolders: loaded?.expandedFolders || []
            };
            set({ settings: merged, isLoadingSettings: false });
        } catch (error) {
            console.error('Failed to load settings:', error);
            set({ isLoadingSettings: false });
        }
    },

    updateSettings: async (newSettings) => {
        set(state => ({ settings: { ...state.settings, ...newSettings } }));
        try {
            await ipc.invoke('settings:set', newSettings);
        } catch (error) {
            console.error('Failed to save settings:', error);
        }
    },

    updateTerminalSettings: async (updates) => {
        set(state => ({
            settings: {
                ...state.settings,
                terminal: { ...state.settings.terminal, ...updates }
            }
        }));
        try {
            await ipc.invoke('settings:set', { terminal: { ...get().settings.terminal, ...updates } });
        } catch (error) {
            console.error('Failed to save terminal settings:', error);
        }
    },

    updateLocalTermSettings: async (updates) => {
        set(state => ({
            settings: {
                ...state.settings,
                localTerm: { ...state.settings.localTerm, ...updates }
            }
        }));
        try {
            await ipc.invoke('settings:set', { localTerm: { ...get().settings.localTerm, ...updates } });
        } catch (error) {
            console.error('Failed to save local terminal settings:', error);
        }
    },

    updateFileManagerSettings: async (updates) => {
        set(state => ({
            settings: {
                ...state.settings,
                fileManager: { ...state.settings.fileManager, ...updates }
            }
        }));
        try {
            await ipc.invoke('settings:set', { fileManager: { ...get().settings.fileManager, ...updates } });
        } catch (error) {
            console.error('Failed to save file manager settings:', error);
        }
    },

    updateKeybindings: async (updates) => {
        set(state => ({
            settings: {
                ...state.settings,
                keybindings: { ...state.settings.keybindings, ...updates }
            }
        }));
        try {
            await ipc.invoke('settings:set', { keybindings: { ...get().settings.keybindings, ...updates } });
        } catch (error) {
            console.error('Failed to save keybindings:', error);
        }
    },

    toggleExpandedFolder: async (folderPath) => {
        const current = get().settings.expandedFolders || [];
        const newFolders = current.includes(folderPath)
            ? current.filter(f => f !== folderPath)
            : [...current, folderPath];

        set(state => ({ settings: { ...state.settings, expandedFolders: newFolders } }));
        try {
            await ipc.invoke('settings:set', { expandedFolders: newFolders });
        } catch (error) {
            console.error('Failed to save expanded folders:', error);
        }
    },

    openSettings: () => set({ isSettingsOpen: true }),
    closeSettings: () => set({ isSettingsOpen: false }),
});
