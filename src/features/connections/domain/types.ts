import type { VaultProfileId } from '../../../vault/profileTypes';

export type CoreTabView = 'dashboard' | 'files' | 'port-forwarding' | 'snippets' | 'terminal';
export type PluginTabView = `plugin:${string}`;
export type TabView = CoreTabView | PluginTabView;

export type CredentialItemKind = 'ssh-password' | 'ssh-private-key' | 'ssh-agent-key';
export type CredentialPurpose = 'ssh-auth';

export interface CredentialRef {
    vaultId: string;
    /** Stable logical credential identity; itemId is the current physical vault record. */
    credentialId?: string;
    itemId: string;
    itemKind: CredentialItemKind;
    purpose: CredentialPurpose;
}

export interface Connection {
    id: string;
    name: string;
    host: string;
    username: string;
    port: number;
    password?: string;
    privateKeyPath?: string;
    /** Vault credential reference — when set, password/privateKeyPath are ignored for SSH auth. */
    authRef?: CredentialRef;
    status: 'disconnected' | 'connecting' | 'connected' | 'error';
    jumpServerId?: string;
    lastConnected?: number;
    icon?: string;
    folder?: string;
    theme?: string;
    tags?: string[];
    createdAt?: number;
    isFavorite?: boolean;
    pinnedFeatures?: string[];
    homePath?: string;
}

export interface Folder {
    name: string;
    tags?: string[];
}

export interface Tab {
    id: string;
    type: 'connection' | 'settings' | 'port-forwarding' | 'release-notes' | 'vault';
    title: string;
    connectionId?: string;
    vaultProfileId?: VaultProfileId;
    view: TabView;
}
