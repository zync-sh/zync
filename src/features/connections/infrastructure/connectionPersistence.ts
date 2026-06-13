import type { Connection, Folder } from '../domain/types.js';

export interface PersistedConnectionPayload {
    connections: Array<Omit<Connection, 'status' | 'lastError'>>;
    folders: Folder[];
}

export type LoadConnectionsIpcResult = PersistedConnectionPayload | Connection[];

export const toPersistedConnections = (connections: Connection[]): Array<Omit<Connection, 'status' | 'lastError'>> =>
    connections.map(({ status, lastError, ...connection }) => connection);

export const loadConnectionsIpc = async (): Promise<LoadConnectionsIpcResult> =>
    window.ipcRenderer.invoke('connections:get');

export const saveConnectionsIpc = async (
    connections: Connection[],
    folders: Folder[],
): Promise<void> => {
    const payload: PersistedConnectionPayload = {
        connections: toPersistedConnections(connections),
        folders,
    };
    await window.ipcRenderer.invoke('connections:save', payload);
};
