import { createContext, type ReactNode, useContext, useEffect, useState } from 'react';

export interface AppSettings {
  theme: 'dark' | 'light' | 'dracula' | 'monokai' | 'dark-warm';
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
    lineHeight: 1.2,
  },
  fileManager: {
    showHiddenFiles: true,
    confirmDelete: true,
    defaultDownloadPath: '',
  },
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

  // Apply theme to root (html element)
  useEffect(() => {
    const themes = ['light', 'dracula', 'monokai', 'dark-warm'];
    const root = document.documentElement;

    // Remove all theme classes first
    root.classList.remove(...themes);

    // Add new theme class if it's not the default 'dark'
    if (settings.theme && settings.theme !== 'dark') {
      root.classList.add(settings.theme);
    }

    // Update Window Controls (TitleBar Overlay)
    const themeColors: Record<string, { color: string; symbolColor: string }> = {
      dark: { color: '#0f172a', symbolColor: '#ffffff' }, // Slate 900
      light: { color: '#ffffff', symbolColor: '#000000' },
      dracula: { color: '#282a36', symbolColor: '#ffffff' },
      monokai: { color: '#272822', symbolColor: '#ffffff' },
      'dark-warm': { color: '#1c1917', symbolColor: '#ffffff' },
    };

    const overlay = themeColors[settings.theme] || themeColors.dark;
    if (window.ipcRenderer) {
      window.ipcRenderer.invoke('window:update-title-bar-overlay', overlay).catch(() => {});
    }

    // Also force a repaint or style recalculation if needed (usually not, but good for debugging)
  }, [settings.theme]);

  const loadSettings = async () => {
    if (!window.ipcRenderer) {
      setIsLoading(false);
      return;
    }
    try {
      const loaded = await window.ipcRenderer.invoke('settings:get');
      if (loaded) {
        setSettings(loaded);
      }
    } catch (error) {
      console.error('Failed to load settings:', error);
    } finally {
      setIsLoading(false);
    }
  };

  const updateSettings = async (newSettings: Partial<AppSettings>) => {
    // Optimistic update
    setSettings((prev) => ({ ...prev, ...newSettings }));
    if (!window.ipcRenderer) return;
    try {
      await window.ipcRenderer.invoke('settings:set', newSettings);
    } catch (error) {
      console.error('Failed to save settings:', error);
      // Revert? (Complex, verify later)
    }
  };

  const updateTerminalSettings = async (updates: Partial<AppSettings['terminal']>) => {
    const newTerminal = { ...settings.terminal, ...updates };
    setSettings((prev) => ({ ...prev, terminal: newTerminal }));
    if (!window.ipcRenderer) return;
    try {
      await window.ipcRenderer.invoke('settings:set', {
        terminal: newTerminal,
      });
    } catch (error) {
      console.error('Failed to save terminal settings:', error);
    }
  };

  const updateFileManagerSettings = async (updates: Partial<AppSettings['fileManager']>) => {
    const newFM = { ...settings.fileManager, ...updates };
    setSettings((prev) => ({ ...prev, fileManager: newFM }));
    if (!window.ipcRenderer) return;
    try {
      await window.ipcRenderer.invoke('settings:set', { fileManager: newFM });
    } catch (error) {
      console.error('Failed to save file manager settings:', error);
    }
  };

  return (
    <SettingsContext.Provider
      value={{
        settings,
        isLoading,
        updateSettings,
        updateTerminalSettings,
        updateFileManagerSettings,
      }}
    >
      {children}
    </SettingsContext.Provider>
  );
}

export function useSettings() {
  const context = useContext(SettingsContext);
  if (!context) throw new Error('useSettings must be used within a SettingsProvider');
  return context;
}
