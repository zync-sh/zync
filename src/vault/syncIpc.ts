import { invoke } from '@tauri-apps/api/core';

import type { CredentialRef } from '../features/connections/domain/types';
import { parseSyncInvokeError } from './syncError';

export type SyncProvider = 'google';
export type SyncDomain = 'vault' | 'hosts' | 'tunnels' | 'snippets' | 'settings';
export type SyncPolicyMode = 'manual' | 'on_change' | 'interval';

export interface SyncDomainStatus {
    domain: SyncDomain;
    enabled: boolean;
    lastSync?: number;
    lastError?: string;
    lastErrorCode?: string;
}

export interface SyncProviderStatus {
    provider?: string;
    connected: boolean;
    email?: string;
    avatarUrl?: string;
    lastSync?: number;
    error?: string;
    errorCode?: string;
    lastError?: string;
    lastErrorCode?: string;
    domainStatuses?: SyncDomainStatus[];
    capabilities?: {
        supportsAutosync: boolean;
        supportsIncremental: boolean;
        supportsEtag: boolean;
        supportsDomains: boolean;
        maxObjectSize?: number | null;
        encryptionMode: string;
    };
}

export interface SyncDownloadResult {
    itemCount: number;
    vaultId?: string;
}

export type SyncKeyPolicyMode = 'local-passphrase' | 'custom-passphrase';

export interface SyncCollectionStatus {
    provider: SyncProvider;
    configured: boolean;
    syncCollectionId?: string;
    keyPolicyMode?: SyncKeyPolicyMode;
    hasRecoveryKey: boolean;
    keyCached: boolean;
    keyCacheTtlSecs?: number;
}

export interface SyncCollectionSetupResult {
    status: SyncCollectionStatus;
    recoveryKey?: string;
}

export interface SyncRemoteCollectionSummary {
    syncCollectionId: string;
    fileCount: number;
}

export interface SyncCollectionDiscoverResult {
    collections: SyncRemoteCollectionSummary[];
}

export interface SyncCollectionSetupArgs {
    keyPolicyMode: SyncKeyPolicyMode;
    passphrase?: string | null;
    recoveryKey?: string | null;
    hasRecoveryKey: boolean;
    syncCollectionId?: string | null;
}

export interface SyncCollectionUnlockArgs {
    passphrase?: string;
    recoveryKey?: string;
}

export interface SyncUploadCredentialArgs {
    itemId: string;
}

export interface SyncUploadCredentialResult {
    provider: SyncProvider;
    logicalId: string;
    revision: number;
    objectName: string;
    syncedAt: number;
}

export interface SyncUploadCredentialsResult {
    provider: SyncProvider;
    uploaded: number;
    skipped: number;
    syncedAt: number;
}

export interface SyncRestoreCredentialsArgs {
    logicalIds?: string[];
    resolveConflictLogicalIds?: string[];
}

export interface SyncRestoreCredentialsResult {
    provider: SyncProvider;
    scanned: number;
    restored: number;
    updated: number;
    tombstonesApplied: number;
    skipped: number;
    conflicts: number;
    failed: number;
    syncedAt: number;
}

export interface SyncRestorePreviewResult {
    provider: SyncProvider;
    scanned: number;
    restorable: number;
    updatable: number;
    tombstoned: number;
    stale: number;
    conflicts: number;
    failed: number;
    conflictItems: SyncRestoreConflictItem[];
}

export interface SyncRestoreConflictItem {
    logicalId: string;
    kind: string;
    label: string;
    localRevision: number;
    localUpdatedAt: number;
    remoteRevision: number;
    remoteUpdatedAt: number;
    remoteDeleted: boolean;
}

export interface SyncHostRecord {
    logicalId: string;
    name: string;
    host: string;
    port: number;
    username: string;
    jumpServerId?: string;
    folder?: string;
    tags: string[];
    isFavorite: boolean;
    updatedAt: number;
    authRef?: CredentialRef;
}

export interface SyncHostsSnapshotResult {
    domain: string;
    count: number;
    records: SyncHostRecord[];
}

export interface SyncHostsChangesArgs {
    logicalIds?: string[];
    includeAll?: boolean;
}

export interface SyncHostsChangesResult {
    domain: string;
    count: number;
    since?: number;
    records: SyncHostRecord[];
}

export interface SyncHostsUploadResult {
    domain: string;
    uploaded: number;
    credentialsUploaded: number;
    skipped: number;
    syncedAt: number;
}

export interface SyncHostsRestoreArgs {
    logicalIds?: string[];
}

export interface SyncHostsRestoreResult {
    domain: string;
    scanned: number;
    restored: number;
    updated: number;
    credentialsScanned: number;
    credentialsRestored: number;
    credentialsUpdated: number;
    credentialsSkipped: number;
    credentialsConflicts: number;
    credentialsFailed: number;
    credentialRefsRelinked: number;
    skipped: number;
    failed: number;
    syncedAt: number;
}

export interface SyncConnectionsRestoreArgs {
    hostLogicalIds?: string[];
    includeHostDefinitions?: boolean;
    includeTunnels?: boolean;
    includeHostSnippets?: boolean;
    includeReferencedCredentials?: boolean;
}

export interface SyncConnectionsBundledDomainResult {
    domain: string;
    scanned: number;
    restored: number;
    updated: number;
    skipped: number;
    skippedOrphaned: number;
    failed: number;
    syncedAt: number;
}

export interface SyncConnectionsRestoreResult {
    hosts: SyncHostsRestoreResult;
    tunnels?: SyncConnectionsBundledDomainResult;
    hostSnippets?: SyncConnectionsBundledDomainResult;
    syncedAt: number;
}

export interface SyncConnectionsRestorePreviewResult {
    provider: SyncProvider;
    hostsSelected: number;
    hostsNew: number;
    hostsExisting: number;
    referencedCredentials: number;
    hostsFailed: number;
    tunnelsScanned?: number;
    tunnelsRestorable?: number;
    tunnelsOrphaned?: number;
    hostSnippetsScanned?: number;
    hostSnippetsRestorable?: number;
    hostSnippetsOrphaned?: number;
}

export interface SyncSnippetsRestoreArgs {
    globalOnly?: boolean;
    hostConnectionIds?: string[];
}

export interface SyncRemoteHostInventoryItem {
    provider: SyncProvider;
    collectionId: string;
    logicalId: string;
    name: string;
    host: string;
    port: number;
    username: string;
    folder?: string;
    tags: string[];
    isFavorite: boolean;
    updatedAt: number;
    revision: number;
    hasAuthRef: boolean;
    credentialId?: string;
    localExists: boolean;
}

export interface SyncHostsRemoteInventoryResult {
    provider: SyncProvider;
    collectionId: string;
    scanned: number;
    hosts: SyncRemoteHostInventoryItem[];
    skipped: number;
    failed: number;
}

export interface SyncTunnelsSnapshotResult {
    domain: string;
    count: number;
    records: unknown[];
}

export interface SyncSnippetsSnapshotResult {
    domain: string;
    count: number;
    records: unknown[];
}

export interface SyncDomainUploadResult {
    domain: string;
    uploaded: number;
    skipped: number;
    syncedAt: number;
}

export interface SyncDomainRestoreResult {
    domain: string;
    scanned: number;
    restored: number;
    updated: number;
    skipped: number;
    failed: number;
    syncedAt: number;
}

export interface SyncDomainPolicy {
    domain: SyncDomain;
    enabled: boolean;
    mode: SyncPolicyMode;
}

export interface SyncDomainPoliciesResult {
    provider: SyncProvider;
    policies: SyncDomainPolicy[];
}

export interface SyncDomainPolicySetArgs {
    domain: SyncDomain;
    enabled: boolean;
    mode?: SyncPolicyMode;
}

export const SYNC_STATUS_CHANGED_EVENT = 'zync:sync-status-changed';
const lastKnownStatusByProvider: Partial<Record<SyncProvider, SyncProviderStatus>> = {};
let invokeCore: typeof invoke = invoke;

/** Accept legacy and current provider error fields in a single status shape. */
export function normalizeProviderStatus(
    provider: SyncProvider,
    status: SyncProviderStatus,
): SyncProviderStatus {
    return {
        ...status,
        provider: status.provider ?? provider,
        error: status.lastError ?? status.error,
        errorCode: status.lastErrorCode ?? status.errorCode,
    };
}

/** Substitute the native invoke bridge for isolated sync tests. */
export function __setSyncIpcInvokeForTests(mockInvoke: typeof invoke): void {
    invokeCore = mockInvoke;
}

/** Restore the real native invoke bridge after a test. */
export function __resetSyncIpcInvokeForTests(): void {
    invokeCore = invoke;
}

/** Publish a status update or signal listeners to refresh their provider state. */
export function notifySyncStatusChanged(provider: SyncProvider, status?: SyncProviderStatus): void {
    if (status) {
        const normalized = normalizeProviderStatus(provider, status);
        lastKnownStatusByProvider[provider] = normalized;
        window.dispatchEvent(
            new CustomEvent(SYNC_STATUS_CHANGED_EVENT, {
                detail: { provider, status: normalized },
            }),
        );
        return;
    }
    window.dispatchEvent(
        new CustomEvent(SYNC_STATUS_CHANGED_EVENT, {
            detail: { provider, status },
        }),
    );
}

/** Preserve the last known provider details when a fresh status lookup fails. */
function fallbackStatus(
    provider: SyncProvider,
    fallback: Partial<SyncProviderStatus>,
    error: unknown,
): SyncProviderStatus {
    const normalized = parseSyncInvokeError(error);
    const errorCode = normalized.code;
    const normalizedMessage = normalized.message;
    const lastKnown = lastKnownStatusByProvider[provider];
    // Merge order: lastKnown supplies supplementary fields (email, lastSync),
    // fallback overrides only the fields it provides, error is always set.
    return lastKnown
        ? {
              ...lastKnown,
              ...fallback,
              error: normalizedMessage,
              errorCode,
              lastError: normalizedMessage,
              lastErrorCode: errorCode,
          }
        : {
              connected: fallback.connected ?? false,
              ...fallback,
              error: normalizedMessage,
              errorCode,
              lastError: normalizedMessage,
              lastErrorCode: errorCode,
          };
}

/** Extract a sync timestamp only when a mutation result carries a numeric value. */
function resultLastSync(result: unknown): number | undefined {
    if (!result || typeof result !== 'object' || !('syncedAt' in result)) {
        return undefined;
    }
    const syncedAt = (result as { syncedAt?: unknown }).syncedAt;
    return typeof syncedAt === 'number' ? syncedAt : undefined;
}

/** Fetch and cache the latest normalized provider status. */
async function refreshProviderStatus(provider: SyncProvider): Promise<SyncProviderStatus> {
    const result = await invokeCore<SyncProviderStatus>('sync_status', { provider });
    const normalized = normalizeProviderStatus(provider, result);
    lastKnownStatusByProvider[provider] = normalized;
    return normalized;
}

/** Refresh provider state after a mutation fails, retaining error details if status is unavailable. */
async function notifySyncStatusOnMutationError(
    provider: SyncProvider,
    error: unknown,
): Promise<void> {
    try {
        notifySyncStatusChanged(provider, await refreshProviderStatus(provider));
    } catch {
        notifySyncStatusChanged(provider, fallbackStatus(provider, {}, error));
    }
}

/** Run a sync mutation and publish the provider status without hiding the original failure. */
async function runStatusRefreshingMutation<T>(
    provider: SyncProvider,
    command: string,
    payload: Record<string, unknown>,
): Promise<T> {
    try {
        const result = await invokeCore<T>(command, payload);
        let providerStatus: SyncProviderStatus;
        try {
            providerStatus = await refreshProviderStatus(provider);
        } catch (error) {
            providerStatus = fallbackStatus(
                provider,
                {
                    connected: true,
                    lastSync: resultLastSync(result),
                },
                error,
            );
        }
        notifySyncStatusChanged(provider, providerStatus);
        return result;
    } catch (error) {
        await notifySyncStatusOnMutationError(provider, error);
        throw error;
    }
}

export const syncIpc = {
    /** Read the collection key and recovery setup status on this device. */
    collectionStatus: async (provider: SyncProvider): Promise<SyncCollectionStatus> =>
        invokeCore<SyncCollectionStatus>('sync_collection_status', { provider }),

    /** Find existing sync collections available from the connected provider. */
    collectionDiscoverRemote: async (
        provider: SyncProvider,
    ): Promise<SyncCollectionDiscoverResult> =>
        invokeCore<SyncCollectionDiscoverResult>('sync_collection_discover_remote', { provider }),

    /** Configure or adopt a collection key and notify dependent backup views. */
    collectionSetup: async (
        provider: SyncProvider,
        args: SyncCollectionSetupArgs,
    ): Promise<SyncCollectionSetupResult> => {
        const result = await invokeCore<SyncCollectionSetupResult>('sync_collection_setup', {
            provider,
            args,
        });
        // Sidebar host inventory listens for this — without it, All Hosts stays on "Unlock…".
        notifySyncStatusChanged(provider);
        return result;
    },

    /** Unlock the provider collection key and refresh dependent views. */
    collectionUnlock: async (
        provider: SyncProvider,
        args: SyncCollectionUnlockArgs,
    ): Promise<SyncCollectionStatus> => {
        const result = await invokeCore<SyncCollectionStatus>('sync_collection_unlock', {
            provider,
            args,
        });
        notifySyncStatusChanged(provider);
        return result;
    },

    /** Replace the collection recovery key and return the new recovery material. */
    collectionRegenerateRecoveryKey: async (
        provider: SyncProvider,
    ): Promise<SyncCollectionSetupResult> => {
        const result = await invokeCore<SyncCollectionSetupResult>(
            'sync_collection_regenerate_recovery_key',
            { provider },
        );
        notifySyncStatusChanged(provider);
        return result;
    },

    /** Lock the cached collection key and notify dependent backup views. */
    collectionLock: async (provider: SyncProvider): Promise<SyncCollectionStatus> => {
        const result = await invokeCore<SyncCollectionStatus>('sync_collection_lock', { provider });
        notifySyncStatusChanged(provider);
        return result;
    },

    /** Remove the local collection key cache and notify dependent backup views. */
    collectionForgetKey: async (provider: SyncProvider): Promise<SyncCollectionStatus> => {
        const result = await invokeCore<SyncCollectionStatus>('sync_collection_forget_key', {
            provider,
        });
        notifySyncStatusChanged(provider);
        return result;
    },

    /** Update the collection key cache lifetime and publish the new status. */
    collectionSetCacheTtl: async (
        provider: SyncProvider,
        ttlSecs: number,
    ): Promise<SyncCollectionStatus> => {
        const result = await invokeCore<SyncCollectionStatus>('sync_collection_set_cache_ttl', {
            provider,
            ttlSecs,
        });
        notifySyncStatusChanged(provider);
        return result;
    },

    /** Read the provider policy for each backup domain. */
    domainPolicies: async (provider: SyncProvider): Promise<SyncDomainPoliciesResult> =>
        invokeCore<SyncDomainPoliciesResult>('sync_domain_policies', { provider }),

    /** Save the chosen policy for one backup domain. */
    domainPolicySet: async (
        provider: SyncProvider,
        args: SyncDomainPolicySetArgs,
    ): Promise<SyncDomainPoliciesResult> =>
        invokeCore<SyncDomainPoliciesResult>('sync_domain_policy_set', { provider, args }),

    /** Read the local host inventory available for backup. */
    hostsSnapshot: async (): Promise<SyncHostsSnapshotResult> =>
        invokeCore<SyncHostsSnapshotResult>('sync_hosts_snapshot'),

    /** Compare local host definitions with the provider backup before uploading. */
    hostsChanges: async (
        provider: SyncProvider,
        args: SyncHostsChangesArgs = {},
    ): Promise<SyncHostsChangesResult> =>
        invokeCore<SyncHostsChangesResult>('sync_hosts_changes', { provider, args }),

    /** Publish host records and refresh provider status. */
    hostsUpload: async (
        provider: SyncProvider,
        args: SyncHostsChangesArgs = {},
    ): Promise<SyncHostsUploadResult> =>
        runStatusRefreshingMutation<SyncHostsUploadResult>(provider, 'sync_hosts_upload', {
            provider,
            args,
        }),

    /** Read provider host records available for restore. */
    hostsRemoteInventory: async (provider: SyncProvider): Promise<SyncHostsRemoteInventoryResult> =>
        invokeCore<SyncHostsRemoteInventoryResult>('sync_hosts_remote_inventory', { provider }),

    /** Restore selected host definitions and refresh provider status. */
    hostsRestore: async (
        provider: SyncProvider,
        args: SyncHostsRestoreArgs = {},
    ): Promise<SyncHostsRestoreResult> =>
        runStatusRefreshingMutation<SyncHostsRestoreResult>(provider, 'sync_hosts_restore', {
            provider,
            args,
        }),

    /** Restore the selected connection bundle and its requested dependent records. */
    connectionsRestore: async (
        provider: SyncProvider,
        args: SyncConnectionsRestoreArgs = {},
    ): Promise<SyncConnectionsRestoreResult> =>
        runStatusRefreshingMutation<SyncConnectionsRestoreResult>(
            provider,
            'sync_connections_restore',
            {
                provider,
                args,
            },
        ),

    /** Inspect what a connection bundle restore would change. */
    connectionsRestorePreview: async (
        provider: SyncProvider,
        args: SyncConnectionsRestoreArgs = {},
    ): Promise<SyncConnectionsRestorePreviewResult> =>
        invokeCore<SyncConnectionsRestorePreviewResult>('sync_connections_restore_preview', {
            provider,
            args,
        }),

    /** Read local tunnel definitions available for backup. */
    tunnelsSnapshot: async (): Promise<SyncTunnelsSnapshotResult> =>
        invokeCore<SyncTunnelsSnapshotResult>('sync_tunnels_snapshot'),

    /** Publish tunnel definitions and refresh provider status. */
    tunnelsUpload: async (provider: SyncProvider): Promise<SyncDomainUploadResult> =>
        runStatusRefreshingMutation<SyncDomainUploadResult>(provider, 'sync_tunnels_upload', {
            provider,
        }),

    /** Restore tunnel definitions and refresh provider status. */
    tunnelsRestore: async (provider: SyncProvider): Promise<SyncDomainRestoreResult> =>
        runStatusRefreshingMutation<SyncDomainRestoreResult>(provider, 'sync_tunnels_restore', {
            provider,
        }),

    /** Read local snippets available for backup. */
    snippetsSnapshot: async (): Promise<SyncSnippetsSnapshotResult> =>
        invokeCore<SyncSnippetsSnapshotResult>('sync_snippets_snapshot'),

    /** Publish snippets and refresh provider status. */
    snippetsUpload: async (provider: SyncProvider): Promise<SyncDomainUploadResult> =>
        runStatusRefreshingMutation<SyncDomainUploadResult>(provider, 'sync_snippets_upload', {
            provider,
        }),

    /** Restore snippets with the requested scope and refresh provider status. */
    snippetsRestore: async (
        provider: SyncProvider,
        args: SyncSnippetsRestoreArgs = {},
    ): Promise<SyncDomainRestoreResult> =>
        runStatusRefreshingMutation<SyncDomainRestoreResult>(provider, 'sync_snippets_restore', {
            provider,
            args,
        }),

    /** Back up the supported app settings and refresh provider status. */
    settingsUpload: async (provider: SyncProvider): Promise<SyncDomainUploadResult> =>
        runStatusRefreshingMutation<SyncDomainUploadResult>(provider, 'sync_settings_upload', {
            provider,
        }),

    /** Restore the supported app settings and refresh provider status. */
    settingsRestore: async (provider: SyncProvider): Promise<SyncDomainRestoreResult> =>
        runStatusRefreshingMutation<SyncDomainRestoreResult>(provider, 'sync_settings_restore', {
            provider,
        }),

    /** Get connection status for a sync provider.
     * @param provider Cloud sync provider.
     * @returns Current provider connection metadata.
     */
    status: async (provider: SyncProvider): Promise<SyncProviderStatus> =>
        refreshProviderStatus(provider),

    /** Connect a sync provider using its OAuth flow.
     * @param provider Cloud sync provider.
     * @returns Updated provider connection metadata.
     */
    connect: async (provider: SyncProvider): Promise<SyncProviderStatus> => {
        try {
            const connectStatus = await invokeCore<SyncProviderStatus>('sync_connect', {
                provider,
            });
            let latestStatus: SyncProviderStatus;
            if (typeof connectStatus?.connected === 'boolean') {
                latestStatus = normalizeProviderStatus(provider, connectStatus);
                lastKnownStatusByProvider[provider] = latestStatus;
            } else {
                try {
                    latestStatus = await syncIpc.status(provider);
                } catch (error) {
                    latestStatus = fallbackStatus(provider, { connected: true }, error);
                }
            }
            notifySyncStatusChanged(provider, latestStatus);
            return latestStatus;
        } catch (error) {
            notifySyncStatusChanged(
                provider,
                fallbackStatus(provider, { connected: false }, error),
            );
            throw error;
        }
    },

    /** Disconnect a sync provider and remove local credentials.
     * @param provider Cloud sync provider.
     * @returns Resolves when disconnected.
     */
    disconnect: async (provider: SyncProvider): Promise<void> => {
        try {
            await invokeCore<void>('sync_disconnect', { provider });
            let providerStatus: SyncProviderStatus;
            try {
                providerStatus = await syncIpc.status(provider);
            } catch (error) {
                providerStatus = fallbackStatus(provider, { connected: false }, error);
            }
            notifySyncStatusChanged(provider, providerStatus);
        } catch (error) {
            await notifySyncStatusOnMutationError(provider, error);
            throw error;
        }
    },

    /** Upload vault.redb to provider. Returns the sync timestamp. */
    upload: async (provider: SyncProvider): Promise<number> => {
        try {
            const lastSync = await invokeCore<number>('sync_upload', { provider });
            let providerStatus: SyncProviderStatus;
            try {
                providerStatus = await syncIpc.status(provider);
            } catch (error) {
                providerStatus = fallbackStatus(provider, { connected: true, lastSync }, error);
            }
            notifySyncStatusChanged(provider, providerStatus);
            return lastSync;
        } catch (error) {
            await notifySyncStatusOnMutationError(provider, error);
            throw error;
        }
    },

    /** Publish one selected credential and report the resulting provider status. */
    uploadCredential: async (
        provider: SyncProvider,
        args: SyncUploadCredentialArgs,
    ): Promise<SyncUploadCredentialResult> => {
        try {
            const result = await invokeCore<SyncUploadCredentialResult>('sync_upload_credential', {
                provider,
                args,
            });
            let providerStatus: SyncProviderStatus;
            try {
                providerStatus = await syncIpc.status(provider);
            } catch (error) {
                providerStatus = fallbackStatus(
                    provider,
                    { connected: true, lastSync: result.syncedAt },
                    error,
                );
            }
            notifySyncStatusChanged(provider, providerStatus);
            return result;
        } catch (error) {
            await notifySyncStatusOnMutationError(provider, error);
            throw error;
        }
    },

    /** Publish the live credential library incrementally, with an explicit option to resend it. */
    uploadCredentials: async (
        provider: SyncProvider,
        options?: { forceFull?: boolean },
    ): Promise<SyncUploadCredentialsResult> => {
        try {
            const result = await invokeCore<SyncUploadCredentialsResult>(
                'sync_upload_credentials',
                {
                    provider,
                    forceFull: options?.forceFull ?? false,
                },
            );
            let providerStatus: SyncProviderStatus;
            try {
                providerStatus = await syncIpc.status(provider);
            } catch (error) {
                providerStatus = fallbackStatus(
                    provider,
                    { connected: true, lastSync: result.syncedAt },
                    error,
                );
            }
            notifySyncStatusChanged(provider, providerStatus);
            return result;
        } catch (error) {
            await notifySyncStatusOnMutationError(provider, error);
            throw error;
        }
    },

    /** Apply the requested credential restore and report the resulting provider status. */
    restoreCredentials: async (
        provider: SyncProvider,
        args: SyncRestoreCredentialsArgs = {},
    ): Promise<SyncRestoreCredentialsResult> => {
        try {
            const result = await invokeCore<SyncRestoreCredentialsResult>(
                'sync_restore_credentials',
                {
                    provider,
                    args,
                },
            );
            let providerStatus: SyncProviderStatus;
            try {
                providerStatus = await syncIpc.status(provider);
            } catch (error) {
                providerStatus = fallbackStatus(
                    provider,
                    { connected: true, lastSync: result.syncedAt },
                    error,
                );
            }
            notifySyncStatusChanged(provider, providerStatus);
            return result;
        } catch (error) {
            await notifySyncStatusOnMutationError(provider, error);
            throw error;
        }
    },

    /** Preview credential restore decisions and conflicts before applying changes. */
    restorePreview: async (
        provider: SyncProvider,
        args: SyncRestoreCredentialsArgs = {},
    ): Promise<SyncRestorePreviewResult> =>
        invokeCore<SyncRestorePreviewResult>('sync_restore_preview', { provider, args }),

    /** Download vault.redb from provider and replace the local file. */
    download: async (provider: SyncProvider): Promise<SyncDownloadResult> => {
        try {
            const result = await invokeCore<SyncDownloadResult>('sync_download', { provider });
            let providerStatus: SyncProviderStatus;
            try {
                providerStatus = await syncIpc.status(provider);
            } catch (error) {
                providerStatus = fallbackStatus(provider, { connected: true }, error);
            }
            notifySyncStatusChanged(provider, providerStatus);
            return result;
        } catch (error) {
            await notifySyncStatusOnMutationError(provider, error);
            throw error;
        }
    },
};
