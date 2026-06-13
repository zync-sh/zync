import type { Connection } from './types.js';

export interface ConnectAuthMethodPassword {
    type: 'Password';
    password: string;
}

export interface ConnectAuthMethodPrivateKey {
    type: 'PrivateKey';
    key_path: string;
    passphrase: string | null;
}

/** Sent when the connection uses a vault credential. Backend resolves item_id → secret. */
export interface ConnectAuthMethodVaultRef {
    type: 'VaultRef';
    item_id: string;
    credential_id?: string;
}

export type ConnectAuthMethod =
    | ConnectAuthMethodPassword
    | ConnectAuthMethodPrivateKey
    | ConnectAuthMethodVaultRef;

export interface ConnectConfig {
    id: string;
    name: string;
    host: string;
    port: number;
    username: string;
    auth_method: ConnectAuthMethod;
    jump_host: ConnectConfig | null;
}

type ConnectionWithLegacyAuthFields = Connection & {
    private_key_path?: string | null;
    auth_ref?: Connection['authRef'] | null;
};

const normalizeOptionalText = (value: unknown): string | undefined => {
    if (typeof value !== 'string') return undefined;
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : undefined;
};

const getConnectionAuthRef = (connection: ConnectionWithLegacyAuthFields): Connection['authRef'] | undefined =>
    connection.authRef ?? connection.auth_ref ?? undefined;

const getConnectionPrivateKeyPath = (connection: ConnectionWithLegacyAuthFields): string | undefined =>
    normalizeOptionalText(connection.privateKeyPath) ?? normalizeOptionalText(connection.private_key_path);

const getConnectionPassword = (connection: ConnectionWithLegacyAuthFields): string | undefined =>
    typeof connection.password === 'string' && connection.password.length > 0
        ? connection.password
        : undefined;

export type BuildConnectConfigErrorReason =
    | 'connection-not-found'
    | 'missing-auth'
    | 'jump-host-failure'
    | 'cycle'
    | 'depth-exceeded';

export type BuildConnectConfigResult =
    | { status: 'ok'; config: ConnectConfig }
    | { status: 'error'; reason: BuildConnectConfigErrorReason };

type BuildAuthMethodResult =
    | { status: 'ok'; auth: ConnectAuthMethod }
    | { status: 'missing-auth' };

const buildAuthMethod = (connection: ConnectionWithLegacyAuthFields): BuildAuthMethodResult => {
    const authRef = getConnectionAuthRef(connection);
    if (authRef?.itemId) {
        return {
            status: 'ok',
            auth: {
                type: 'VaultRef',
                item_id: authRef.itemId,
                credential_id: authRef.credentialId,
            },
        };
    }

    const privateKeyPath = getConnectionPrivateKeyPath(connection);
    if (privateKeyPath) {
        return {
            status: 'ok',
            auth: {
                type: 'PrivateKey',
                key_path: privateKeyPath,
                passphrase: getConnectionPassword(connection) ?? null,
            },
        };
    }

    const password = getConnectionPassword(connection);
    return password
        ? { status: 'ok', auth: { type: 'Password', password } }
        : { status: 'missing-auth' };
};

export const buildConnectConfigResult = (
    connections: Connection[],
    connectionId: string,
    visited: Set<string> = new Set(),
): BuildConnectConfigResult => {
    if (visited.has(connectionId)) {
        return { status: 'error', reason: 'cycle' };
    }
    visited.add(connectionId);

    if (visited.size > 10) {
        return { status: 'error', reason: 'depth-exceeded' };
    }

    const connection = connections.find((item) => item.id === connectionId);
    if (!connection) {
        return { status: 'error', reason: 'connection-not-found' };
    }

    const authResult = buildAuthMethod(connection);
    if (authResult.status === 'missing-auth') {
        return { status: 'error', reason: 'missing-auth' };
    }

    const config: ConnectConfig = {
        id: connection.id,
        name: connection.name,
        host: connection.host,
        port: connection.port,
        username: connection.username,
        auth_method: authResult.auth,
        jump_host: null,
    };

    if (connection.jumpServerId) {
        const jumpResult = buildConnectConfigResult(
            connections,
            connection.jumpServerId,
            new Set(visited),
        );
        if (jumpResult.status === 'error') {
            return { status: 'error', reason: 'jump-host-failure' };
        }
        config.jump_host = jumpResult.config;
    }

    return { status: 'ok', config };
};

export const buildConnectConfig = (
    connections: Connection[],
    connectionId: string,
    visited: Set<string> = new Set(),
): ConnectConfig | null => {
    const result = buildConnectConfigResult(connections, connectionId, visited);
    return result.status === 'ok' ? result.config : null;
};
