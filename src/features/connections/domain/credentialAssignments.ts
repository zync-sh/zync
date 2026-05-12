import type { Connection, CredentialRef } from './types.js';

const normalizeCredentialRef = (authRef: CredentialRef): CredentialRef => ({
    vaultId: authRef.vaultId,
    credentialId: authRef.credentialId,
    itemId: authRef.itemId,
    itemKind: authRef.itemKind,
    purpose: authRef.purpose,
});

export const assignCredentialToConnections = (
    connections: Connection[],
    connectionIds: string[],
    authRef: CredentialRef,
): Connection[] => {
    const targetIds = new Set(connectionIds);
    return connections.map((connection) => {
        if (!targetIds.has(connection.id)) return connection;
        return {
            ...connection,
            authRef: normalizeCredentialRef(authRef),
            password: undefined,
            privateKeyPath: undefined,
        };
    });
};

export const syncCredentialAssignments = (
    connections: Connection[],
    selectedConnectionIds: string[],
    authRef: CredentialRef,
): Connection[] => {
    const selectedIds = new Set(selectedConnectionIds);
    return connections.map((connection) => {
        const existingCredentialId = connection.authRef?.credentialId;
        const targetCredentialId = authRef.credentialId;
        const usesCredential =
            (existingCredentialId !== undefined
                && targetCredentialId !== undefined
                && existingCredentialId === targetCredentialId)
            || ((existingCredentialId === undefined || targetCredentialId === undefined)
                && connection.authRef?.itemId !== undefined
                && authRef.itemId !== undefined
                && connection.authRef.itemId === authRef.itemId);

        if (selectedIds.has(connection.id)) {
            return {
                ...connection,
                authRef: normalizeCredentialRef(authRef),
                password: undefined,
                privateKeyPath: undefined,
            };
        }

        if (!usesCredential) {
            return connection;
        }

        return {
            ...connection,
            authRef: undefined,
        };
    });
};
