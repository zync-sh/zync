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
      this.store.set(key as any, value);
    }
  }

  updateSetting<K extends keyof AppSettings>(key: K, value: AppSettings[K]) {
    this.store.set(key, value);
  }
}

export const settingsManager = new SettingsManager();
