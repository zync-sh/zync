import { invoke } from '@tauri-apps/api/core';

export type SyncProvider = 'google';

export interface SyncProviderStatus {
  connected: boolean;
  email?: string;
  lastSync?: number;
  error?: string;
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
  const message = error instanceof Error ? error.message : String(error);
  const lastKnown = lastKnownStatusByProvider[provider];
  return lastKnown ? { ...lastKnown, error: message } : { ...fallback, error: message };
}

export const syncIpc = {
  /** Get connection status for a sync provider.
   * @param provider Cloud sync provider.
   * @returns Current provider connection metadata.
   */
  status: (provider: SyncProvider): Promise<SyncProviderStatus> =>
    invoke<SyncProviderStatus>('sync_status', { provider }),

  /** Connect a sync provider using its OAuth flow.
   * @param provider Cloud sync provider.
   * @returns Updated provider connection metadata.
   */
  connect: async (provider: SyncProvider): Promise<SyncProviderStatus> => {
    try {
      await invoke<SyncProviderStatus>('sync_connect', { provider });
      let latestStatus: SyncProviderStatus;
      try {
        latestStatus = await syncIpc.status(provider);
      } catch (error) {
        latestStatus = fallbackStatus(provider, { connected: true }, error);
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

  /** Download vault.redb from provider and replace the local file. */
  download: async (provider: SyncProvider): Promise<void> => {
    try {
      await invoke<void>('sync_download', { provider });
      let providerStatus: SyncProviderStatus;
      try {
        providerStatus = await syncIpc.status(provider);
      } catch (error) {
        providerStatus = fallbackStatus(provider, { connected: true }, error);
      }
      notifySyncStatusChanged(provider, providerStatus);
    } catch (error) {
      notifySyncStatusChanged(provider, fallbackStatus(provider, { connected: true }, error));
      throw error;
    }
  },
};
