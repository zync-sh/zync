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
}

const STORAGE_KEY = 'ssh-connections';

export const connectionStorage = {
  load: (): StoredConnection[] => {
    try {
      const stored = localStorage.getItem(STORAGE_KEY);
      return stored ? JSON.parse(stored) : [];
    } catch (e) {
      console.error('Failed to load connections:', e);
      return [];
    }
  },

  save: (connections: StoredConnection[]) => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(connections));
    } catch (e) {
      console.error('Failed to save connections:', e);
    }
  },

  clear: () => {
    localStorage.removeItem(STORAGE_KEY);
  },
};
