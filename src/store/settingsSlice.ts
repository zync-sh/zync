import { StateCreator } from 'zustand';
import { invoke } from '@tauri-apps/api/core';
import type { AppStore } from './useAppStore';
import { CODEMIRROR_EDITOR_ID } from '../components/editor/providers';

export interface AppSettings {
    theme: string;
    globalFontFamily: string;
    globalFontSize: number;
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
        fontLigatures: boolean;
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

export const defaultSettings: AppSettings = {
    theme: 'dark',
    globalFontFamily: "system-ui, -apple-system, 'Segoe UI', Roboto, 'Noto Sans', Ubuntu, Cantarell, Arial, sans-serif",
    globalFontSize: 14,
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
        fontFamily: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, 'Liberation Mono', 'Courier New', monospace",
        fontLigatures: false,
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

function normalizeTerminalFontFamily(fontFamily: string | undefined): string | undefined {
    if (typeof fontFamily !== 'string' || !fontFamily.trim()) return undefined;
    const normalized = fontFamily
        .trim()
        .replace(/\s*,\s*/g, ',')
        .replace(/\s+/g, ' ')
        .toLowerCase();
    const firstFamily = normalized.split(',')[0]?.replace(/^['"]|['"]$/g, '') ?? '';
    const compactFirstFamily = firstFamily.replace(/[-_\s]+/g, '');

    if (firstFamily.includes('fira code') || compactFirstFamily.includes('firacode')) {
        return "'Fira Code', 'FiraCode Nerd Font', 'FiraCode NFM', 'Cascadia Code', Consolas, 'Courier New', monospace";
    }
    if (firstFamily.includes('jetbrains mono') || compactFirstFamily.includes('jetbrainsmono')) {
        return "'JetBrains Mono', 'JetBrainsMono Nerd Font', 'JetBrainsMono NFM', 'Cascadia Mono', Consolas, 'Courier New', monospace";
    }
    if (firstFamily.includes('menlo') || compactFirstFamily.includes('menlo')) {
        return "Menlo, Monaco, Consolas, 'Courier New', monospace";
    }
    return fontFamily;
}

async function persistSettings(settings: Partial<AppSettings>): Promise<void> {
    await invoke('settings_set', { settings });
}

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
                terminal: {
                    ...defaultSettings.terminal,
                    ...(loaded?.terminal || {}),
                    fontFamily: normalizeTerminalFontFamily(loaded?.terminal?.fontFamily) ?? defaultSettings.terminal.fontFamily,
                },
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

        const previous = get().settings;
        const updated = { ...previous, ...actualSettings };
        set({ settings: updated });
        const changedKeys = Object.keys(actualSettings) as Array<keyof AppSettings>;
        try {
            await persistSettings(actualSettings);
        } catch (error) {
            console.error('Failed to save settings:', error);
            const current = get().settings;
            const rollbackPatch = Object.fromEntries(
                changedKeys.map((key) => [key, previous[key]])
            ) as Partial<AppSettings>;
            set({ settings: { ...current, ...rollbackPatch } });
            throw error;
        }
    },

    updateAiSettings: async (updates) => {
        const previous = get().settings;
        const updated = {
            ...previous,
            ai: { ...previous.ai, ...updates }
        };
        set({ settings: updated });
        const changedKeys = Object.keys(updates) as Array<keyof AppSettings['ai']>;
        try {
            await persistSettings({ ai: updated.ai });
        } catch (error) {
            console.error('Failed to save AI settings:', error);
            const current = get().settings;
            const rollbackPatch = Object.fromEntries(
                changedKeys.map((key) => [key, previous.ai[key]])
            ) as Partial<AppSettings['ai']>;
            set({ settings: { ...current, ai: { ...current.ai, ...rollbackPatch } } });
            throw error;
        }
    },

    updateEditorSettings: async (updates) => {
        const previous = get().settings;
        const updated = {
            ...previous,
            editor: { ...previous.editor, ...updates }
        };
        set({ settings: updated });
        const changedKeys = Object.keys(updates) as Array<keyof AppSettings['editor']>;
        try {
            await persistSettings({ editor: updated.editor });
        } catch (error) {
            console.error('Failed to save editor settings:', error);
            const current = get().settings;
            const rollbackPatch = Object.fromEntries(
                changedKeys.map((key) => [key, previous.editor[key]])
            ) as Partial<AppSettings['editor']>;
            set({ settings: { ...current, editor: { ...current.editor, ...rollbackPatch } } });
            throw error;
        }
    },

    updateTerminalSettings: async (updates) => {
        const previous = get().settings;
        const updated = {
            ...previous,
            terminal: { ...previous.terminal, ...updates }
        };
        set({ settings: updated });
        const changedKeys = Object.keys(updates) as Array<keyof AppSettings['terminal']>;
        try {
            await persistSettings({ terminal: updated.terminal });
        } catch (error) {
            console.error('Failed to save terminal settings:', error);
            const current = get().settings;
            const rollbackPatch = Object.fromEntries(
                changedKeys.map((key) => [key, previous.terminal[key]])
            ) as Partial<AppSettings['terminal']>;
            set({ settings: { ...current, terminal: { ...current.terminal, ...rollbackPatch } } });
            throw error;
        }
    },

    updateLocalTermSettings: async (updates) => {
        const previous = get().settings;
        const updated = {
            ...previous,
            localTerm: { ...previous.localTerm, ...updates }
        };
        set({ settings: updated });
        const changedKeys = Object.keys(updates) as Array<keyof AppSettings['localTerm']>;
        try {
            await persistSettings({ localTerm: updated.localTerm });
        } catch (error) {
            console.error('Failed to save local terminal settings:', error);
            const current = get().settings;
            const rollbackPatch = Object.fromEntries(
                changedKeys.map((key) => [key, previous.localTerm[key]])
            ) as Partial<AppSettings['localTerm']>;
            set({ settings: { ...current, localTerm: { ...current.localTerm, ...rollbackPatch } } });
            throw error;
        }
    },

    updateFileManagerSettings: async (updates) => {
        const previous = get().settings;
        const updated = {
            ...previous,
            fileManager: { ...previous.fileManager, ...updates }
        };
        set({ settings: updated });
        const changedKeys = Object.keys(updates) as Array<keyof AppSettings['fileManager']>;
        try {
            await persistSettings({ fileManager: updated.fileManager });
        } catch (error) {
            console.error('Failed to save file manager settings:', error);
            const current = get().settings;
            const rollbackPatch = Object.fromEntries(
                changedKeys.map((key) => [key, previous.fileManager[key]])
            ) as Partial<AppSettings['fileManager']>;
            set({ settings: { ...current, fileManager: { ...current.fileManager, ...rollbackPatch } } });
            throw error;
        }
    },

    updateGhostSuggestionsSettings: async (updates) => {
        const prevSettings = get().settings;
        const currentGhost = prevSettings.ghostSuggestions;
        const updated = {
            ...prevSettings,
            ghostSuggestions: {
                ...currentGhost,
                ...updates,
                providers: {
                    ...currentGhost.providers,
                    ...(updates.providers || {}),
                },
            },
        };
        set({ settings: updated });
        const changedGhostKeys = Object.keys(updates).filter((key) => key !== 'providers') as Array<Exclude<keyof AppSettings['ghostSuggestions'], 'providers'>>;
        const changedProviderKeys = Object.keys(updates.providers || {}) as Array<keyof AppSettings['ghostSuggestions']['providers']>;
        try {
            await persistSettings({ ghostSuggestions: updated.ghostSuggestions });
        } catch (error) {
            console.error('Failed to save ghost suggestion settings:', error);
            const latestSettings = get().settings;
            const rollbackGhostPatch = Object.fromEntries(
                changedGhostKeys.map((key) => [key, currentGhost[key]])
            ) as Partial<Omit<AppSettings['ghostSuggestions'], 'providers'>>;
            const rollbackProviderPatch = Object.fromEntries(
                changedProviderKeys.map((key) => [key, currentGhost.providers[key]])
            ) as Partial<AppSettings['ghostSuggestions']['providers']>;
            set({
                settings: {
                    ...latestSettings,
                    ghostSuggestions: {
                        ...latestSettings.ghostSuggestions,
                        ...rollbackGhostPatch,
                        providers: {
                            ...latestSettings.ghostSuggestions.providers,
                            ...rollbackProviderPatch,
                        },
                    },
                },
            });
            throw error;
        }
    },

    updateKeybindings: async (updates) => {
        const previous = get().settings;
        const updated = {
            ...previous,
            keybindings: { ...previous.keybindings, ...updates }
        };
        set({ settings: updated });
        const changedKeys = Object.keys(updates) as Array<keyof AppSettings['keybindings']>;
        try {
            await persistSettings({ keybindings: updated.keybindings });
        } catch (error) {
            console.error('Failed to save keybindings:', error);
            const current = get().settings;
            const rollbackPatch = Object.fromEntries(
                changedKeys.map((key) => [key, previous.keybindings[key]])
            ) as Partial<AppSettings['keybindings']>;
            set({ settings: { ...current, keybindings: { ...current.keybindings, ...rollbackPatch } } });
            throw error;
        }
    },

    toggleExpandedFolder: async (folderPath) => {
        const current = get().settings.expandedFolders || [];
        const newFolders = current.includes(folderPath)
            ? current.filter(f => f !== folderPath)
            : [...current, folderPath];

        const previous = get().settings;
        const updated = { ...previous, expandedFolders: newFolders };
        set({ settings: updated });
        try {
            await persistSettings({ expandedFolders: newFolders });
        } catch (error) {
            console.error('Failed to save expanded folders:', error);
            const current = get().settings;
            set({ settings: { ...current, expandedFolders: previous.expandedFolders } });
            throw error;
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
