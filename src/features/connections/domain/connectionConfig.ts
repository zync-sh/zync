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

export const buildConnectConfig = (
    connections: Connection[],
    connectionId: string,
    visited: Set<string> = new Set(),
): ConnectConfig | null => {
    if (visited.has(connectionId)) return null;
    visited.add(connectionId);

    if (visited.size > 10) return null;

    const connection = connections.find((item) => item.id === connectionId);
    if (!connection) return null;

    const auth_method: ConnectAuthMethod = connection.authRef
        ? {
            type: 'VaultRef',
            item_id: connection.authRef.itemId,
            credential_id: connection.authRef.credentialId,
        }
        : connection.privateKeyPath
          ? { type: 'PrivateKey', key_path: connection.privateKeyPath, passphrase: connection.password || null }
          : { type: 'Password', password: connection.password || '' };

    const config: ConnectConfig = {
        id: connection.id,
        name: connection.name,
        host: connection.host,
        port: connection.port,
        username: connection.username,
        auth_method,
        jump_host: null,
    };

    if (connection.jumpServerId) {
        const jumpConfig = buildConnectConfig(connections, connection.jumpServerId, new Set(visited));
        if (!jumpConfig) return null;
        config.jump_host = jumpConfig;
    }

    return config;
};
