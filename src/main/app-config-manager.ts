import Store from 'electron-store';
import path from 'path';
import { app } from 'electron';

export interface AppConfigSchema {
    dataPath?: string;
    logPath?: string; // Explicit log path override
    isConfigured: boolean; // For onboarding
    theme?: string; // Cache theme preference
    autoUpdateCheck: boolean;
}

class AppConfigManager {
    private store: Store<AppConfigSchema>;

    constructor() {
        this.store = new Store({
            defaults: {
                isConfigured: false,
                autoUpdateCheck: false
            }
        });
    }

    getConfig(): AppConfigSchema {
        return this.store.store;
    }

    setConfig(config: Partial<AppConfigSchema> & { dataPath?: string | null, logPath?: string | null }) {
        // Handle Data Path
        if (config.dataPath === null) {
            this.store.delete('dataPath');
            delete config.dataPath;
        } else if (typeof config.dataPath === 'string') {
            config.dataPath = path.normalize(config.dataPath).replace(/\\/g, '/');
        }

        // Handle Log Path
        if (config.logPath === null) {
            this.store.delete('logPath');
            delete config.logPath;
        } else if (typeof config.logPath === 'string') {
            config.logPath = path.normalize(config.logPath).replace(/\\/g, '/');
        }

        // Save remaining config
        if (Object.keys(config).length > 0) {
            this.store.set(config as any);
        }
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
