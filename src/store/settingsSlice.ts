import { StateCreator } from 'zustand';
import { invoke } from '@tauri-apps/api/core';
import type { AppStore } from './useAppStore';
import { CODEMIRROR_EDITOR_ID } from '../components/editor/providers';

export interface AppSettings {
    theme: string;
    iconTheme: string;
    accentColor?: string;
    editor: {
        defaultProvider: string;
    };
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
        pinnedFeatures?: string[];
    };
    ghostSuggestions: {
        inlineEnabled: boolean;
        popupEnabled: boolean;
        contextMenuEnabled: boolean;
        providers: {
            history: boolean;
            filesystem: boolean;
        };
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

        // File Manager
        fmCopy: string;
        fmCut: string;
        fmPaste: string;
        fmSelectAll: string;
        fmRename: string;
        fmDelete: string;
        fmEditPath: string;
        fmOpen: string;
        fmUp: string;
        fmBack: string;
        fmForward: string;
        fmSearch: string;
        aiCommandBar: string;
    };
    expandedFolders: string[];
    ai: {
        provider: 'ollama' | 'gemini' | 'openai' | 'claude' | 'groq' | 'mistral';
        model?: string;
        ollamaUrl?: string;
        enabled: boolean;
    };
    lastSeenVersion: string;
}

const defaultSettings: AppSettings = {
    theme: 'dark',
    iconTheme: 'vscode-icons',
    accentColor: undefined,
    editor: {
        defaultProvider: CODEMIRROR_EDITOR_ID
    },
    windowOpacity: 1.0,
    enableVibrancy: false,
    compactMode: true,
    sidebarWidth: 288,
    sidebarCollapsed: false,
    expandedFolders: [],
    ai: {
        provider: 'ollama',
        ollamaUrl: 'http://localhost:11434',
        enabled: true,
    },
    lastSeenVersion: '',
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
    ghostSuggestions: {
        inlineEnabled: true,
        popupEnabled: true,
        contextMenuEnabled: false,
        providers: {
            history: true,
            filesystem: true,
        },
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

        // File Manager
        fmCopy: 'Mod+C',
        fmCut: 'Mod+X',
        fmPaste: 'Mod+V',
        fmSelectAll: 'Mod+A',
        fmRename: 'F2',
        fmDelete: 'Delete',
        fmEditPath: 'Mod+L',
        fmOpen: 'Enter',
        fmUp: 'Backspace',
        fmBack: 'Alt+Left',
        fmForward: 'Alt+Right',
        fmSearch: 'Mod+F',
        aiCommandBar: 'Mod+I',
    }
};

export interface SettingsSlice {
    settings: AppSettings;
    isSettingsOpen: boolean;
    isLoadingSettings: boolean;
    appRoot: string | null;

    // Actions
    updateSettings: (settings: Partial<AppSettings>) => Promise<void>;
    updateAiSettings: (updates: Partial<AppSettings['ai']>) => Promise<void>;
    updateEditorSettings: (updates: Partial<AppSettings['editor']>) => Promise<void>;
    updateTerminalSettings: (updates: Partial<AppSettings['terminal']>) => Promise<void>;
    updateLocalTermSettings: (updates: Partial<AppSettings['localTerm']>) => Promise<void>;
    updateFileManagerSettings: (updates: Partial<AppSettings['fileManager']>) => Promise<void>;
    updateGhostSuggestionsSettings: (updates: Partial<AppSettings['ghostSuggestions']>) => Promise<void>;
    updateKeybindings: (updates: Partial<AppSettings['keybindings']>) => Promise<void>;
    toggleExpandedFolder: (folderPath: string) => Promise<void>;

    openSettings: () => void;
    closeSettings: () => void;
    loadSettings: () => Promise<void>;
    fetchSystemInfo: () => Promise<void>;
}

export const createSettingsSlice: StateCreator<AppStore, [], [], SettingsSlice> = (set, get) => ({
    settings: defaultSettings,
    isSettingsOpen: false,
    isLoadingSettings: true,
    appRoot: null,

    loadSettings: async () => {
        try {
            const loaded = await invoke<AppSettings>('settings_get');
            const merged = {
                ...defaultSettings,
                ...loaded,
                editor: { ...defaultSettings.editor, ...(loaded?.editor || {}) },
                terminal: { ...defaultSettings.terminal, ...(loaded?.terminal || {}) },
                fileManager: { ...defaultSettings.fileManager, ...(loaded?.fileManager || {}) },
                localTerm: { ...defaultSettings.localTerm, ...(loaded?.localTerm || {}) },
                ghostSuggestions: {
                    ...defaultSettings.ghostSuggestions,
                    ...(loaded?.ghostSuggestions || {}),
                    providers: {
                        ...defaultSettings.ghostSuggestions.providers,
                        ...(loaded?.ghostSuggestions?.providers || {}),
                    },
                },
                keybindings: { ...defaultSettings.keybindings, ...(loaded?.keybindings || {}) },
                ai: { ...defaultSettings.ai, ...(loaded?.ai || {}) },
                expandedFolders: loaded?.expandedFolders || []
            };
            set({ settings: merged, isLoadingSettings: false });
        } catch (error) {
            console.error('Failed to load settings:', error);
            set({ isLoadingSettings: false });
        }
    },

    updateSettings: async (newSettings) => {
        let actualSettings = { ...newSettings };

        // If theme is changed but accentColor is not explicitly provided in the update,
        // reset accentColor to undefined to allow the theme's default to take over.
        if ('theme' in newSettings && !('accentColor' in newSettings)) {
            actualSettings.accentColor = undefined;
        }

        const updated = { ...get().settings, ...actualSettings };
        set({ settings: updated });
        try {
            await invoke('settings_set', { settings: updated });
        } catch (error) {
            console.error('Failed to save settings:', error);
        }
    },

    updateAiSettings: async (updates) => {
        const updated = {
            ...get().settings,
            ai: { ...get().settings.ai, ...updates }
        };
        set({ settings: updated });
        try {
            await invoke('settings_set', { settings: updated });
        } catch (error) {
            console.error('Failed to save AI settings:', error);
        }
    },

    updateEditorSettings: async (updates) => {
        const updated = {
            ...get().settings,
            editor: { ...get().settings.editor, ...updates }
        };
        set({ settings: updated });
        try {
            await invoke('settings_set', { settings: updated });
        } catch (error) {
            console.error('Failed to save editor settings:', error);
        }
    },

    updateTerminalSettings: async (updates) => {
        const updated = {
            ...get().settings,
            terminal: { ...get().settings.terminal, ...updates }
        };
        set({ settings: updated });
        try {
            await invoke('settings_set', { settings: updated });
        } catch (error) {
            console.error('Failed to save terminal settings:', error);
        }
    },

    updateLocalTermSettings: async (updates) => {
        const updated = {
            ...get().settings,
            localTerm: { ...get().settings.localTerm, ...updates }
        };
        set({ settings: updated });
        try {
            await invoke('settings_set', { settings: updated });
        } catch (error) {
            console.error('Failed to save local terminal settings:', error);
        }
    },

    updateFileManagerSettings: async (updates) => {
        const updated = {
            ...get().settings,
            fileManager: { ...get().settings.fileManager, ...updates }
        };
        set({ settings: updated });
        try {
            await invoke('settings_set', { settings: updated });
        } catch (error) {
            console.error('Failed to save file manager settings:', error);
        }
    },

    updateGhostSuggestionsSettings: async (updates) => {
        const current = get().settings.ghostSuggestions;
        const updated = {
            ...get().settings,
            ghostSuggestions: {
                ...current,
                ...updates,
                providers: {
                    ...current.providers,
                    ...(updates.providers || {}),
                },
            },
        };
        set({ settings: updated });
        try {
            await invoke('settings_set', { settings: updated });
        } catch (error) {
            console.error('Failed to save ghost suggestion settings:', error);
        }
    },

    updateKeybindings: async (updates) => {
        const updated = {
            ...get().settings,
            keybindings: { ...get().settings.keybindings, ...updates }
        };
        set({ settings: updated });
        try {
            await invoke('settings_set', { settings: updated });
        } catch (error) {
            console.error('Failed to save keybindings:', error);
        }
    },

    toggleExpandedFolder: async (folderPath) => {
        const current = get().settings.expandedFolders || [];
        const newFolders = current.includes(folderPath)
            ? current.filter(f => f !== folderPath)
            : [...current, folderPath];

        const updated = { ...get().settings, expandedFolders: newFolders };
        set({ settings: updated });
        try {
            await invoke('settings_set', { settings: updated });
        } catch (error) {
            console.error('Failed to save expanded folders:', error);
        }
    },

    openSettings: () => set({ isSettingsOpen: true }),
    closeSettings: () => set({ isSettingsOpen: false }),
    fetchSystemInfo: async () => {
        try {
            const info = await invoke<{ app_root: string }>('get_system_info');
            set({ appRoot: info.app_root });
        } catch (e) {
            console.error('Failed to fetch system info:', e);
        }
    }
});
