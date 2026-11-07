import type { NetworkInterface, NetworkPreference } from '../domain/types.js';
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

export type AuthMethodPayload = AuthMethodPassword | AuthMethodPrivateKey | AuthMethodVaultRef;

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
