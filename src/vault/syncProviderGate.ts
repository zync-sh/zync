import type { SyncCollectionStatus, SyncProviderStatus } from './syncIpc';

/**
 * Pure readiness model for a sync provider.
 * Live state is owned by `useSyncReadinessStore` — do not re-derive
 * connected/configured/keyCached separately in UI modules.
 */
export interface ProviderReadiness {
  isConnected: boolean;
  isEncryptionConfigured: boolean;
  isEncryptionUnlocked: boolean;
  isProviderReady: boolean;
}

export type ProviderSyncAction = 'sync' | 'restore';

export function getProviderReadiness(
  googleSync: SyncProviderStatus | null,
  googleCollection: SyncCollectionStatus | null,
): ProviderReadiness {
  const isConnected = Boolean(googleSync?.connected);
  const isEncryptionConfigured = Boolean(googleCollection?.configured);
  const isEncryptionUnlocked = Boolean(googleCollection?.keyCached);
  return {
    isConnected,
    isEncryptionConfigured,
    isEncryptionUnlocked,
    isProviderReady: isConnected && isEncryptionConfigured && isEncryptionUnlocked,
  };
}

export function getProviderGateReason(
  readiness: ProviderReadiness,
  options?: { isActionBlocked?: boolean },
): string | null {
  if (!readiness.isConnected) {
    return 'Connect Google Drive to enable Sync and Restore.';
  }
  if (!readiness.isEncryptionConfigured) {
    return 'Set up Google encryption to enable Sync and Restore.';
  }
  if (!readiness.isEncryptionUnlocked) {
    return 'Unlock Google encryption on this device to enable Sync and Restore.';
  }
  if (options?.isActionBlocked) {
    return 'Finish the current sync or Google encryption action first.';
  }
  return null;
}

export function getProviderActionBlockedMessage(
  readiness: ProviderReadiness,
  action: ProviderSyncAction,
  subject: string,
): string | null {
  if (!readiness.isConnected) {
    return `Connect Google Drive before ${action}ing ${subject}.`;
  }
  if (!readiness.isEncryptionConfigured) {
    return `Set up Google encryption before ${action}ing ${subject}.`;
  }
  if (!readiness.isEncryptionUnlocked) {
    return `Unlock Google encryption before ${action}ing ${subject}.`;
  }
  return null;
}

export function getSyncEncryptionStateLabel(
  googleSync: SyncProviderStatus | null,
  googleCollection: SyncCollectionStatus | null,
): 'Connect provider first' | 'Not set up' | 'Locked' | 'Ready' {
  if (!googleSync?.connected) return 'Connect provider first';
  if (!googleCollection?.configured) return 'Not set up';
  if (!googleCollection.keyCached) return 'Locked';
  return 'Ready';
}