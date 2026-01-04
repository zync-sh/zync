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
};

class SettingsManager {
  private store: Store<AppSettings>;

  constructor() {
    this.store = new Store({ defaults: defaultSettings });
  }

  getSettings(): AppSettings {
    return this.store.store;
  }

  setSettings(settings: Partial<AppSettings>) {
    // Electron Store set(object) might complain about Partial types, ensure safe merge
    // Or cast/iterate.
    // this.store.set(settings as AppSettings); // Unsafe if incomplete?
    // Actually store.set(obj) merges. The type definition usually expects complete T.
    // Let's iterate to be type-safe and support deep merge if needed (though top level here)
    for (const [key, value] of Object.entries(settings)) {
      this.store.set(key as any, value);
    }
  }

  updateSetting<K extends keyof AppSettings>(key: K, value: AppSettings[K]) {
    this.store.set(key, value);
  }
}

export const settingsManager = new SettingsManager();
