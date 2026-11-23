import type { LegacyKex, NetworkInterface, NetworkPreference } from '../domain/types.js';
import { withSshVerification } from './sshVerificationIpc.js';

/** Enumerate device adapters only on an explicit picker/connection request. */
export const listNetworkInterfacesIpc = (): Promise<NetworkInterface[]> =>
    window.ipcRenderer.invoke('ssh:networkInterfaces');
/** Device egress preferences are kept outside synced/exported host records. */
export const getNetworkPreferenceIpc = (connectionId: string): Promise<NetworkPreference> =>
    window.ipcRenderer.invoke('ssh:networkPreference', { connectionId });
/** Persist an adapter identity rather than a transient IP address or interface index. */
export const saveNetworkPreferenceIpc = (
    connectionId: string,
    preference: NetworkPreference,
): Promise<void> =>
    window.ipcRenderer.invoke('ssh:setNetworkPreference', { connectionId, preference });

export interface AuthMethodPassword {
    type: 'Password';
    password: string;
}

export interface AuthMethodPrivateKey {
    type: 'PrivateKey';
    key_path: string;
    passphrase: string | null;
}

export interface AuthMethodVaultRef {
    type: 'VaultRef';
    item_id: string;
    credential_id?: string;
}

export interface AuthMethodSshAgent {
    type: 'SshAgent';
    public_key?: string;
}

export type AuthMethodPayload =
    | AuthMethodPassword
    | AuthMethodPrivateKey
    | AuthMethodVaultRef
    | AuthMethodSshAgent;

export interface ConnectionConfigPayload {
    id: string;
    name: string;
    host: string;
    port: number;
    username: string;
    auth_method: AuthMethodPayload;
    certificate_path?: string;
    network_interface_id?: string;
    agent_forwarding?: {
        source_connection_id: string;
        auth_method: AuthMethodPrivateKey | AuthMethodVaultRef;
    };
    jump_host: ConnectionConfigPayload | null;
    host_key_approval?: HostKeyApprovalPayload;
    legacy_kex?: LegacyKex;
    connect_attempt_id?: string;
}

export interface HostKeyApprovalPayload {
    fingerprint: string;
    replace: boolean;
}

export interface ConnectResponsePayload {
    success: boolean;
    message: string;
    term_id?: string | null;
    detected_os?: string | null;
}

export interface ImportedConnectionPayload {
    id: string;
    name: string;
    host: string;
    username: string;
    port: number;
    privateKeyPath?: string;
    certificatePath?: string;
    /** Import-only feedback when the single-certificate host model cannot represent the source. */
    certificateWarning?: string;
    privateKeyStatus?: 'valid' | 'passphraseRequired' | 'invalidKey' | 'unavailable';
    jumpServerAlias?: string;
    jumpServerId?: string;
    aliases?: string[];
}

export type PrivateKeyInspectionStatus =
    | 'valid'
    | 'passphraseRequired'
    | 'invalidPassphrase'
    | 'invalidKey'
    | 'unavailable';

export interface PrivateKeyInspectionResult {
    status: PrivateKeyInspectionStatus;
    encrypted: boolean;
    remembered?: boolean;
}

export type PrivateKeyInspectionRequest =
    | { path: string; content?: never; passphrase?: string | null }
    | { content: string; path?: never; passphrase?: string | null };
export type SshImportSourceType = 'default_ssh' | 'file' | 'text';
export type SshImportSourceRequest =
    | { sourceType: 'default_ssh' }
    | { sourceType: 'file'; path: string }
    | { sourceType: 'text'; content: string };

export type AgentSignatureDecision = 'deny' | 'allowOnce' | 'allowSession';

/** Display provenance from the agent used for this scan; never an authentication selector. */
export interface SshAgentProvider {
    id: 'bitwarden' | 'onePassword' | 'openSsh' | 'pageant';
    evidence: 'signedProcess' | 'socketHint' | 'transport';
}

/** One identity currently served by the local SSH agent (Bitwarden/Vaultwarden, 1Password, OpenSSH agent, Pageant). */
export interface SshAgentKeyInfo {
    /** Canonical `algorithm base64` selector used to pick this identity again. */
    publicKey: string;
    /** SHA-256 fingerprint, as `SHA256:...`. */
    fingerprint: string;
    algorithm: string;
    comment?: string | null;
    isCertificate: boolean;
    /** Absent when the process cannot be identified or the native version lacks provenance. */
    provider?: SshAgentProvider | null;
}

/** List the identities the local SSH agent currently serves; rejects when no agent is reachable. */
export const listSshAgentKeysIpc = async (): Promise<SshAgentKeyInfo[]> =>
    window.ipcRenderer.invoke('ssh:agentListKeys');

/** Stable native discovery codes; an unreachable agent is not proof that it is disabled or locked. */
export type SshAgentDiscoveryCode =
    | 'unavailable'
    | 'accessDenied'
    | 'refused'
    | 'timeout'
    | 'failed';

export interface SshAgentDiscoveryIssue {
    code: SshAgentDiscoveryCode;
    message: string;
    details: string;
}

/** Accept structured native diagnostics and preserve older or unexpected errors as details. */
export function sshAgentDiscoveryIssue(error: unknown): SshAgentDiscoveryIssue {
    const record =
        typeof error === 'object' && error !== null ? (error as Record<string, unknown>) : null;
    if (
        record &&
        typeof record.message === 'string' &&
        typeof record.details === 'string' &&
        typeof record.code === 'string' &&
        ['unavailable', 'accessDenied', 'refused', 'timeout', 'failed'].includes(record.code)
    ) {
        return {
            code: record.code as SshAgentDiscoveryCode,
            message: record.message,
            details: record.details,
        };
    }
    return {
        code: 'failed',
        message: 'Could not read keys from the local SSH agent.',
        details:
            error instanceof Error
                ? error.message
                : typeof error === 'string'
                  ? error
                  : typeof record?.message === 'string'
                    ? record.message
                    : 'Unexpected SSH agent error.',
    };
}

export interface AgentSignatureRequestPayload {
    requestId: string;
    connectionId: string;
    host: string;
    requestedUsername: string;
    keyFingerprint: string;
}

export const respondAgentSignatureIpc = async (
    requestId: string,
    decision: AgentSignatureDecision,
): Promise<void> => window.ipcRenderer.invoke('ssh:agentSignatureRespond', { requestId, decision });

/** Allow a test initiated by the editor to answer server authentication prompts. */
export const testConnectionIpc = async (
    config: ConnectionConfigPayload,
    signal?: AbortSignal,
): Promise<string> =>
    withSshVerification(
        (channel) => window.ipcRenderer.invoke('ssh:test', config, channel),
        signal,
    );

export const importSshConfigIpc = async (): Promise<ImportedConnectionPayload[]> =>
    window.ipcRenderer.invoke('ssh:importConfig');

export const importSshConfigFromFileIpc = async (
    path: string,
): Promise<ImportedConnectionPayload[]> => importSshConfigBySourceIpc({ sourceType: 'file', path });

export const importSshConfigFromTextIpc = async (
    content: string,
): Promise<ImportedConnectionPayload[]> =>
    importSshConfigBySourceIpc({ sourceType: 'text', content });

export const importSshConfigBySourceIpc = async (
    request: SshImportSourceRequest,
): Promise<ImportedConnectionPayload[]> =>
    window.ipcRenderer.invoke('ssh:importConfigBySource', request);

export const internalizeImportedConnectionsIpc = async (
    connections: ImportedConnectionPayload[],
): Promise<ImportedConnectionPayload[]> =>
    window.ipcRenderer.invoke('ssh:internalize-connections', connections);

/** Carry server prompts on the same foreground connection attempt. */
export const connectIpc = async (
    config: ConnectionConfigPayload,
): Promise<ConnectResponsePayload> =>
    withSshVerification((channel) => window.ipcRenderer.invoke('ssh:connect', config, channel));

export const disconnectIpc = async (connectionId: string): Promise<void> =>
    window.ipcRenderer.invoke('ssh:disconnect', connectionId);

export const measureConnectionLatencyIpc = async (
    connectionId: string,
): Promise<{ connectionId: string; rttMs: number }> =>
    window.ipcRenderer.invoke('ssh:connectionLatency', connectionId);

export const cancelConnectIpc = async (connectionId: string, attemptId?: string): Promise<void> =>
    window.ipcRenderer.invoke('ssh:cancelConnect', { connectionId, attemptId });

export const transportLostIpc = async (connectionId: string): Promise<void> =>
    window.ipcRenderer.invoke('ssh:transportLost', connectionId);

export const disconnectVaultBackedIpc = async (): Promise<string[]> =>
    window.ipcRenderer.invoke('ssh:disconnectVaultBacked');
export const getRemoteCwdIpc = async (connectionId: string): Promise<string> =>
    window.ipcRenderer.invoke('fs:cwd', connectionId);

export const writeManagedKeyIpc = async (args: {
    content: string;
    suggestedName?: string | null;
}): Promise<string> =>
    window.ipcRenderer.invoke('ssh:write-managed-key', {
        content: args.content,
        suggestedName: args.suggestedName ?? null,
    });

export const readLocalKeyFileIpc = async (path: string): Promise<string> =>
    window.ipcRenderer.invoke('ssh:read-local-key-file', path);

export const inspectPrivateKeyIpc = async (
    request: PrivateKeyInspectionRequest,
): Promise<PrivateKeyInspectionResult> =>
    window.ipcRenderer.invoke('ssh:inspect-private-key', request);

export const privateKeyReadinessIpc = async (path: string): Promise<PrivateKeyInspectionResult> =>
    window.ipcRenderer.invoke('ssh:private-key-readiness', path);

export const rememberKeyPassphraseIpc = async (path: string, passphrase: string): Promise<void> =>
    window.ipcRenderer.invoke('ssh:remember-key-passphrase', { path, passphrase });

export const forgetKeyPassphraseIpc = async (path: string): Promise<void> =>
    window.ipcRenderer.invoke('ssh:forget-key-passphrase', path);

export const writeEphemeralKeyIpc = async (content: string): Promise<string> =>
    window.ipcRenderer.invoke('ssh:write-ephemeral-key', { content });

export const deleteEphemeralKeyIpc = async (path: string): Promise<void> =>
    window.ipcRenderer.invoke('ssh:delete-ephemeral-key', path);
