import type { Connection } from './types.js';
import { normalizeFolderPath, normalizeTags, normalizeText, parsePort } from './normalization.js';

export type ConnectionAuthMode = 'password' | 'key';

export type ConnectionFormDraft = Partial<Connection>;

interface ToBackendConfig {
    id: string;
    name: string;
    host: string;
    port: number;
    username: string;
    auth_method: { type: 'Password'; password: string } | { type: 'PrivateKey'; key_path: string; passphrase: null };
    jump_host: ToBackendConfig | null;
}

type ConfigCandidate = Connection | ConnectionFormDraft;

const requireNormalizedText = (value: unknown, fieldName: string): string => {
    const normalized = normalizeText(typeof value === 'string' ? value : String(value ?? ''));
    if (!normalized) {
        throw new Error(`${fieldName} is required.`);
    }
    return normalized;
};

const resolveAuthMethod = (
    candidate: ConfigCandidate,
    isForm: boolean,
    authMode: ConnectionAuthMode,
    password?: string,
    keyPath?: string,
): ToBackendConfig['auth_method'] => {
    if (isForm) {
        if (authMode === 'password') {
            const normalizedPassword = normalizeText(password);
            if (!normalizedPassword) throw new Error('Password is required for password auth.');
            return { type: 'Password', password: normalizedPassword };
        }
        const normalizedKeyPath = normalizeText(keyPath);
        if (!normalizedKeyPath) throw new Error('Private key path is required for key auth.');
        return { type: 'PrivateKey', key_path: normalizedKeyPath, passphrase: null };
    }

    if (candidate.password !== undefined) {
        const normalizedPassword = normalizeText(candidate.password);
        if (!normalizedPassword) throw new Error('Password is required for password auth.');
        return { type: 'Password', password: normalizedPassword };
    }

    const normalizedKeyPath = normalizeText(candidate.privateKeyPath);
    if (!normalizedKeyPath) throw new Error('Private key path is required for key auth.');
    return { type: 'PrivateKey', key_path: normalizedKeyPath, passphrase: null };
};

const toBackendConfig = (
    candidate: ConfigCandidate,
    formDraft: ConnectionFormDraft,
    authMode: ConnectionAuthMode,
    password?: string,
    keyPath?: string,
): ToBackendConfig => {
    const isForm = candidate === formDraft;
    const auth_method = resolveAuthMethod(candidate, isForm, authMode, password, keyPath);
    const portResult = parsePort(candidate.port);
    if (portResult.error) throw new Error(portResult.error);

    const id = requireNormalizedText(candidate.id, 'Connection id');
    const name = requireNormalizedText(candidate.name, 'Connection name');
    const host = requireNormalizedText(candidate.host, 'Host');
    const username = requireNormalizedText(candidate.username, 'Username');

    return {
        id,
        name,
        host,
        port: portResult.normalizedPort,
        username,
        auth_method,
        jump_host: null,
    };
};

const buildJumpChain = (
    connections: Connection[],
    jumpServerId: string | undefined,
    visited: Set<string> = new Set(),
): ToBackendConfig | null => {
    if (!jumpServerId || visited.has(jumpServerId)) return null;
    visited.add(jumpServerId);

    const jumpConnection = connections.find((connection) => connection.id === jumpServerId);
    if (!jumpConnection) return null;

    return {
        ...toBackendConfig(jumpConnection, {} as ConnectionFormDraft, 'password'),
        jump_host: buildJumpChain(connections, jumpConnection.jumpServerId, new Set(visited)),
    };
};

export const buildConnectionSavePayload = ({
    formData,
    authMethod,
    editingConnectionId,
    connections,
}: {
    formData: ConnectionFormDraft;
    authMethod: ConnectionAuthMode;
    editingConnectionId: string | null;
    connections: Connection[];
}): Connection => {
    const host = requireNormalizedText(formData.host, 'Host');
    const username = requireNormalizedText(formData.username, 'Username');
    const name = normalizeText(formData.name) || host;
    const portResult = parsePort(formData.port);
    if (portResult.error) throw new Error(portResult.error);

    return {
        id: editingConnectionId || crypto.randomUUID(),
        name,
        host,
        username,
        port: portResult.normalizedPort,
        password: authMethod === 'password' ? formData.password : undefined,
        privateKeyPath: authMethod === 'key' ? formData.privateKeyPath : undefined,
        status: editingConnectionId ? (connections.find((c) => c.id === editingConnectionId)?.status || 'disconnected') : 'disconnected',
        jumpServerId: formData.jumpServerId,
        icon: formData.icon,
        theme: formData.theme,
        folder: normalizeFolderPath(formData.folder || ''),
        tags: normalizeTags(formData.tags || []),
    };
};

export const buildConnectionTestPayload = ({
    formData,
    authMethod,
    connections,
}: {
    formData: ConnectionFormDraft;
    authMethod: ConnectionAuthMode;
    connections: Connection[];
}): ToBackendConfig => {
    const preparedForm: ConnectionFormDraft = {
        ...formData,
        id: formData.id || 'test-temp',
        name: formData.name || formData.host,
    };

    return {
        ...toBackendConfig(preparedForm, preparedForm, authMethod, formData.password, formData.privateKeyPath),
        jump_host: buildJumpChain(connections, formData.jumpServerId),
    };
};
