import { ensureAuthRefVaultId } from '../domain/credentialRef.js';
import type { Connection, Folder } from '../domain/types.js';
import { vaultIpc } from '../../../vault/ipc.js';

export interface PersistedConnectionPayload {
    connections: Array<Omit<Connection, 'status' | 'lastError'>>;
    folders: Folder[];
}

export type LoadConnectionsIpcResult = PersistedConnectionPayload | Connection[];

export const toPersistedConnections = (connections: Connection[]): Array<Omit<Connection, 'status' | 'lastError'>> =>
    connections.map(({ status, lastError, ...connection }) => connection);

const resolveUnlockedVaultId = async (): Promise<string | undefined> => {
    const status = await vaultIpc.status();
    return status.status === 'unlocked' ? status.vaultId : undefined;
};

export const prepareConnectionsForPersist = async (
    connections: Connection[],
): Promise<Array<Omit<Connection, 'status' | 'lastError'>>> => {
    const needsVaultIdBackfill = connections.some((connection) => connection.authRef && !connection.authRef.vaultId);
    const unlockedVaultId = needsVaultIdBackfill ? await resolveUnlockedVaultId() : undefined;

    return connections.map(({ status, lastError, ...connection }) => {
        if (!connection.authRef) return connection;

        const authRef = ensureAuthRefVaultId(connection.authRef, unlockedVaultId);
        if (authRef && !authRef.vaultId) {
            throw new Error(
                `Connection "${connection.name}" references a vault credential without a vault id. Unlock the vault and try again.`,
            );
        }

        if (authRef === connection.authRef) return connection;
        return { ...connection, authRef };
    });
};

export const loadConnectionsIpc = async (): Promise<LoadConnectionsIpcResult> =>
    window.ipcRenderer.invoke('connections:get');

export const saveConnectionsIpc = async (
    connections: Connection[],
    folders: Folder[],
): Promise<void> => {
    const payload: PersistedConnectionPayload = {
        connections: await prepareConnectionsForPersist(connections),
        folders,
    };
    await window.ipcRenderer.invoke('connections:save', payload);
};