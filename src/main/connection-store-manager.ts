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
}

export interface ConnectionStorageSchema {
    connections: StoredConnection[];
    folders: string[];
}

const defaultData: ConnectionStorageSchema = {
    connections: [],
    folders: []
};

class ConnectionStoreManager {
    private store: Store<ConnectionStorageSchema>;

    constructor() {
        this.store = new Store({
            name: 'ssh-connections', // Separate file: ssh-connections.json
            defaults: defaultData
        });
    }

    getData(): ConnectionStorageSchema {
        return this.store.store;
    }

    saveData(data: ConnectionStorageSchema) {
        this.store.set(data);
    }

    // Helper to get raw store path (for debugging)
    getPath(): string {
        return this.store.path;
    }
}

export const connectionStoreManager = new ConnectionStoreManager();
