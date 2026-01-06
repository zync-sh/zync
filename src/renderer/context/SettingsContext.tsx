import { createContext, useContext, useEffect, useLayoutEffect, useState, ReactNode } from 'react';

export interface AppSettings {
    theme: 'dark' | 'light' | 'dracula' | 'monokai' | 'warm' | 'light-warm' | 'midnight' | 'system';
    accentColor?: string;
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
}

const defaultSettings: AppSettings = {
    theme: 'dark',
    accentColor: undefined,
    enableVibrancy: false,
    compactMode: true,
    sidebarWidth: 288,
    sidebarCollapsed: false,
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
    }
};

interface SettingsContextType {
    settings: AppSettings;
    isLoading: boolean;
    updateSettings: (settings: Partial<AppSettings>) => Promise<void>;
    updateTerminalSettings: (updates: Partial<AppSettings['terminal']>) => Promise<void>;
    updateFileManagerSettings: (updates: Partial<AppSettings['fileManager']>) => Promise<void>;
    isSettingsOpen: boolean;
    openSettings: () => void;
    closeSettings: () => void;
}

const SettingsContext = createContext<SettingsContextType | null>(null);

export function SettingsProvider({ children }: { children: ReactNode }) {
    const [settings, setSettings] = useState<AppSettings>(defaultSettings);
    const [isLoading, setIsLoading] = useState(true);

    useEffect(() => {
        loadSettings();
    }, []);

    useLayoutEffect(() => {
        // Apply theme to body
        const themes = ['dark', 'light', 'dracula', 'monokai', 'warm', 'light-warm', 'midnight'];
        document.body.classList.remove(...themes);

        let effectiveTheme = settings.theme;
        if (settings.theme === 'system') {
            effectiveTheme = window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
        }

        document.body.classList.add(effectiveTheme);

        // Apply Accent Color
        if (settings.accentColor) {
            document.documentElement.style.setProperty('--color-app-accent', settings.accentColor);
        } else {
            document.documentElement.style.removeProperty('--color-app-accent');
        }

        // Apply Vibrancy (Glass effect)
        // We handle this via CSS class on the root or specific components relying on 'glass' utility
        // but mostly this toggles transparency.
        // For now, let's just make sure 'bg-app-bg' respects transparency if enabled.
        // actually, 'enableVibrancy' usually means allowing electron window transparency. 
        // effectively in CSS we might want to reduce opacity of background layers.
        if (settings.enableVibrancy) {
            document.body.classList.add('vibrancy-enabled');
        } else {
            document.body.classList.remove('vibrancy-enabled');
        }

    }, [settings.theme, settings.accentColor, settings.enableVibrancy]);

    // Listen for System Theme changes
    useEffect(() => {
        if (settings.theme !== 'system') return;

        const mediaQuery = window.matchMedia('(prefers-color-scheme: dark)');
        const handleChange = () => {
            // Force re-render/re-application
            setSettings(prev => ({ ...prev }));
        };

        mediaQuery.addEventListener('change', handleChange);
        return () => mediaQuery.removeEventListener('change', handleChange);
    }, [settings.theme]);

    const loadSettings = async () => {
        try {
            const loaded = await window.ipcRenderer.invoke('settings:get');
            // Merge loaded settings with defaults to ensure new keys (like compactMode) are present
            // We need to do a deep merge for nested objects like 'terminal' to avoid overwriting new defaults with old missing keys
            const merged = {
                ...defaultSettings,
                ...loaded,
                terminal: { ...defaultSettings.terminal, ...(loaded?.terminal || {}) },
                fileManager: { ...defaultSettings.fileManager, ...(loaded?.fileManager || {}) }
            };
            setSettings(merged);
        } catch (error) {
            console.error('Failed to load settings:', error);
        } finally {
            setIsLoading(false);
        }
    };

    const updateSettings = async (newSettings: Partial<AppSettings>) => {
        // Optimistic update
        setSettings(prev => ({ ...prev, ...newSettings }));
        try {
            await window.ipcRenderer.invoke('settings:set', newSettings);
        } catch (error) {
            console.error('Failed to save settings:', error);
            // Revert? (Complex, verify later)
        }
    };

    const updateTerminalSettings = async (updates: Partial<AppSettings['terminal']>) => {
        const newTerminal = { ...settings.terminal, ...updates };
        setSettings(prev => ({ ...prev, terminal: newTerminal }));
        try {
            await window.ipcRenderer.invoke('settings:set', { terminal: newTerminal });
        } catch (error) {
            console.error('Failed to save terminal settings:', error);
        }
    };

    const updateFileManagerSettings = async (updates: Partial<AppSettings['fileManager']>) => {
        const newFM = { ...settings.fileManager, ...updates };
        setSettings(prev => ({ ...prev, fileManager: newFM }));
        try {
            await window.ipcRenderer.invoke('settings:set', { fileManager: newFM });
        } catch (error) {
            console.error('Failed to save file manager settings:', error);
        }
    };

    const [isSettingsOpen, setIsSettingsOpen] = useState(false);

    const openSettings = () => setIsSettingsOpen(true);
    const closeSettings = () => setIsSettingsOpen(false);

    return (
        <SettingsContext.Provider value={{
            settings,
            isLoading,
            updateSettings,
            updateTerminalSettings,
            updateFileManagerSettings,
            isSettingsOpen,
            openSettings,
            closeSettings
        }}>
            {children}
        </SettingsContext.Provider>
    );
}

export function useSettings() {
    const context = useContext(SettingsContext);
    if (!context) throw new Error('useSettings must be used within a SettingsProvider');
    return context;
}
