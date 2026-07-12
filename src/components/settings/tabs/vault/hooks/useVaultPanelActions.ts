import { useCallback, useEffect, useRef, useState } from 'react';
import { open, save } from '@tauri-apps/plugin-dialog';
import { vaultIpc, type SecureToVaultPreview } from '../../../../../vault/ipc';
import {
  notifySyncStatusChanged,
  syncIpc,
  type SyncDomainPolicy,
  type SyncCollectionSetupArgs,
  type SyncCollectionUnlockArgs,
  type SyncRestoreConflictItem,
  type SyncRestorePreviewResult,
} from '../../../../../vault/syncIpc';
import { parseSyncInvokeError } from '../../../../../vault/syncError';
import {
  getProviderActionBlockedMessage,
  type ProviderSyncAction,
} from '../../../../../vault/syncProviderGate';
import {
  ensureSyncReadinessListener,
  useSyncReadinessStore,
} from '../../../../../vault/useSyncReadinessStore';
import { useConnectionsRestore } from './useConnectionsRestore';
import { disconnectVaultBackedIpc } from '../../../../../features/connections/infrastructure/connectionIpc';
import type { VaultItem } from '../../../../../vault/ipc';
import type { ToastType } from '../../../../../store/toastSlice';
import type { Connection, Tab } from '../../../../../features/connections/domain/types';

interface UseVaultPanelActionsOptions {
  connections: Connection[];
  tabs: Tab[];
  items: VaultItem[];
  showToast: (type: ToastType, message: string) => void;
  showConfirmDialog: (opts: {
    title: string;
    message: string;
    confirmText: string;
    variant?: 'danger';
  }) => Promise<boolean>;
  onLocked: () => Promise<void>;
  onRefresh: () => Promise<void>;
  onRefreshItems: () => Promise<void>;
  onLoadConnections: () => Promise<void>;
  onDisconnectConnection: (id: string) => Promise<void>;
  onReloadTunnels?: () => Promise<void>;
  onReloadSnippets?: () => Promise<void>;
  onReloadSettings?: () => Promise<void>;
}

interface RecoveryModalState {
  key: string;
  title: string;
  subtitle: string;
  fileTitle: string;
  fileDescription: string;
  downloadFileName: string;
}

const DEFAULT_RECOVERY_MODAL_STATE: RecoveryModalState = {
  key: '',
  title: 'Vault Recovery Key',
  subtitle: 'Save this key somewhere safe. It can unlock your vault if you forget your passphrase.',
  fileTitle: 'Zync Vault Recovery Key',
  fileDescription: 'This key can unlock your vault if you forget your passphrase.',
  downloadFileName: 'zync-vault-recovery-key.txt',
};

const extractErrorMessage = (error: unknown): string => {
  if (error == null) return 'Unknown error';
  if (typeof error === 'object' && 'message' in error) {
    return String((error as { message: unknown }).message);
  }
  return String(error);
};

function connectionUsesVaultCredential(
  connections: Connection[],
  connectionId: string,
  visited = new Set<string>(),
): boolean {
  if (visited.has(connectionId)) return false;
  visited.add(connectionId);
  const connection = connections.find(c => c.id === connectionId);
  if (!connection) return false;
  if (connection.authRef) return true;
  return connection.jumpServerId
    ? connectionUsesVaultCredential(connections, connection.jumpServerId, visited)
    : false;
}

export function useVaultPanelActions({
  connections,
  tabs,
  items,
  showToast,
  showConfirmDialog,
  onLocked,
  onRefresh,
  onRefreshItems,
  onLoadConnections,
  onDisconnectConnection,
  onReloadTunnels,
  onReloadSnippets,
  onReloadSettings,
}: UseVaultPanelActionsOptions) {
  // ── Secure-to-vault ───────────────────────────────────────────────────────
  const [securePreview, setSecurePreview] = useState<SecureToVaultPreview | null>(null);
  const [isMigrating, setIsMigrating] = useState(false);

  const loadSecurePreview = useCallback(async () => {
    try {
      const preview = await vaultIpc.secureToVaultPreview();
      setSecurePreview(preview);
    } catch (error) {
      console.warn('[Vault] Failed to load secure-to-vault preview:', error);
    }
  }, []);

  const handleSecureToVault = async () => {
    const securableCount =
      securePreview?.candidates.filter(
        c => c.secureKind === 'ssh-password' || c.secureKind === 'ssh-private-key',
      ).length ?? 0;

    const confirmed = await showConfirmDialog({
      title: 'Secure Credentials in Vault',
      message: `Secure ${securableCount} connection credential(s) in the encrypted vault. A backup will be saved first.`,
      confirmText: 'Secure Credentials',
    });
    if (!confirmed) return;

    setIsMigrating(true);
    try {
      const result = await vaultIpc.secureToVault();
      showToast(
        'success',
        `Secured ${result.secured} credential(s).${result.backupPath ? ' Backup saved.' : ''}`,
      );
      await onLoadConnections();
      await onRefresh();
      await loadSecurePreview();
    } catch (e: unknown) {
      const msg = extractErrorMessage(e);
      showToast('error', `Secure to vault failed: ${msg}`);
    } finally {
      setIsMigrating(false);
    }
  };

  // ── Lock ──────────────────────────────────────────────────────────────────
  const handleLock = async () => {
    try {
      const backendVaultBackedIds = await disconnectVaultBackedIpc().catch(error => {
        console.warn('[Vault] Backend vault-backed disconnect failed:', error);
        return [] as string[];
      });
      const activeTabConnectionIds = tabs
        .map(tab => tab.connectionId)
        .filter((id): id is string => Boolean(id) && id !== 'local');
      const vaultBackedConnectionIds = new Set([
        ...backendVaultBackedIds,
        ...connections
          .filter(
            c =>
              c.id !== 'local' &&
              (c.status === 'connected' || c.status === 'connecting') &&
              connectionUsesVaultCredential(connections, c.id),
          )
          .map(c => c.id),
        ...activeTabConnectionIds.filter(id =>
          connectionUsesVaultCredential(connections, id),
        ),
      ]);

      const vaultBackedIds = [...vaultBackedConnectionIds];
      const disconnectResults = await Promise.allSettled(
        vaultBackedIds.map(id => onDisconnectConnection(id)),
      );
      disconnectResults.forEach((result, index) => {
        if (result.status === 'rejected') {
          console.error(
            '[Vault] Failed to disconnect vault-backed connection:',
            vaultBackedIds[index],
            result.reason,
          );
        }
      });
      const disconnectedCount = disconnectResults.filter(r => r.status === 'fulfilled').length;
      const failedDisconnectIds = disconnectResults
        .map((result, index) => (result.status === 'rejected' ? vaultBackedIds[index] : null))
        .filter((id): id is string => Boolean(id));

      await onLocked();
      showToast('info', 'Vault locked.');
      if (vaultBackedIds.length > 0) {
        showToast(
          'info',
          `Disconnected ${disconnectedCount} vault-backed connection${disconnectedCount === 1 ? '' : 's'} for security.`,
        );
        if (failedDisconnectIds.length > 0) {
          showToast(
            'error',
            `Could not disconnect ${failedDisconnectIds.length} connection${failedDisconnectIds.length === 1 ? '' : 's'}: ${failedDisconnectIds.join(', ')}`,
          );
        }
      }
    } catch (e: unknown) {
      const msg = extractErrorMessage(e);
      showToast('error', `Failed to lock vault: ${msg}`);
    }
  };

  // ── Recovery key ──────────────────────────────────────────────────────────
  const [recoveryState, setRecoveryState] = useState<RecoveryModalState>(DEFAULT_RECOVERY_MODAL_STATE);
  const [isRecoveryModalOpen, setIsRecoveryModalOpen] = useState(false);
  const [hasRecoveryKey, setHasRecoveryKey] = useState(false);

  const loadHasRecoveryKey = useCallback(async () => {
    try {
      const has = await vaultIpc.hasRecoveryKey();
      setHasRecoveryKey(has);
    } catch (error) {
      console.warn('[Vault] Failed to load recovery-key status:', error);
    }
  }, []);

  const handleGenerateRecoveryKey = async () => {
    if (hasRecoveryKey) {
      const confirmed = await showConfirmDialog({
        title: 'Replace Recovery Key',
        message: 'This will replace your existing recovery key. The old key will no longer work.',
        confirmText: 'Replace',
        variant: 'danger',
      });
      if (!confirmed) return;
    }
    try {
      const key = await vaultIpc.generateRecoveryKey();
      setRecoveryState({
        ...DEFAULT_RECOVERY_MODAL_STATE,
        key,
      });
      setHasRecoveryKey(true);
      setIsRecoveryModalOpen(true);
    } catch (e: unknown) {
      const msg = extractErrorMessage(e);
      showToast('error', `Failed to generate recovery key: ${msg}`);
    }
  };

  const closeRecoveryModal = () => {
    setRecoveryState(prev => ({ ...prev, key: '' }));
    setIsRecoveryModalOpen(false);
  };

  // ── Export / Import ───────────────────────────────────────────────────────
  const handleExport = async () => {
    try {
      const destPath = await save({
        defaultPath: 'zync-vault-backup.redb',
        filters: [{ name: 'Vault Backup', extensions: ['redb'] }],
      });
      if (!destPath) return;
      await vaultIpc.exportVault(destPath);
      showToast('success', 'Vault exported successfully.');
    } catch (e: unknown) {
      const msg = extractErrorMessage(e);
      showToast('error', `Export failed: ${msg}`);
    }
  };

  const handleImport = async () => {
    const confirmed = await showConfirmDialog({
      title: 'Import Vault',
      message:
        'This replaces your current vault with the imported file. A backup is saved first. You will need to unlock the imported vault with its passphrase.',
      confirmText: 'Import',
      variant: 'danger',
    });
    if (!confirmed) return;

    try {
      const srcPath = await open({
        multiple: false,
        directory: false,
        filters: [{ name: 'Vault Backup', extensions: ['redb'] }],
      });
      if (!srcPath) return;
      const path = Array.isArray(srcPath) ? srcPath[0] : srcPath;
      await vaultIpc.importVault(path);
      await onRefresh();
      showToast('success', 'Vault imported. Please unlock it with the vault passphrase.');
    } catch (e: unknown) {
      const msg = extractErrorMessage(e);
      showToast('error', `Import failed: ${msg}`);
    }
  };

  // ── Google sync (shared readiness store — same as All Hosts) ──────────────
  useEffect(() => {
    ensureSyncReadinessListener();
  }, []);
  const googleSync = useSyncReadinessStore(s => s.oauth);
  const googleCollection = useSyncReadinessStore(s => s.collection);
  const readiness = useSyncReadinessStore(s => s.readiness);
  const setGoogleSync = useSyncReadinessStore(s => s.setOauth);
  const setGoogleCollection = useSyncReadinessStore(s => s.setCollection);
  const patchGoogleSync = useSyncReadinessStore(s => s.patchOauth);
  const refreshSyncReadiness = useSyncReadinessStore(s => s.refresh);
  const [isSyncing, setIsSyncing] = useState(false);
  const [isSyncingVault, setIsSyncingVault] = useState(false);
  const [isRestoringVault, setIsRestoringVault] = useState(false);
  const [isSyncingHosts, setIsSyncingHosts] = useState(false);
  const [isRestoringHosts, setIsRestoringHosts] = useState(false);
  const [isSyncingTunnels, setIsSyncingTunnels] = useState(false);
  const [isRestoringTunnels, setIsRestoringTunnels] = useState(false);
  const [isSyncingSnippets, setIsSyncingSnippets] = useState(false);
  const [isRestoringSnippets, setIsRestoringSnippets] = useState(false);
  const [isSyncingSettings, setIsSyncingSettings] = useState(false);
  const [isRestoringSettings, setIsRestoringSettings] = useState(false);
  const [domainPolicies, setDomainPolicies] = useState<SyncDomainPolicy[]>([]);
  const [isUpdatingDomainPolicy, setIsUpdatingDomainPolicy] = useState(false);
  const [isSettingUpCollection, setIsSettingUpCollection] = useState(false);
  const [isUnlockingCollection, setIsUnlockingCollection] = useState(false);
  const [isLockingCollection, setIsLockingCollection] = useState(false);
  const [isRegeneratingCollectionRecoveryKey, setIsRegeneratingCollectionRecoveryKey] = useState(false);
  const [syncingItemId, setSyncingItemId] = useState<string | null>(null);
  const [isRestoreConflictModalOpen, setIsRestoreConflictModalOpen] = useState(false);
  const [restorePreview, setRestorePreview] = useState<SyncRestorePreviewResult | null>(null);
  const [restoreConflictItems, setRestoreConflictItems] = useState<SyncRestoreConflictItem[]>([]);
  const [selectedConflictLogicalIds, setSelectedConflictLogicalIds] = useState<string[]>([]);
  const hostsPolicy = domainPolicies.find(policy => policy.domain === 'hosts');
  const hostsSyncEnabled = hostsPolicy ? hostsPolicy.enabled : true;

  const ensureProviderAction = useCallback(
    (action: ProviderSyncAction, subject: string): boolean => {
      const blockedMessage = getProviderActionBlockedMessage(readiness, action, subject);
      if (blockedMessage) {
        showToast('error', blockedMessage);
        return false;
      }
      return true;
    },
    [readiness, showToast],
  );

  const loadGoogleSync = useCallback(async () => {
    try {
      await refreshSyncReadiness('google');
    } catch (error) {
      console.warn('[Vault] Failed to load Google sync status:', error);
    }
  }, [refreshSyncReadiness]);

  const loadGoogleCollection = useCallback(async () => {
    try {
      await refreshSyncReadiness('google');
    } catch (error) {
      console.warn('[Vault] Failed to load Google encryption status:', error);
    }
  }, [refreshSyncReadiness]);

  const handleSetupGoogleCollection = async (args: SyncCollectionSetupArgs) => {
    setIsSettingUpCollection(true);
    try {
      const result = await syncIpc.collectionSetup('google', args);
      setGoogleCollection(result.status);
      if (result.recoveryKey) {
        setRecoveryState({
          key: result.recoveryKey,
          title: 'Google Encryption Recovery Key',
          subtitle: 'Save this key somewhere safe. It can unlock Google-encrypted sync records if you forget the encryption passphrase.',
          fileTitle: 'Zync Google Encryption Recovery Key',
          fileDescription: 'This key can unlock your encrypted Google Drive records if you forget the encryption passphrase.',
          downloadFileName: 'zync-google-sync-recovery-key.txt',
        });
        setIsRecoveryModalOpen(true);
      }
      showToast(
        'success',
        args.keyPolicyMode === 'local-passphrase'
          ? 'Google encryption configured (Local Vault passphrase policy).'
          : 'Google encryption configured (custom passphrase policy).',
      );
    } catch (e: unknown) {
      const msg = extractErrorMessage(e);
      showToast('error', `Failed to set up Google encryption: ${msg}`);
      throw new Error(msg);
    } finally {
      setIsSettingUpCollection(false);
    }
  };

  const handleRegenerateGoogleCollectionRecoveryKey = async () => {
    setIsRegeneratingCollectionRecoveryKey(true);
    try {
      const result = await syncIpc.collectionRegenerateRecoveryKey('google');
      setGoogleCollection(result.status);
      if (result.recoveryKey) {
        setRecoveryState({
          key: result.recoveryKey,
          title: 'Google Encryption Recovery Key',
          subtitle: 'Recovery key regenerated. Save this new key safely — older Google encryption recovery keys no longer unlock Google sync records.',
          fileTitle: 'Zync Google Encryption Recovery Key',
          fileDescription: 'This key can unlock your encrypted Google Drive records if you forget the encryption passphrase.',
          downloadFileName: 'zync-google-sync-recovery-key.txt',
        });
        setIsRecoveryModalOpen(true);
      }
      showToast('success', 'Google encryption recovery key regenerated.');
    } catch (e: unknown) {
      const msg = extractErrorMessage(e);
      showToast('error', `Failed to regenerate Google encryption recovery key: ${msg}`);
    } finally {
      setIsRegeneratingCollectionRecoveryKey(false);
    }
  };

  const handleLockGoogleCollection = async () => {
    setIsLockingCollection(true);
    try {
      const result = await syncIpc.collectionLock('google');
      setGoogleCollection(result);
      showToast('success', 'Google encryption locked on this device.');
    } catch (e: unknown) {
      const msg = extractErrorMessage(e);
      showToast('error', `Failed to lock Google encryption: ${msg}`);
    } finally {
      setIsLockingCollection(false);
    }
  };


  const handleUnlockGoogleCollection = async (args: SyncCollectionUnlockArgs) => {
    setIsUnlockingCollection(true);
    try {
      const result = await syncIpc.collectionUnlock('google', args);
      setGoogleCollection(result);
      showToast('success', 'Google encryption unlocked on this device.');
    } catch (e: unknown) {
      const msg = parseSyncInvokeError(e).message;
      showToast('error', `Failed to unlock Google encryption: ${msg}`);
      throw new Error(msg);
    } finally {
      setIsUnlockingCollection(false);
    }
  };

  const handleGoogleConnect = async () => {
    setIsSyncing(true);
    try {
      await syncIpc.connect('google');
      const status = await syncIpc.status('google');
      setGoogleSync(status);
      const collection = await syncIpc.collectionStatus('google');
      setGoogleCollection(collection);
      showToast(
        'success',
        `Connected to Google Drive${status.email ? ` as ${status.email}` : ''}.`,
      );
      if (!collection.configured) {
        showToast(
          'info',
          'Set up Google encryption before using Sync or Restore.',
        );
      }
    } catch (e: unknown) {
      const msg = parseSyncInvokeError(e).message;
      showToast('error', `Google Drive connection failed: ${msg}`);
    } finally {
      setIsSyncing(false);
    }
  };

  const handleGoogleDisconnect = async () => {
    const confirmed = await showConfirmDialog({
      title: 'Disconnect Google Drive',
      message: 'Remove the stored Google Drive tokens. The vault backup will remain in Drive.',
      confirmText: 'Disconnect',
      variant: 'danger',
    });
    if (!confirmed) return;
    try {
      await syncIpc.disconnect('google');
      setGoogleSync({ connected: false });
      showToast('info', 'Disconnected from Google Drive.');
    } catch (e: unknown) {
      const parsed = parseSyncInvokeError(e);
      const msg = parsed.message;
      const code = parsed.code ?? '';
      if (code === 'LOCAL_DISCONNECT_ONLY' || msg.startsWith('Disconnected locally,')) {
        setGoogleSync({ connected: false });
        notifySyncStatusChanged('google', { connected: false });
        showToast('info', 'Disconnected from Google Drive locally.');
        return;
      }
      showToast('error', `Failed to disconnect from Google Drive: ${msg}`);
    }
  };

  const handleSyncUpload = async () => {
    setIsSyncingVault(true);
    try {
      const result = await syncIpc.uploadCredentials('google');
      patchGoogleSync({ lastSync: result.syncedAt });
      await loadGoogleSync();
      showToast(
        result.uploaded > 0 ? 'success' : 'info',
        result.uploaded > 0
          ? `Synced ${result.uploaded} vault credential${result.uploaded === 1 ? '' : 's'} to Google Drive.`
          : 'No vault credentials to sync.',
      );
    } catch (e: unknown) {
      const msg = parseSyncInvokeError(e).message;
      showToast('error', `Credential sync failed: ${msg}`);
    } finally {
      setIsSyncingVault(false);
    }
  };

  const runRestoreCredentials = async (resolveConflictLogicalIds?: string[]): Promise<boolean> => {
    setIsRestoringVault(true);
    try {
      const args = resolveConflictLogicalIds && resolveConflictLogicalIds.length > 0
        ? { resolveConflictLogicalIds }
        : {};
      const result = await syncIpc.restoreCredentials('google', args);
      await onRefreshItems();
      await onRefresh();
      await loadGoogleSync();
      const restoredTotal = result.restored + result.updated;
      if (restoredTotal > 0) {
        showToast(
          'success',
          `Restored ${restoredTotal} credential${restoredTotal === 1 ? '' : 's'} from Google (${result.restored} new, ${result.updated} updated, ${result.tombstonesApplied} deleted, ${result.skipped} skipped).`,
        );
      } else {
        showToast(
          'info',
          `No credential changes applied from Google (${result.skipped} skipped, ${result.conflicts} conflicts, ${result.failed} failed).`,
        );
      }
      if (result.conflicts > 0) {
        showToast(
          'info',
          `${result.conflicts} conflict${result.conflicts === 1 ? '' : 's'} skipped (same revision/timestamp with different payload).`,
        );
      }
      if (result.failed > 0) {
        showToast(
          'error',
          `${result.failed} provider record${result.failed === 1 ? '' : 's'} failed during restore. Check logs for details.`,
        );
      }
      return true;
    } catch (e: unknown) {
      const msg = parseSyncInvokeError(e).message;
      showToast('error', `Restore failed: ${msg}`);
      return false;
    } finally {
      setIsRestoringVault(false);
    }
  };

  const handleSyncDownload = async () => {
    try {
      const preview = await syncIpc.restorePreview('google');
      setRestorePreview(preview);
      setRestoreConflictItems(preview.conflictItems);
      setSelectedConflictLogicalIds([]);
      setIsRestoreConflictModalOpen(true);
      return;
    } catch (error) {
      console.warn('[Vault] Failed to load restore preview:', error);
    }

    const confirmed = await showConfirmDialog({
      title: 'Restore Credentials from Drive',
      message:
        'Preview was unavailable. Restore encrypted credentials from Google into your current unlocked local vault? This does not replace the local vault file.',
      confirmText: 'Restore',
    });
    if (!confirmed) return;
    await runRestoreCredentials();
  };

  const toggleConflictLogicalId = (logicalId: string) => {
    setSelectedConflictLogicalIds(prev =>
      prev.includes(logicalId)
        ? prev.filter(id => id !== logicalId)
        : [...prev, logicalId],
    );
  };

  const selectAllConflictLogicalIds = () => {
    setSelectedConflictLogicalIds(restoreConflictItems.map(item => item.logicalId));
  };

  const clearConflictLogicalIds = () => {
    setSelectedConflictLogicalIds([]);
  };

  const closeRestoreConflictModal = () => {
    if (isRestoringVault) return;
    setIsRestoreConflictModalOpen(false);
    setRestorePreview(null);
    setRestoreConflictItems([]);
    setSelectedConflictLogicalIds([]);
  };

  const confirmRestoreWithConflictSelection = async () => {
    const ok = await runRestoreCredentials(selectedConflictLogicalIds);
    if (ok) {
      closeRestoreConflictModal();
    }
  };

  const handleSyncCredentialItem = async (itemId: string, label: string) => {
    if (!ensureProviderAction('sync', 'credentials')) return;
    setSyncingItemId(itemId);
    try {
      const result = await syncIpc.uploadCredential('google', { itemId });
      patchGoogleSync({
        lastSync: result.syncedAt,
        lastError: undefined,
        lastErrorCode: undefined,
      });
      await loadGoogleSync();
      showToast('success', `Synced "${label}" to Google (${result.logicalId.slice(0, 8)}).`);
    } catch (error) {
      const msg = parseSyncInvokeError(error).message;
      showToast('error', `Failed to sync "${label}": ${msg}`);
    } finally {
      setSyncingItemId(null);
    }
  };

  // Delta by default. The first host sync still uploads all records because the
  // backend has no Hosts-domain watermark yet; later clicks upload changed hosts.
  const handleSyncHosts = async (includeAll = false) => {
    if (!hostsSyncEnabled) {
      showToast('error', 'Hosts sync is disabled. Enable hosts domain sync first.');
      return;
    }
    if (!ensureProviderAction('sync', 'hosts')) return;

    setIsSyncingHosts(true);
    try {
      const changes = await syncIpc.hostsChanges('google', { includeAll });
      if (!includeAll && changes.count === 0) {
        showToast('info', 'No host changes to sync.');
        return;
      }
      const result = await syncIpc.hostsUpload('google', { includeAll });
      patchGoogleSync({
        lastSync: result.syncedAt,
        lastError: undefined,
        lastErrorCode: undefined,
      });
      await onLoadConnections();
      await loadGoogleSync();
      const syncedCount = result.uploaded;
      const syncedCredentials = result.credentialsUploaded;
      const skippedCount = result.skipped;
      const credentialSuffix = syncedCredentials > 0
        ? ` and ${syncedCredentials} referenced credential${syncedCredentials === 1 ? '' : 's'}`
        : '';
      showToast(
        'success',
        `Synced ${syncedCount} host${syncedCount === 1 ? '' : 's'}${credentialSuffix} to Google${skippedCount > 0 ? ` (${skippedCount} skipped)` : ''}.`,
      );
    } catch (error) {
      const msg = parseSyncInvokeError(error).message;
      showToast('error', `Host sync failed: ${msg}`);
    } finally {
      setIsSyncingHosts(false);
    }
  };

  const {
    isPreviewingConnections,
    isRestoringConnections,
    isConnectionsRestorePreviewOpen,
    connectionsRestorePreview,
    pendingConnectionsRestoreArgs,
    handleRestoreConnections,
    closeConnectionsRestorePreviewModal,
    confirmConnectionsRestore,
  } = useConnectionsRestore({
    hostsSyncEnabled,
    googleSync,
    googleCollection,
    showToast,
    patchGoogleSync,
    onLoadConnections,
    loadGoogleSync,
    onReloadTunnels,
    onReloadSnippets,
  });

  const handleRestoreHosts = async () => {
    if (!hostsSyncEnabled) {
      showToast('error', 'Hosts sync is disabled. Enable hosts domain sync first.');
      return;
    }
    if (!ensureProviderAction('restore', 'hosts')) return;

    const confirmed = await showConfirmDialog({
      title: 'Restore Hosts from Drive',
      message:
        'Restore synced host metadata from Google Drive into local hosts list. Referenced vault credentials will be restored first so vault-backed hosts can connect.',
      confirmText: 'Restore Hosts',
    });
    if (!confirmed) return;

    setIsRestoringHosts(true);
    try {
      const result = await syncIpc.hostsRestore('google');
      patchGoogleSync({
        lastSync: result.syncedAt,
        lastError: undefined,
        lastErrorCode: undefined,
      });
      await onLoadConnections();
      await loadGoogleSync();
      const changed = result.restored + result.updated;
      const credentialChanged = result.credentialsRestored + result.credentialsUpdated;
      showToast(
        changed > 0 ? 'success' : 'info',
        changed > 0
          ? `Restored ${changed} host${changed === 1 ? '' : 's'} from Google (${result.restored} new, ${result.updated} updated${credentialChanged > 0 ? `; ${credentialChanged} credential${credentialChanged === 1 ? '' : 's'} restored` : ''}).`
          : 'No host changes restored from Google.',
      );
      if (result.failed > 0) {
        showToast('error', `${result.failed} host record(s) failed to parse/decrypt.`);
      }
      if (result.credentialsFailed > 0 || result.credentialsConflicts > 0) {
        showToast(
          'error',
          `${result.credentialsFailed + result.credentialsConflicts} referenced credential record(s) need attention before some hosts can connect.`,
        );
      }
    } catch (error) {
      const msg = parseSyncInvokeError(error).message;
      showToast('error', `Host restore failed: ${msg}`);
    } finally {
      setIsRestoringHosts(false);
    }
  };

  const runDomainUpload = async (
    domain: 'tunnels' | 'snippets' | 'settings',
    setLoading: (v: boolean) => void,
  ) => {
    const policy = domainPolicies.find(p => p.domain === domain);
    if (policy && !policy.enabled) {
      showToast('error', `${domain} sync is disabled. Enable ${domain} domain sync first.`);
      return;
    }
    if (!ensureProviderAction('sync', domain)) return;

    setLoading(true);
    try {
      const result =
        domain === 'tunnels'
          ? await syncIpc.tunnelsUpload('google')
          : domain === 'snippets'
            ? await syncIpc.snippetsUpload('google')
            : await syncIpc.settingsUpload('google');
      patchGoogleSync({
        lastSync: result.syncedAt,
        lastError: undefined,
        lastErrorCode: undefined,
      });
      await loadGoogleSync();
      showToast(
        'success',
        `Synced ${result.uploaded} ${domain} record${result.uploaded === 1 ? '' : 's'} to Google.`,
      );
    } catch (error) {
      const msg = parseSyncInvokeError(error).message;
      showToast('error', `${domain} sync failed: ${msg}`);
    } finally {
      setLoading(false);
    }
  };

  const runDomainRestore = async (
    domain: 'tunnels' | 'snippets' | 'settings',
    setLoading: (v: boolean) => void,
    snippetsArgs?: { globalOnly?: boolean },
  ) => {
    const policy = domainPolicies.find(p => p.domain === domain);
    if (policy && !policy.enabled) {
      showToast('error', `${domain} sync is disabled. Enable ${domain} domain sync first.`);
      return;
    }
    if (!ensureProviderAction('restore', domain)) return;
    setLoading(true);
    try {
      const result =
        domain === 'tunnels'
          ? await syncIpc.tunnelsRestore('google')
          : domain === 'snippets'
            ? await syncIpc.snippetsRestore('google', snippetsArgs ?? {})
            : await syncIpc.settingsRestore('google');
      patchGoogleSync({
        lastSync: result.syncedAt,
        lastError: undefined,
        lastErrorCode: undefined,
      });
      await loadGoogleSync();
      if (domain === 'tunnels') {
        await onReloadTunnels?.();
      } else if (domain === 'snippets') {
        await onReloadSnippets?.();
      } else {
        await onReloadSettings?.();
      }
      const changed = result.restored + result.updated;
      showToast(
        changed > 0 ? 'success' : 'info',
        changed > 0
          ? `Restored ${changed} ${domain} record${changed === 1 ? '' : 's'} (${result.restored} new, ${result.updated} updated).`
          : `No ${domain} changes restored from Google.`,
      );
    } catch (error) {
      const msg = parseSyncInvokeError(error).message;
      showToast('error', `${domain} restore failed: ${msg}`);
    } finally {
      setLoading(false);
    }
  };

  const handleSyncTunnels = async () => runDomainUpload('tunnels', setIsSyncingTunnels);
  const handleRestoreTunnels = async () => runDomainRestore('tunnels', setIsRestoringTunnels);
  const handleSyncSnippets = async () => runDomainUpload('snippets', setIsSyncingSnippets);
  const handleRestoreSnippets = async () => runDomainRestore('snippets', setIsRestoringSnippets);
  const handleRestoreGlobalSnippets = async () =>
    runDomainRestore('snippets', setIsRestoringSnippets, { globalOnly: true });
  const handleSyncSettings = async () => runDomainUpload('settings', setIsSyncingSettings);
  const handleRestoreSettings = async () => runDomainRestore('settings', setIsRestoringSettings);

  const loadDomainPolicies = useCallback(async () => {
    try {
      const result = await syncIpc.domainPolicies('google');
      setDomainPolicies(result.policies);
    } catch (error) {
      console.warn('[Vault] Failed to load sync domain policies:', error);
    }
  }, []);

  const handleSetDomainPolicyEnabled = async (domain: SyncDomainPolicy['domain'], enabled: boolean) => {
    setIsUpdatingDomainPolicy(true);
    try {
      const existing = domainPolicies.find(policy => policy.domain === domain);
      const result = await syncIpc.domainPolicySet('google', {
        domain,
        enabled,
        mode: existing?.mode ?? 'manual',
      });
      setDomainPolicies(result.policies);
      showToast('success', `${domain} sync ${enabled ? 'enabled' : 'disabled'}.`);
    } catch (error) {
      const msg = parseSyncInvokeError(error).message;
      showToast('error', `Failed to update ${domain} sync policy: ${msg}`);
    } finally {
      setIsUpdatingDomainPolicy(false);
    }
  };

  const handleSetHostsSyncEnabled = async (enabled: boolean) => {
    await handleSetDomainPolicyEnabled('hosts', enabled);
  };

  // ── Repair refs ───────────────────────────────────────────────────────────
  const [isRepairingRefs, setIsRepairingRefs] = useState(false);

  const handleRepairRefs = async () => {
    setIsRepairingRefs(true);
    try {
      const result = await vaultIpc.backfillConnectionRefs();
      await onLoadConnections();
      const parts: string[] = [];
      if (result.updated > 0) parts.push(`${result.updated} credential ID backfilled`);
      if (result.relinkedItemIds > 0)
        parts.push(`${result.relinkedItemIds} item reference relinked`);
      if (result.skippedMissingItems > 0)
        parts.push(`${result.skippedMissingItems} still missing`);
      showToast(
        'success',
        parts.length > 0
          ? `Vault repair complete: ${parts.join(' · ')}.`
          : 'Vault repair complete. No changes were needed.',
      );
    } catch (e: unknown) {
      const msg = extractErrorMessage(e);
      showToast('error', `Vault repair failed: ${msg}`);
    } finally {
      setIsRepairingRefs(false);
    }
  };

  // ── Delete item ───────────────────────────────────────────────────────────
  const handleDeleteItem = async (itemId: string, label: string) => {
    const confirmed = await showConfirmDialog({
      title: 'Delete Vault Item',
      message: `Delete "${label}"? Connections referencing this item will fail to connect.`,
      confirmText: 'Delete',
      variant: 'danger',
    });
    if (!confirmed) return;

    try {
      await vaultIpc.itemDelete(itemId);
      await onRefreshItems();
      showToast('success', `Deleted "${label}".`);
    } catch (e: unknown) {
      const msg = extractErrorMessage(e);
      showToast('error', `Failed to delete: ${msg}`);
    }
  };

  // ── Deduplicate ───────────────────────────────────────────────────────────
  const [isDeduplicating, setIsDeduplicating] = useState(false);

  const handleDeduplicateItems = async () => {
    const referencedIds = new Set(connections.map(c => c.authRef?.itemId).filter(Boolean));
    const referencedCredentialIds = new Set(
      connections.map(c => c.authRef?.credentialId).filter(Boolean),
    );
    // connections may reference credentials by logical ID (credentialId),
    // so when referencedCredentialIds includes item.logicalId we also keep
    // item.id in referencedIds before deduplicating items.
    for (const item of items) {
      if (referencedCredentialIds.has(item.logicalId)) {
        referencedIds.add(item.id);
      }
    }

    const toDelete: string[] = [];
    const groups = new Map<string, typeof items>();
    for (const item of items) {
      const fingerprint = `${item.kind}:${item.secretFingerprint}`;
      const group = groups.get(fingerprint);
      if (group) group.push(item);
      else groups.set(fingerprint, [item]);
    }
    for (const group of groups.values()) {
      if (group.length <= 1) continue;
      const sorted = [...group].sort((a, b) => {
        const aRef = referencedIds.has(a.id) ? 1 : 0;
        const bRef = referencedIds.has(b.id) ? 1 : 0;
        if (aRef !== bRef) return bRef - aRef;
        return b.createdAt - a.createdAt;
      });
      const [, ...duplicates] = sorted;
      toDelete.push(...duplicates.map(i => i.id));
    }

    const duplicateCount = toDelete.length;
    const confirmed = await showConfirmDialog({
      title: 'Remove Duplicate Items',
      message: `Found ${duplicateCount} duplicate vault item(s). Items referenced by a connection are kept; unreferenced duplicates are deleted. This cannot be undone.`,
      confirmText: 'Remove Duplicates',
      variant: 'danger',
    });
    if (!confirmed) return;

    setIsDeduplicating(true);
    try {
      const deleteResults = await Promise.allSettled(
        toDelete.map(id => vaultIpc.itemDelete(id)),
      );
      const succeededCount = deleteResults.filter(r => r.status === 'fulfilled').length;
      const failedCount = deleteResults.filter(r => r.status === 'rejected').length;
      await onRefreshItems();
      if (failedCount === 0) {
        showToast('success', `Removed ${succeededCount} duplicate item(s).`);
      } else if (succeededCount > 0) {
        showToast(
          'info',
          `Removed ${succeededCount} duplicate item(s); ${failedCount} could not be deleted.`,
        );
      } else {
        showToast('error', `Deduplication failed: all ${failedCount} deletion(s) failed.`);
      }
    } catch (e: unknown) {
      const msg = extractErrorMessage(e);
      showToast('error', `Deduplication failed: ${msg}`);
    } finally {
      setIsDeduplicating(false);
    }
  };

  // ── Backfill ref (called on unlock) ───────────────────────────────────────
  const backfilledVaultIdsRef = useRef<Set<string>>(new Set());

  const runBackfillIfNeeded = useCallback(
    async (vaultId: string) => {
      if (backfilledVaultIdsRef.current.has(vaultId)) return;
      try {
        const result = await vaultIpc.backfillConnectionRefs();
        backfilledVaultIdsRef.current.add(vaultId);
        if (result.updated > 0) {
          await onLoadConnections();
          showToast(
            'info',
            `Backfilled stable credential IDs for ${result.updated} connection${result.updated > 1 ? 's' : ''}.`,
          );
        }
      } catch (error) {
        console.warn('[Vault] Failed to backfill credential ids:', error);
      }
    },
    [onLoadConnections, showToast],
  );

  // ── Item search ───────────────────────────────────────────────────────────
  const [itemSearch, setItemSearch] = useState('');

  return {
    // secure-to-vault
    securePreview,
    isMigrating,
    loadSecurePreview,
    handleSecureToVault,
    // lock
    handleLock,
    // recovery key
    recoveryKey: recoveryState.key,
    recoveryKeyTitle: recoveryState.title,
    recoveryKeySubtitle: recoveryState.subtitle,
    recoveryKeyFileTitle: recoveryState.fileTitle,
    recoveryKeyFileDescription: recoveryState.fileDescription,
    recoveryKeyDownloadFileName: recoveryState.downloadFileName,
    isRecoveryModalOpen,
    hasRecoveryKey,
    loadHasRecoveryKey,
    handleGenerateRecoveryKey,
    closeRecoveryModal,
    // export / import
    handleExport,
    handleImport,
    // google sync
    googleSync,
    googleCollection,
    isSyncing,
    isSyncingVault,
    isRestoringVault,
    isSettingUpCollection,
    isUnlockingCollection,
    isLockingCollection,
    isRegeneratingCollectionRecoveryKey,
    syncingItemId,
    isSyncingHosts,
    isRestoringHosts,
    isPreviewingConnections,
    isRestoringConnections,
    isSyncingTunnels,
    isRestoringTunnels,
    isSyncingSnippets,
    isRestoringSnippets,
    isSyncingSettings,
    isRestoringSettings,
    isRestoreConflictModalOpen,
    restorePreview,
    restoreConflictItems,
    selectedConflictLogicalIds,
    isConnectionsRestorePreviewOpen,
    connectionsRestorePreview,
    pendingConnectionsRestoreArgs,
    loadGoogleSync,
    loadGoogleCollection,
    loadDomainPolicies,
    handleSetupGoogleCollection,
    handleUnlockGoogleCollection,
    handleLockGoogleCollection,
    handleRegenerateGoogleCollectionRecoveryKey,
    handleGoogleConnect,
    handleGoogleDisconnect,
    handleSyncUpload,
    handleSyncDownload,
    toggleConflictLogicalId,
    selectAllConflictLogicalIds,
    clearConflictLogicalIds,
    closeRestoreConflictModal,
    confirmRestoreWithConflictSelection,
    closeConnectionsRestorePreviewModal,
    confirmConnectionsRestore,
    handleSyncCredentialItem,
    handleSyncHosts,
    handleRestoreHosts,
    handleRestoreConnections,
    handleRestoreGlobalSnippets,
    handleSyncTunnels,
    handleRestoreTunnels,
    handleSyncSnippets,
    handleRestoreSnippets,
    handleSyncSettings,
    handleRestoreSettings,
    domainPolicies,
    hostsSyncEnabled,
    isUpdatingDomainPolicy,
    handleSetDomainPolicyEnabled,
    handleSetHostsSyncEnabled,
    // repair
    isRepairingRefs,
    handleRepairRefs,
    // delete
    handleDeleteItem,
    // deduplicate
    isDeduplicating,
    handleDeduplicateItems,
    // backfill
    runBackfillIfNeeded,
    // search
    itemSearch,
    setItemSearch,
  };
}
