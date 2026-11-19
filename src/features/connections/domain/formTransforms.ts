import {
    buildAgentForwardingConfig,
    buildForwardableAuthMethod,
    type ConnectAgentForwardingConfig,
    type ConnectAuthMethodSshAgent,
} from './connectionConfig.js';
import { normalizeFolderPath, normalizeTags, normalizeText, parsePort } from './normalization.js';
import type { Connection } from './types.js';

export type ConnectionAuthMode = 'password' | 'key' | 'vault' | 'agent';

export type ConnectionFormDraft = Partial<Connection>;
export const SELF_AGENT_FORWARDING_KEY = '$self';

export const canSaveInspectedPrivateKey = (
    status:
        | 'idle'
        | 'checking'
        | 'valid'
        | 'passphraseRequired'
        | 'invalidPassphrase'
        | 'invalidKey'
        | 'unavailable',
    passphrase: string,
): boolean => status === 'valid' || (status === 'passphraseRequired' && passphrase.length === 0);

interface ToBackendConfig {
    id: string;
    name: string;
    host: string;
    port: number;
    username: string;
    auth_method:
        | { type: 'Password'; password: string }
        | { type: 'PrivateKey'; key_path: string; passphrase: string | null }
        | { type: 'VaultRef'; item_id: string; credential_id?: string }
        | ConnectAuthMethodSshAgent;
    agent_forwarding?: ConnectAgentForwardingConfig;
    certificate_path?: string;
    network_interface_id?: string;
    jump_host: ToBackendConfig | null;
    host_key_approval?: {
        fingerprint: string;
        replace: boolean;
    };
}

type ConfigCandidate = Connection | ConnectionFormDraft;

type TestConnectionDependency = Partial<
    Pick<
        Connection,
        | 'name'
        | 'host'
        | 'port'
        | 'username'
        | 'password'
        | 'privateKeyPath'
        | 'certificatePath'
        | 'jumpServerId'
        | 'agentForwardingKeyConnectionId'
        | 'useSshAgent'
        | 'agentKey'
    >
> & {
    id: string;
    vaultId?: string;
    credentialId?: string;
    itemId?: string;
    itemKind?: string;
    purpose?: string;
};

/** Retain a stable auth/route snapshot for only the jump chain and offered keys; never stringify secrets. */
export function connectionTestDependencies(
    connections: readonly Connection[],
    draft: ConnectionFormDraft,
    previous: readonly TestConnectionDependency[] = [],
): readonly TestConnectionDependency[] {
    const byId = new Map(connections.map((connection) => [connection.id, connection]));
    const selected = new Set<string>();
    const jumps = new Set<string>();
    let jumpId = draft.jumpServerId;
    while (jumpId && !jumps.has(jumpId)) {
        jumps.add(jumpId);
        selected.add(jumpId);
        const jump = byId.get(jumpId);
        if (jump?.agentForwardingKeyConnectionId) selected.add(jump.agentForwardingKeyConnectionId);
        jumpId = jump?.jumpServerId;
    }
    if (
        draft.agentForwardingKeyConnectionId &&
        draft.agentForwardingKeyConnectionId !== SELF_AGENT_FORWARDING_KEY
    ) {
        selected.add(draft.agentForwardingKeyConnectionId);
    }
    const next = [...selected].map((id) => {
        const connection = byId.get(id);
        return {
            id,
            name: connection?.name,
            host: connection?.host,
            port: connection?.port,
            username: connection?.username,
            password: connection?.password,
            privateKeyPath: connection?.privateKeyPath,
            certificatePath: connection?.certificatePath,
            jumpServerId: connection?.jumpServerId,
            agentForwardingKeyConnectionId: connection?.agentForwardingKeyConnectionId,
            useSshAgent: connection?.useSshAgent,
            agentKey: connection?.agentKey,
            vaultId: connection?.authRef?.vaultId,
            credentialId: connection?.authRef?.credentialId,
            itemId: connection?.authRef?.itemId,
            itemKind: connection?.authRef?.itemKind,
            purpose: connection?.authRef?.purpose,
        };
    });
    return previous.length === next.length &&
        next.every((item, index) =>
            (Object.keys(item) as (keyof TestConnectionDependency)[]).every(
                (key) => item[key] === previous[index][key],
            ),
        )
        ? previous
        : next;
}

const requireNormalizedText = (value: unknown, fieldName: string): string => {
    const normalized = normalizeText(typeof value === 'string' ? value : String(value ?? ''));
    if (!normalized) {
        throw new Error(`${fieldName} is required.`);
    }
    return normalized;
};

/** Key passphrase may intentionally include leading/trailing spaces — do not trim. */
const optionalKeyPassphrase = (password: string | undefined): string | null =>
    typeof password === 'string' && password.length > 0 ? password : null;

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
        if (authMode === 'vault') {
            const authRef = (candidate as Connection).authRef;
            const itemId = authRef?.itemId;
            if (!itemId) throw new Error('No vault credential selected.');
            return { type: 'VaultRef', item_id: itemId, credential_id: authRef?.credentialId };
        }
        if (authMode === 'agent') {
            const agentKey = normalizeText((candidate as Connection).agentKey);
            return agentKey ? { type: 'SshAgent', public_key: agentKey } : { type: 'SshAgent' };
        }
        const normalizedKeyPath = normalizeText(keyPath);
        if (!normalizedKeyPath) throw new Error('Private key path is required for key auth.');
        return {
            type: 'PrivateKey',
            key_path: normalizedKeyPath,
            passphrase: optionalKeyPassphrase(password),
        };
    }

    // Use authRef as highest-priority discriminator for existing connections.
    const itemId = (candidate as Connection).authRef?.itemId;
    if (itemId) {
        return {
            type: 'VaultRef',
            item_id: itemId,
            credential_id: (candidate as Connection).authRef?.credentialId,
        };
    }
    if ((candidate as Connection).useSshAgent) {
        const agentKey = normalizeText((candidate as Connection).agentKey);
        return agentKey ? { type: 'SshAgent', public_key: agentKey } : { type: 'SshAgent' };
    }
    if (candidate.privateKeyPath) {
        const normalizedKeyPath = normalizeText(candidate.privateKeyPath);
        if (!normalizedKeyPath) throw new Error('Private key path is required for key auth.');
        return {
            type: 'PrivateKey',
            key_path: normalizedKeyPath,
            passphrase: optionalKeyPassphrase(candidate.password),
        };
    }

    const normalizedPassword = normalizeText(candidate.password);
    if (!normalizedPassword) throw new Error('Password is required for password auth.');
    return { type: 'Password', password: normalizedPassword };
};

/** Normalize one auth candidate while keeping its optional public certificate attached to that hop. */
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
        ...(auth_method.type !== 'Password' && normalizeText(candidate.certificatePath)
            ? { certificate_path: normalizeText(candidate.certificatePath) }
            : {}),
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

    const config: ToBackendConfig = {
        // Auth mode is ignored when `candidate` is an existing Connection (isForm=false).
        ...toBackendConfig(jumpConnection, {} as ConnectionFormDraft, 'password'),
        jump_host: buildJumpChain(connections, jumpConnection.jumpServerId, new Set(visited)),
    };
    if (jumpConnection.agentForwardingKeyConnectionId) {
        const forwarding = buildAgentForwardingConfig(
            connections,
            jumpConnection.agentForwardingKeyConnectionId,
        );
        if (!forwarding) throw new Error('The selected forwarded SSH key is unavailable.');
        config.agent_forwarding = forwarding;
    }
    return config;
};

/** Persist host metadata and key/certificate paths, never a local private-key passphrase. */
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
    if (authMethod === 'vault' && !formData.authRef?.itemId) {
        throw new Error('No vault credential selected.');
    }

    const id = editingConnectionId || crypto.randomUUID();
    const agentKey = normalizeText(formData.agentKey);
    return {
        id,
        name,
        host,
        username,
        port: portResult.normalizedPort,
        // Local-key passphrases are runtime/keychain credentials, never host-record fields.
        password: authMethod === 'password' ? formData.password || undefined : undefined,
        privateKeyPath: authMethod === 'key' ? formData.privateKeyPath : undefined,
        useSshAgent: authMethod === 'agent',
        agentKey: authMethod === 'agent' && agentKey ? agentKey : undefined,
        certificatePath:
            authMethod !== 'password' && formData.authRef?.itemKind !== 'ssh-password'
                ? normalizeText(formData.certificatePath) || undefined
                : undefined,
        authRef: authMethod === 'vault' ? formData.authRef : undefined,
        status: editingConnectionId
            ? connections.find((c) => c.id === editingConnectionId)?.status || 'disconnected'
            : 'disconnected',
        jumpServerId: formData.jumpServerId,
        agentForwardingKeyConnectionId:
            formData.agentForwardingKeyConnectionId === SELF_AGENT_FORWARDING_KEY
                ? id
                : formData.agentForwardingKeyConnectionId,
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

    const config: ToBackendConfig = {
        ...toBackendConfig(
            preparedForm,
            preparedForm,
            authMethod,
            formData.password,
            formData.privateKeyPath,
        ),
        jump_host: buildJumpChain(connections, formData.jumpServerId),
    };
    const forwardingSource = formData.agentForwardingKeyConnectionId;
    if (forwardingSource) {
        if (forwardingSource === SELF_AGENT_FORWARDING_KEY) {
            const forwardingAuth = buildForwardableAuthMethod(preparedForm as Connection);
            if (!forwardingAuth)
                throw new Error('This connection does not have a private key to forward.');
            config.agent_forwarding = {
                source_connection_id: preparedForm.id || 'test-temp',
                auth_method: forwardingAuth,
            };
        } else {
            const forwarding = buildAgentForwardingConfig(connections, forwardingSource);
            if (!forwarding) throw new Error('The selected forwarded SSH key is unavailable.');
            config.agent_forwarding = forwarding;
        }
    }
    return config;
};
