import type { VaultProfileId } from '../../../vault/profileTypes';
import type { MainTabPresentation } from '../../workspace/domain/mainTabPresentation';

export type CoreTabView = 'dashboard' | 'files' | 'port-forwarding' | 'snippets' | 'terminal' | 'security';
export type PluginTabView = `plugin:${string}`;
export type TabView = CoreTabView | PluginTabView;

export type CredentialItemKind = 'ssh-password' | 'ssh-private-key' | 'ssh-agent-key';
export type CredentialPurpose = 'ssh-auth';

/** Device-only egress policy, intentionally absent from synced/exported Connection records. */
export type NetworkPreference = { mode: 'default' } | { mode: 'ask' } | { mode: 'interface'; id: string };

export interface NetworkInterface {
    id: string;
    name: string;
    /** OS-provided adapter/driver description, when available; not a VPN guarantee. */
    description?: string | null;
    addresses: string[];
    available: boolean;
    /** Reported by the OS, not inferred from a user-editable adapter name. */
    kind?: 'wifi' | 'ethernet' | 'loopback' | 'tunnel' | 'other';
}

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
    /** SSH login password, plus legacy key passphrases until their next successful connect/edit. */
    password?: string;
    privateKeyPath?: string;
    /** Local OpenSSH user-certificate file; separate from server host-key trust. */
    certificatePath?: string;
    /** Vault credential reference — when set, password/privateKeyPath are ignored for SSH auth. */
    authRef?: CredentialRef;
    status: 'disconnected' | 'connecting' | 'connected' | 'error';
    lastError?: string;
    jumpServerId?: string;
    /** Saved connection whose private key may be offered to this host's forwarded agent. */
    agentForwardingKeyConnectionId?: string;
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
    type: 'connection' | 'settings' | 'port-forwarding' | 'security-audits' | 'release-notes' | 'vault' | 'sync' | 'public-urls';
    title: string;
    /** Presentation only; never changes host names, resource IDs or ownership. */
    displayAlias?: string;
    /** Pinning changes visual order only, never resource lifetime or close behavior. */
    presentation?: MainTabPresentation;
    connectionId?: string;
    vaultProfileId?: VaultProfileId;
    view: TabView;
}
