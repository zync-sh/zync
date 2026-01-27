import Store from 'electron-store';

export interface AppSettings {
  theme: 'dark' | 'light' | 'dracula' | 'monokai' | 'warm';
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
  localTerm: {
    windowsShell: string;
    macShell?: string;
    linuxShell?: string;
  };
  keybindings: {
    toggleSidebar: string;
    openNewConnection: string;
    newLocalTerminal: string;
    newHostTerminal: string;
    toggleSettings: string;
    closeTab: string;
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
    defaultDownloadPath: '', // Default to User Download dir (resolved at runtime if empty)
  },
  localTerm: {
    windowsShell: 'default',
    macShell: 'default',
    linuxShell: 'default',
  },
  keybindings: {
    toggleSidebar: 'Mod+B',
    openNewConnection: 'Mod+N',
    newLocalTerminal: 'Mod+T',
    newHostTerminal: 'Mod+Shift+T',
    toggleSettings: 'Mod+,',
    closeTab: 'Mod+W',
    commandPalette: 'Mod+P',
    switchTabNext: 'Ctrl+Tab',
    switchTabPrev: 'Ctrl+Shift+Tab',
    // Terminal
    termCopy: 'Mod+Shift+C',
    termPaste: 'Mod+Shift+V',
    termFind: 'Mod+F',
    // View
    zoomIn: 'Mod+=', // Plus usually requires Shift, but = is the key
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
  },
};

import { appConfigManager } from './app-config-manager';

class SettingsManager {
  private store!: Store<AppSettings>;

  constructor() {
    this.initStore();
  }

  private initStore() {
    const cwd = appConfigManager.getDataPath();
    this.store = new Store({
      name: 'config', // Preserving 'config.json' name from valid listing
      cwd: cwd,
      defaults: defaultSettings
    });
  }

  public reload() {
    this.initStore();
  }

  getSettings(): AppSettings {
    return this.store.store;
  }

  setSettings(settings: Partial<AppSettings>) {
    for (const [key, value] of Object.entries(settings)) {
      if (value === undefined) {
        this.store.delete(key as any);
      } else {
        this.store.set(key as any, value);
      }
    }
  }

  updateSetting<K extends keyof AppSettings>(key: K, value: AppSettings[K]) {
    this.store.set(key, value);
  }
}

export const settingsManager = new SettingsManager();
