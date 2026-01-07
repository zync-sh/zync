import Store from 'electron-store';
import path from 'path';
import { app } from 'electron';

export interface AppConfigSchema {
    dataPath?: string;
    logPath?: string; // Explicit log path override
    isConfigured: boolean; // For onboarding
    theme?: string; // Cache theme preference
}

class AppConfigManager {
    private store: Store<AppConfigSchema>;

    constructor() {
        this.store = new Store({
            name: 'app-config', // app-config.json
            defaults: {
                isConfigured: false
            }
        });
    }

    getConfig(): AppConfigSchema {
        return this.store.store;
    }

    setConfig(config: Partial<AppConfigSchema>) {
        // Safe update for partial config (electron-store merges top-level keys)
        this.store.set(config as any);
    }

    // Get the effective data path (custom or default)
    getDataPath(): string {
        const customPath = this.store.get('dataPath');
        if (customPath) {
            return customPath;
        }
        // Default: <userData>/zync
        return app.getPath('userData');
    }

    // Get the effective log path
    getLogPath(): string {
        const customLogPath = this.store.get('logPath');
        if (customLogPath) {
            return customLogPath;
        }
        // Default: <dataPath>/logs
        return path.join(this.getDataPath(), 'logs');
    }
}

export const appConfigManager = new AppConfigManager();
