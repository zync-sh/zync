import { invoke } from '@tauri-apps/api/core';
import { parseSyncInvokeError } from './syncError';

export type SyncProvider = 'google';

export interface SyncProviderStatus {
  provider?: string;
  connected: boolean;
  email?: string;
  lastSync?: number;
  error?: string;
  errorCode?: string;
  lastError?: string;
  lastErrorCode?: string;
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

export interface SyncCollectionSetupArgs {
  keyPolicyMode: SyncKeyPolicyMode;
  passphrase: string;
  hasRecoveryKey: boolean;
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
  fallback: SyncProviderStatus,
  error: unknown,
): SyncProviderStatus {
  const normalized = parseSyncInvokeError(error);
  const errorCode = normalized.code;
  const normalizedMessage = normalized.message;
  const lastKnown = lastKnownStatusByProvider[provider];
  // Merge order: lastKnown supplies supplementary fields (email, lastSync),
  // fallback overrides connection state (connected), error is always set.
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
      ...fallback,
      error: normalizedMessage,
      errorCode,
      lastError: normalizedMessage,
      lastErrorCode: errorCode,
    };
}

export const syncIpc = {
  collectionStatus: async (provider: SyncProvider): Promise<SyncCollectionStatus> =>
    invokeCore<SyncCollectionStatus>('sync_collection_status', { provider }),

  collectionSetup: async (
    provider: SyncProvider,
    args: SyncCollectionSetupArgs,
  ): Promise<SyncCollectionSetupResult> =>
    invokeCore<SyncCollectionSetupResult>('sync_collection_setup', { provider, args }),

  collectionUnlock: async (
    provider: SyncProvider,
    args: SyncCollectionUnlockArgs,
  ): Promise<SyncCollectionStatus> =>
    invokeCore<SyncCollectionStatus>('sync_collection_unlock', { provider, args }),

  collectionRegenerateRecoveryKey: async (
    provider: SyncProvider,
  ): Promise<SyncCollectionSetupResult> =>
    invokeCore<SyncCollectionSetupResult>('sync_collection_regenerate_recovery_key', { provider }),

  collectionLock: async (
    provider: SyncProvider,
  ): Promise<SyncCollectionStatus> =>
    invokeCore<SyncCollectionStatus>('sync_collection_lock', { provider }),

  collectionForgetKey: async (
    provider: SyncProvider,
  ): Promise<SyncCollectionStatus> =>
    invokeCore<SyncCollectionStatus>('sync_collection_forget_key', { provider }),

  collectionSetCacheTtl: async (
    provider: SyncProvider,
    ttlSecs: number,
  ): Promise<SyncCollectionStatus> =>
    invokeCore<SyncCollectionStatus>('sync_collection_set_cache_ttl', { provider, ttlSecs }),

  /** Get connection status for a sync provider.
   * @param provider Cloud sync provider.
   * @returns Current provider connection metadata.
   */
  status: async (provider: SyncProvider): Promise<SyncProviderStatus> => {
    const result = await invokeCore<SyncProviderStatus>('sync_status', { provider });
    const normalized = normalizeProviderStatus(provider, result);
    lastKnownStatusByProvider[provider] = normalized;
    return normalized;
  },

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
      notifySyncStatusChanged(provider, fallbackStatus(provider, { connected: true }, error));
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
      notifySyncStatusChanged(provider, fallbackStatus(provider, { connected: true }, error));
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
      notifySyncStatusChanged(provider, fallbackStatus(provider, { connected: true }, error));
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
      notifySyncStatusChanged(provider, fallbackStatus(provider, { connected: true }, error));
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
      notifySyncStatusChanged(provider, fallbackStatus(provider, { connected: true }, error));
      throw error;
    }
  },
};
