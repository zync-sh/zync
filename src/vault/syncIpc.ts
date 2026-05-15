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

export function notifySyncStatusChanged(provider: SyncProvider, status?: SyncProviderStatus): void {
  if (status) {
    lastKnownStatusByProvider[provider] = status;
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
    invoke<SyncCollectionStatus>('sync_collection_status', { provider }),

  collectionSetup: async (
    provider: SyncProvider,
    args: SyncCollectionSetupArgs,
  ): Promise<SyncCollectionSetupResult> =>
    invoke<SyncCollectionSetupResult>('sync_collection_setup', { provider, args }),

  collectionUnlock: async (
    provider: SyncProvider,
    args: SyncCollectionUnlockArgs,
  ): Promise<SyncCollectionStatus> =>
    invoke<SyncCollectionStatus>('sync_collection_unlock', { provider, args }),

  collectionRegenerateRecoveryKey: async (
    provider: SyncProvider,
  ): Promise<SyncCollectionSetupResult> =>
    invoke<SyncCollectionSetupResult>('sync_collection_regenerate_recovery_key', { provider }),

  collectionLock: async (
    provider: SyncProvider,
  ): Promise<SyncCollectionStatus> =>
    invoke<SyncCollectionStatus>('sync_collection_lock', { provider }),

  collectionForgetKey: async (
    provider: SyncProvider,
  ): Promise<SyncCollectionStatus> =>
    invoke<SyncCollectionStatus>('sync_collection_forget_key', { provider }),

  collectionSetCacheTtl: async (
    provider: SyncProvider,
    ttlSecs: number,
  ): Promise<SyncCollectionStatus> =>
    invoke<SyncCollectionStatus>('sync_collection_set_cache_ttl', { provider, ttlSecs }),

  /** Get connection status for a sync provider.
   * @param provider Cloud sync provider.
   * @returns Current provider connection metadata.
   */
  status: async (provider: SyncProvider): Promise<SyncProviderStatus> => {
    const result = await invoke<SyncProviderStatus>('sync_status', { provider });
    const normalized: SyncProviderStatus = {
      ...result,
      provider: result.provider ?? provider,
      error: result.lastError ?? result.error,
      errorCode: result.lastErrorCode ?? result.errorCode,
    };
    lastKnownStatusByProvider[provider] = normalized;
    return normalized;
  },

  /** Connect a sync provider using its OAuth flow.
   * @param provider Cloud sync provider.
   * @returns Updated provider connection metadata.
   */
  connect: async (provider: SyncProvider): Promise<SyncProviderStatus> => {
    try {
      const connectStatus = await invoke<SyncProviderStatus>('sync_connect', { provider });
      let latestStatus: SyncProviderStatus;
      if (typeof connectStatus?.connected === 'boolean') {
        latestStatus = connectStatus;
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
      await invoke<void>('sync_disconnect', { provider });
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
      const lastSync = await invoke<number>('sync_upload', { provider });
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
      const result = await invoke<SyncUploadCredentialResult>('sync_upload_credential', { provider, args });
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
      const result = await invoke<SyncRestoreCredentialsResult>('sync_restore_credentials', {
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
    invoke<SyncRestorePreviewResult>('sync_restore_preview', { provider, args }),

  /** Download vault.redb from provider and replace the local file. */
  download: async (provider: SyncProvider): Promise<SyncDownloadResult> => {
    try {
      const result = await invoke<SyncDownloadResult>('sync_download', { provider });
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
