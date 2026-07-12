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

export function __setSyncIpcInvokeForTests(mockInvoke: typeof invoke): void {
  invokeCore = mockInvoke;
}

export function __resetSyncIpcInvokeForTests(): void {
  invokeCore = invoke;
}

export function notifySyncStatusChanged(provider: SyncProvider, status?: SyncProviderStatus): void {
  if (status) {
    const normalized = normalizeProviderStatus(provider, status);
    lastKnownStatusByProvider[provider] = normalized;
    window.dispatchEvent(new CustomEvent(SYNC_STATUS_CHANGED_EVENT, {
      detail: { provider, status: normalized },
    }));
    return;
  }
  window.dispatchEvent(new CustomEvent(SYNC_STATUS_CHANGED_EVENT, {
    detail: { provider, status },
  }));
}

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

function resultLastSync(result: unknown): number | undefined {
  if (!result || typeof result !== 'object' || !('syncedAt' in result)) return undefined;
  const syncedAt = (result as { syncedAt?: unknown }).syncedAt;
  return typeof syncedAt === 'number' ? syncedAt : undefined;
}

async function refreshProviderStatus(provider: SyncProvider): Promise<SyncProviderStatus> {
  const result = await invokeCore<SyncProviderStatus>('sync_status', { provider });
  const normalized = normalizeProviderStatus(provider, result);
  lastKnownStatusByProvider[provider] = normalized;
  return normalized;
}

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
      providerStatus = fallbackStatus(provider, {
        connected: true,
        lastSync: resultLastSync(result),
      }, error);
    }
    notifySyncStatusChanged(provider, providerStatus);
    return result;
  } catch (error) {
    await notifySyncStatusOnMutationError(provider, error);
    throw error;
  }
}

export const syncIpc = {
  collectionStatus: async (provider: SyncProvider): Promise<SyncCollectionStatus> =>
    invokeCore<SyncCollectionStatus>('sync_collection_status', { provider }),

  collectionDiscoverRemote: async (
    provider: SyncProvider,
  ): Promise<SyncCollectionDiscoverResult> =>
    invokeCore<SyncCollectionDiscoverResult>('sync_collection_discover_remote', { provider }),

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

  collectionLock: async (
    provider: SyncProvider,
  ): Promise<SyncCollectionStatus> => {
    const result = await invokeCore<SyncCollectionStatus>('sync_collection_lock', { provider });
    notifySyncStatusChanged(provider);
    return result;
  },

  collectionForgetKey: async (
    provider: SyncProvider,
  ): Promise<SyncCollectionStatus> => {
    const result = await invokeCore<SyncCollectionStatus>('sync_collection_forget_key', {
      provider,
    });
    notifySyncStatusChanged(provider);
    return result;
  },

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

  domainPolicies: async (provider: SyncProvider): Promise<SyncDomainPoliciesResult> =>
    invokeCore<SyncDomainPoliciesResult>('sync_domain_policies', { provider }),

  domainPolicySet: async (
    provider: SyncProvider,
    args: SyncDomainPolicySetArgs,
  ): Promise<SyncDomainPoliciesResult> =>
    invokeCore<SyncDomainPoliciesResult>('sync_domain_policy_set', { provider, args }),

  hostsSnapshot: async (): Promise<SyncHostsSnapshotResult> =>
    invokeCore<SyncHostsSnapshotResult>('sync_hosts_snapshot'),

  hostsChanges: async (
    provider: SyncProvider,
    args: SyncHostsChangesArgs = {},
  ): Promise<SyncHostsChangesResult> =>
    invokeCore<SyncHostsChangesResult>('sync_hosts_changes', { provider, args }),

  hostsUpload: async (
    provider: SyncProvider,
    args: SyncHostsChangesArgs = {},
  ): Promise<SyncHostsUploadResult> =>
    runStatusRefreshingMutation<SyncHostsUploadResult>(provider, 'sync_hosts_upload', { provider, args }),

  hostsRemoteInventory: async (
    provider: SyncProvider,
  ): Promise<SyncHostsRemoteInventoryResult> =>
    invokeCore<SyncHostsRemoteInventoryResult>('sync_hosts_remote_inventory', { provider }),

  hostsRestore: async (
    provider: SyncProvider,
    args: SyncHostsRestoreArgs = {},
  ): Promise<SyncHostsRestoreResult> =>
    runStatusRefreshingMutation<SyncHostsRestoreResult>(provider, 'sync_hosts_restore', { provider, args }),

  connectionsRestore: async (
    provider: SyncProvider,
    args: SyncConnectionsRestoreArgs = {},
  ): Promise<SyncConnectionsRestoreResult> =>
    runStatusRefreshingMutation<SyncConnectionsRestoreResult>(provider, 'sync_connections_restore', {
      provider,
      args,
    }),

  connectionsRestorePreview: async (
    provider: SyncProvider,
    args: SyncConnectionsRestoreArgs = {},
  ): Promise<SyncConnectionsRestorePreviewResult> =>
    invokeCore<SyncConnectionsRestorePreviewResult>('sync_connections_restore_preview', {
      provider,
      args,
    }),

  tunnelsSnapshot: async (): Promise<SyncTunnelsSnapshotResult> =>
    invokeCore<SyncTunnelsSnapshotResult>('sync_tunnels_snapshot'),

  tunnelsUpload: async (provider: SyncProvider): Promise<SyncDomainUploadResult> =>
    runStatusRefreshingMutation<SyncDomainUploadResult>(provider, 'sync_tunnels_upload', { provider }),

  tunnelsRestore: async (provider: SyncProvider): Promise<SyncDomainRestoreResult> =>
    runStatusRefreshingMutation<SyncDomainRestoreResult>(provider, 'sync_tunnels_restore', { provider }),

  snippetsSnapshot: async (): Promise<SyncSnippetsSnapshotResult> =>
    invokeCore<SyncSnippetsSnapshotResult>('sync_snippets_snapshot'),

  snippetsUpload: async (provider: SyncProvider): Promise<SyncDomainUploadResult> =>
    runStatusRefreshingMutation<SyncDomainUploadResult>(provider, 'sync_snippets_upload', { provider }),

  snippetsRestore: async (
    provider: SyncProvider,
    args: SyncSnippetsRestoreArgs = {},
  ): Promise<SyncDomainRestoreResult> =>
    runStatusRefreshingMutation<SyncDomainRestoreResult>(provider, 'sync_snippets_restore', { provider, args }),

  settingsUpload: async (provider: SyncProvider): Promise<SyncDomainUploadResult> =>
    runStatusRefreshingMutation<SyncDomainUploadResult>(provider, 'sync_settings_upload', { provider }),

  settingsRestore: async (provider: SyncProvider): Promise<SyncDomainRestoreResult> =>
    runStatusRefreshingMutation<SyncDomainRestoreResult>(provider, 'sync_settings_restore', { provider }),

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
      const connectStatus = await invokeCore<SyncProviderStatus>('sync_connect', { provider });
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
      notifySyncStatusChanged(provider, fallbackStatus(provider, { connected: false }, error));
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

  uploadCredential: async (
    provider: SyncProvider,
    args: SyncUploadCredentialArgs,
  ): Promise<SyncUploadCredentialResult> => {
    try {
      const result = await invokeCore<SyncUploadCredentialResult>('sync_upload_credential', { provider, args });
      let providerStatus: SyncProviderStatus;
      try {
        providerStatus = await syncIpc.status(provider);
      } catch (error) {
        providerStatus = fallbackStatus(provider, { connected: true, lastSync: result.syncedAt }, error);
      }
      notifySyncStatusChanged(provider, providerStatus);
      return result;
    } catch (error) {
      await notifySyncStatusOnMutationError(provider, error);
      throw error;
    }
  },

  uploadCredentials: async (
    provider: SyncProvider,
  ): Promise<SyncUploadCredentialsResult> => {
    try {
      const result = await invokeCore<SyncUploadCredentialsResult>('sync_upload_credentials', { provider });
      let providerStatus: SyncProviderStatus;
      try {
        providerStatus = await syncIpc.status(provider);
      } catch (error) {
        providerStatus = fallbackStatus(provider, { connected: true, lastSync: result.syncedAt }, error);
      }
      notifySyncStatusChanged(provider, providerStatus);
      return result;
    } catch (error) {
      await notifySyncStatusOnMutationError(provider, error);
      throw error;
    }
  },

  restoreCredentials: async (
    provider: SyncProvider,
    args: SyncRestoreCredentialsArgs = {},
  ): Promise<SyncRestoreCredentialsResult> => {
    try {
      const result = await invokeCore<SyncRestoreCredentialsResult>('sync_restore_credentials', {
        provider,
        args,
      });
      let providerStatus: SyncProviderStatus;
      try {
        providerStatus = await syncIpc.status(provider);
      } catch (error) {
        providerStatus = fallbackStatus(provider, { connected: true, lastSync: result.syncedAt }, error);
      }
      notifySyncStatusChanged(provider, providerStatus);
      return result;
    } catch (error) {
      await notifySyncStatusOnMutationError(provider, error);
      throw error;
    }
  },

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
