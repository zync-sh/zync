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

/**
 * Authenticate through the local SSH agent (Windows OpenSSH agent pipe, Pageant,
 * or a Unix SSH_AUTH_SOCK agent). Bitwarden/Vaultwarden and 1Password serve their
 * SSH keys through the same agent protocol. `public_key` optionally selects one
 * agent identity; omit it to use the agent's first key.
 */
export interface ConnectAuthMethodSshAgent {
    type: 'SshAgent';
    public_key?: string;
}

export type ConnectAuthMethod =
    | ConnectAuthMethodPassword
    | ConnectAuthMethodPrivateKey
    | ConnectAuthMethodVaultRef
    | ConnectAuthMethodSshAgent;

export type ForwardableConnectAuthMethod = ConnectAuthMethodPrivateKey | ConnectAuthMethodVaultRef;

export interface ConnectAgentForwardingConfig {
    source_connection_id: string;
    auth_method: ForwardableConnectAuthMethod;
}

export interface ConnectConfig {
    id: string;
    name: string;
    host: string;
    port: number;
    username: string;
    auth_method: ConnectAuthMethod;
    certificate_path?: string;
    network_interface_id?: string;
    agent_forwarding?: ConnectAgentForwardingConfig;
    jump_host: ConnectConfig | null;
    host_key_approval?: {
        fingerprint: string;
        replace: boolean;
    };
    connect_attempt_id?: string;
}

type ConnectionWithLegacyAuthFields = Connection & {
    private_key_path?: string | null;
    auth_ref?: Connection['authRef'] | null;
};

const normalizeOptionalText = (value: unknown): string | undefined => {
    if (typeof value !== 'string') {
        return undefined;
    }
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : undefined;
};

const getConnectionAuthRef = (
    connection: ConnectionWithLegacyAuthFields,
): Connection['authRef'] | undefined => connection.authRef ?? connection.auth_ref ?? undefined;

const getConnectionPrivateKeyPath = (
    connection: ConnectionWithLegacyAuthFields,
): string | undefined =>
    normalizeOptionalText(connection.privateKeyPath) ??
    normalizeOptionalText(connection.private_key_path);

const getConnectionPassword = (connection: ConnectionWithLegacyAuthFields): string | undefined =>
    typeof connection.password === 'string' && connection.password.length > 0
        ? connection.password
        : undefined;

export type BuildConnectConfigErrorReason =
    | 'connection-not-found'
    | 'missing-auth'
    | 'missing-agent-key'
    | 'jump-host-failure'
    | 'cycle'
    | 'depth-exceeded';

export type BuildConnectConfigResult =
    | { status: 'ok'; config: ConnectConfig }
    | { status: 'error'; reason: BuildConnectConfigErrorReason };

type BuildAuthMethodResult = { status: 'ok'; auth: ConnectAuthMethod } | { status: 'missing-auth' };

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

    const agentKey = normalizeOptionalText(connection.agentKey);
    if (agentKey !== undefined || connection.useSshAgent) {
        return {
            status: 'ok',
            auth: {
                type: 'SshAgent',
                ...(agentKey !== undefined ? { public_key: agentKey } : {}),
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

export const connectionHasForwardableKey = (
    connection: ConnectionWithLegacyAuthFields,
): boolean => {
    const authRef = getConnectionAuthRef(connection);
    return (
        authRef?.itemKind === 'ssh-private-key' || Boolean(getConnectionPrivateKeyPath(connection))
    );
};

export const buildForwardableAuthMethod = (
    connection: ConnectionWithLegacyAuthFields,
): ForwardableConnectAuthMethod | null => {
    const authRef = getConnectionAuthRef(connection);
    if (authRef?.itemKind === 'ssh-private-key' && authRef.itemId) {
        return {
            type: 'VaultRef',
            item_id: authRef.itemId,
            credential_id: authRef.credentialId,
        };
    }
    const keyPath = getConnectionPrivateKeyPath(connection);
    return keyPath
        ? {
              type: 'PrivateKey',
              key_path: keyPath,
              passphrase: getConnectionPassword(connection) ?? null,
          }
        : null;
};

export const buildAgentForwardingConfig = (
    connections: Connection[],
    sourceConnectionId: string | undefined,
): ConnectAgentForwardingConfig | null => {
    if (!sourceConnectionId) {
        return null;
    }
    const source = connections.find((connection) => connection.id === sourceConnectionId);
    if (!source) {
        return null;
    }
    const authMethod = buildForwardableAuthMethod(source);
    return authMethod ? { source_connection_id: source.id, auth_method: authMethod } : null;
};

/** Build a bounded hop chain without resolving secrets or changing per-hop certificate ownership. */
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
        ...((authResult.auth.type === 'PrivateKey' || authResult.auth.type === 'VaultRef') &&
        normalizeOptionalText(connection.certificatePath)
            ? { certificate_path: normalizeOptionalText(connection.certificatePath) }
            : {}),
        jump_host: null,
    };

    if (connection.agentForwardingKeyConnectionId) {
        const agentForwarding = buildAgentForwardingConfig(
            connections,
            connection.agentForwardingKeyConnectionId,
        );
        if (!agentForwarding) {
            return { status: 'error', reason: 'missing-agent-key' };
        }
        config.agent_forwarding = agentForwarding;
    }

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

export const connectConfigUsesVaultAuth = (config: ConnectConfig): boolean => {
    if (config.auth_method.type === 'VaultRef') {
        return true;
    }
    if (config.agent_forwarding?.auth_method.type === 'VaultRef') {
        return true;
    }
    if (config.jump_host) {
        return connectConfigUsesVaultAuth(config.jump_host);
    }
    return false;
};

export const connectionUsesVaultAuth = (
    connections: Connection[],
    connectionId: string,
): boolean => {
    const result = buildConnectConfigResult(connections, connectionId);
    if (result.status !== 'ok') {
        return true;
    }
    return connectConfigUsesVaultAuth(result.config);
};

/**
 * Auto-connect only when the user explicitly opens a host (openTab / sidebar).
 * Session restore and tab-bar activateTab do not use this — no surprise SSH.
 * Vault hosts prompt unlock via connect().
 */
export const shouldAutoConnectOnOpenTab = (
    _connections: Connection[],
    connection: Connection,
): boolean => connection.status === 'disconnected' || connection.status === 'error';
