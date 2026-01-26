import Store from 'electron-store';

export interface StoredConnection {
    id: string;
    name: string;
    host: string;
    username: string;
    port: number;
    password?: string;
    privateKeyPath?: string;
    jumpServerId?: string;
    lastConnected?: number;
    icon?: string;
    folder?: string;
    isFavorite?: boolean;
}

export interface ConnectionStorageSchema {
    connections: StoredConnection[];
    folders: string[];
}

const defaultData: ConnectionStorageSchema = {
    connections: [],
    folders: []
};

import { appConfigManager } from './app-config-manager';

class ConnectionStoreManager {
    private store!: Store<ConnectionStorageSchema>;

    constructor() {
        this.initStore();
    }

    private initStore() {
        const cwd = appConfigManager.getDataPath();
        this.store = new Store({
            name: 'ssh-connections',
            cwd: cwd, // Use custom directory if set
            defaults: defaultData
        });
        console.log('[ConnectionStore] Initialized at:', this.store.path);
    }

    public reload() {
        this.initStore();
    }

    getData(): ConnectionStorageSchema {
        return this.store.store;
    }

    saveData(data: ConnectionStorageSchema) {
        this.store.set(data);
    }

    getPath(): string {
        return this.store.path;
    }
}

export const connectionStoreManager = new ConnectionStoreManager();

