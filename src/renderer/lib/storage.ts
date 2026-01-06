// Simple localStorage wrapper for storing connections
// We'll use localStorage since it's available in the renderer process

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

const STORAGE_KEY = 'ssh-connections';

export interface StorageSchema {
  connections: StoredConnection[];
  folders: string[];
}

export const connectionStorage = {
  load: (): StoredConnection[] | StorageSchema => {
    try {
      const stored = localStorage.getItem(STORAGE_KEY);
      return stored ? JSON.parse(stored) : [];
    } catch (e) {
      console.error('Failed to load connections:', e);
      return [];
    }
  },

  save: (data: StoredConnection[] | StorageSchema) => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
    } catch (e) {
      console.error('Failed to save connections:', e);
    }
  },

  clear: () => {
    localStorage.removeItem(STORAGE_KEY);
  },
};
