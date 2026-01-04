import { createContext, useContext, useEffect, useState, ReactNode } from 'react';

export interface AppSettings {
    theme: 'dark' | 'light' | 'dracula' | 'monokai';
    terminal: {
        fontSize: number;
        fontFamily: string;
        cursorStyle: 'block' | 'underline' | 'bar';
        lineHeight: number;
    };
    fileManager: {
        showHiddenFiles: boolean;
        confirmDelete: boolean;
        defaultDownloadPath: string;
    };
}

const defaultSettings: AppSettings = {
    theme: 'dark',
    terminal: {
        fontSize: 14,
        fontFamily: "'Fira Code', monospace",
        cursorStyle: 'block',
        lineHeight: 1.2
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
}

const SettingsContext = createContext<SettingsContextType | null>(null);

export function SettingsProvider({ children }: { children: ReactNode }) {
    const [settings, setSettings] = useState<AppSettings>(defaultSettings);
    const [isLoading, setIsLoading] = useState(true);

    useEffect(() => {
        loadSettings();
    }, []);

    const loadSettings = async () => {
        try {
            const loaded = await window.ipcRenderer.invoke('settings:get');
            setSettings(loaded || defaultSettings);
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

    return (
        <SettingsContext.Provider value={{ settings, isLoading, updateSettings, updateTerminalSettings, updateFileManagerSettings }}>
            {children}
        </SettingsContext.Provider>
    );
}

export function useSettings() {
    const context = useContext(SettingsContext);
    if (!context) throw new Error('useSettings must be used within a SettingsProvider');
    return context;
}
