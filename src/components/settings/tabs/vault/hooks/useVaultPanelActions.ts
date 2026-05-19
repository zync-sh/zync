import { useCallback, useRef, useState } from 'react';
import { open, save } from '@tauri-apps/plugin-dialog';
import { vaultIpc, type SecureToVaultPreview } from '../../../../../vault/ipc';
import {
  notifySyncStatusChanged,
  syncIpc,
  type SyncDomainPolicy,
  type SyncCollectionSetupArgs,
  type SyncCollectionStatus,
  type SyncCollectionUnlockArgs,
  type SyncRestoreConflictItem,
  type SyncRestorePreviewResult,
  type SyncProviderStatus,
} from '../../../../../vault/syncIpc';
import { parseSyncInvokeError } from '../../../../../vault/syncError';
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
      confirmText: 'Secure Keys',
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

  // ── Google sync ───────────────────────────────────────────────────────────
  const [googleSync, setGoogleSync] = useState<SyncProviderStatus | null>(null);
  const [googleCollection, setGoogleCollection] = useState<SyncCollectionStatus | null>(null);
  const [isSyncing, setIsSyncing] = useState(false);
  const [isSyncingHosts, setIsSyncingHosts] = useState(false);
  const [isRestoringHosts, setIsRestoringHosts] = useState(false);
  const [isSyncingTunnels, setIsSyncingTunnels] = useState(false);
  const [isRestoringTunnels, setIsRestoringTunnels] = useState(false);
  const [isSyncingSnippets, setIsSyncingSnippets] = useState(false);
  const [isRestoringSnippets, setIsRestoringSnippets] = useState(false);
  const [isSyncingSettings, setIsSyncingSettings] = useState(false);
  const [isRestoringSettings, setIsRestoringSettings] = useState(false);
  const [domainPolicies, setDomainPolicies] = useState<SyncDomainPolicy[]>([]);
  const [isUpdatingHostsPolicy, setIsUpdatingHostsPolicy] = useState(false);
  const [isSettingUpCollection, setIsSettingUpCollection] = useState(false);
  const [isUnlockingCollection, setIsUnlockingCollection] = useState(false);
  const [isLockingCollection, setIsLockingCollection] = useState(false);
  const [isRegeneratingCollectionRecoveryKey, setIsRegeneratingCollectionRecoveryKey] = useState(false);
  const [syncingItemId, setSyncingItemId] = useState<string | null>(null);
  const [isRestoreConflictModalOpen, setIsRestoreConflictModalOpen] = useState(false);
  const [restorePreview, setRestorePreview] = useState<SyncRestorePreviewResult | null>(null);
  const [restoreConflictItems, setRestoreConflictItems] = useState<SyncRestoreConflictItem[]>([]);
  const [selectedConflictLogicalIds, setSelectedConflictLogicalIds] = useState<string[]>([]);

  const loadGoogleSync = useCallback(async () => {
    try {
      const status = await syncIpc.status('google');
      setGoogleSync(status);
    } catch (error) {
      console.warn('[Vault] Failed to load Google sync status:', error);
    }
  }, []);

  const loadGoogleCollection = useCallback(async () => {
    try {
      const status = await syncIpc.collectionStatus('google');
      setGoogleCollection(status);
    } catch (error) {
      console.warn('[Vault] Failed to load Google sync collection status:', error);
    }
  }, []);

  const handleSetupGoogleCollection = async (args: SyncCollectionSetupArgs) => {
    setIsSettingUpCollection(true);
    try {
      const result = await syncIpc.collectionSetup('google', args);
      setGoogleCollection(result.status);
      if (result.recoveryKey) {
        setRecoveryState({
          key: result.recoveryKey,
          title: 'Google Sync Recovery Key',
          subtitle: 'Save this key somewhere safe. It can unlock credentials stored in Google Drive if you forget the provider sync passphrase.',
          fileTitle: 'Zync Google Sync Recovery Key',
          fileDescription: 'This key can unlock your encrypted Google Drive sync collection if you forget the provider sync passphrase.',
          downloadFileName: 'zync-google-sync-recovery-key.txt',
        });
        setIsRecoveryModalOpen(true);
      }
      showToast(
        'success',
        args.keyPolicyMode === 'local-passphrase'
          ? 'Google sync collection configured (Local Vault passphrase policy).'
          : 'Google sync collection configured (custom provider sync passphrase policy).',
      );
    } catch (e: unknown) {
      const msg = extractErrorMessage(e);
      showToast('error', `Failed to set up Google sync collection: ${msg}`);
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
          title: 'Google Sync Recovery Key',
          subtitle: 'Recovery key regenerated. Save this new key safely — older Google Sync recovery keys no longer unlock this sync collection.',
          fileTitle: 'Zync Google Sync Recovery Key',
          fileDescription: 'This key can unlock your encrypted Google Drive sync collection if you forget the provider sync passphrase.',
          downloadFileName: 'zync-google-sync-recovery-key.txt',
        });
        setIsRecoveryModalOpen(true);
      }
      showToast('success', 'Google Sync Recovery Key regenerated.');
    } catch (e: unknown) {
      const msg = extractErrorMessage(e);
      showToast('error', `Failed to regenerate Google Sync Recovery Key: ${msg}`);
    } finally {
      setIsRegeneratingCollectionRecoveryKey(false);
    }
  };

  const handleLockGoogleCollection = async () => {
    setIsLockingCollection(true);
    try {
      const result = await syncIpc.collectionLock('google');
      setGoogleCollection(result);
      showToast('success', 'Google Sync Key locked on this device.');
    } catch (e: unknown) {
      const msg = extractErrorMessage(e);
      showToast('error', `Failed to lock Google Sync Key: ${msg}`);
    } finally {
      setIsLockingCollection(false);
    }
  };


  const handleUnlockGoogleCollection = async (args: SyncCollectionUnlockArgs) => {
    setIsUnlockingCollection(true);
    try {
      const result = await syncIpc.collectionUnlock('google', args);
      setGoogleCollection(result);
      showToast('success', 'Google sync key unlocked on this device.');
    } catch (e: unknown) {
      const msg = parseSyncInvokeError(e).message;
      showToast('error', `Failed to unlock Google sync key: ${msg}`);
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
          'Set up Google sync collection before using Backup/Restore.',
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
    setIsSyncing(true);
    try {
      const ts = await syncIpc.upload('google');
      setGoogleSync(prev => (prev ? { ...prev, lastSync: ts } : prev));
      await loadGoogleSync();
      showToast('success', 'Vault uploaded to Google Drive.');
    } catch (e: unknown) {
      const msg = parseSyncInvokeError(e).message;
      showToast('error', `Upload failed: ${msg}`);
    } finally {
      setIsSyncing(false);
    }
  };

  const runRestoreCredentials = async (resolveConflictLogicalIds?: string[]): Promise<boolean> => {
    setIsSyncing(true);
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
      setIsSyncing(false);
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
    if (isSyncing) return;
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
    if (!googleSync?.connected) {
      showToast('error', 'Connect Google Drive before syncing credentials.');
      return;
    }
    if (!googleCollection?.configured) {
      showToast('error', 'Set up Google sync collection before syncing credentials.');
      return;
    }
    setSyncingItemId(itemId);
    try {
      const result = await syncIpc.uploadCredential('google', { itemId });
      setGoogleSync(prev =>
        prev
          ? { ...prev, lastSync: result.syncedAt, lastError: undefined, lastErrorCode: undefined }
          : prev,
      );
      await loadGoogleSync();
      showToast('success', `Synced "${label}" to Google (${result.logicalId.slice(0, 8)}).`);
    } catch (error) {
      const msg = parseSyncInvokeError(error).message;
      showToast('error', `Failed to sync "${label}": ${msg}`);
    } finally {
      setSyncingItemId(null);
    }
  };

  const handleSyncHosts = async (includeAll = false) => {
    if (!hostsSyncEnabled) {
      showToast('error', 'Hosts sync is disabled. Enable hosts domain sync first.');
      return;
    }
    if (!googleSync?.connected) {
      showToast('error', 'Connect Google Drive before syncing hosts.');
      return;
    }
    if (!googleCollection?.configured) {
      showToast('error', 'Set up Google sync collection before syncing hosts.');
      return;
    }
    if (!googleCollection?.keyCached) {
      showToast('error', 'Unlock Google sync key before syncing hosts.');
      return;
    }

    setIsSyncingHosts(true);
    try {
      const changes = await syncIpc.hostsChanges('google', { includeAll });
      if (!includeAll && changes.count === 0) {
        showToast('info', 'No host changes to sync.');
        return;
      }
      const result = await syncIpc.hostsUpload('google', { includeAll });
      setGoogleSync(prev =>
        prev
          ? { ...prev, lastSync: result.syncedAt, lastError: undefined, lastErrorCode: undefined }
          : prev,
      );
      await onLoadConnections();
      await loadGoogleSync();
      const syncedCount = result.uploaded;
      const skippedCount = result.skipped;
      showToast(
        'success',
        `Synced ${syncedCount} host${syncedCount === 1 ? '' : 's'} to Google${skippedCount > 0 ? ` (${skippedCount} skipped)` : ''}.`,
      );
    } catch (error) {
      const msg = parseSyncInvokeError(error).message;
      showToast('error', `Host sync failed: ${msg}`);
    } finally {
      setIsSyncingHosts(false);
    }
  };

  const handleRestoreHosts = async () => {
    if (!hostsSyncEnabled) {
      showToast('error', 'Hosts sync is disabled. Enable hosts domain sync first.');
      return;
    }
    if (!googleSync?.connected) {
      showToast('error', 'Connect Google Drive before restoring hosts.');
      return;
    }
    if (!googleCollection?.configured) {
      showToast('error', 'Set up Google sync collection before restoring hosts.');
      return;
    }
    if (!googleCollection?.keyCached) {
      showToast('error', 'Unlock Google sync key before restoring hosts.');
      return;
    }

    const confirmed = await showConfirmDialog({
      title: 'Restore Hosts from Drive',
      message:
        'Restore synced host metadata from Google Drive into local hosts list. Existing matching hosts will be updated.',
      confirmText: 'Restore Hosts',
    });
    if (!confirmed) return;

    setIsRestoringHosts(true);
    try {
      const result = await syncIpc.hostsRestore('google');
      setGoogleSync(prev =>
        prev
          ? { ...prev, lastSync: result.syncedAt, lastError: undefined, lastErrorCode: undefined }
          : prev,
      );
      await onLoadConnections();
      await loadGoogleSync();
      const changed = result.restored + result.updated;
      showToast(
        changed > 0 ? 'success' : 'info',
        changed > 0
          ? `Restored ${changed} host${changed === 1 ? '' : 's'} from Google (${result.restored} new, ${result.updated} updated).`
          : 'No host changes restored from Google.',
      );
      if (result.failed > 0) {
        showToast('error', `${result.failed} host record(s) failed to parse/decrypt.`);
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
    if (!googleSync?.connected) {
      showToast('error', `Connect Google Drive before syncing ${domain}.`);
      return;
    }
    if (!googleCollection?.configured) {
      showToast('error', `Set up Google sync collection before syncing ${domain}.`);
      return;
    }
    if (!googleCollection?.keyCached) {
      showToast('error', `Unlock Google sync key before syncing ${domain}.`);
      return;
    }

    setLoading(true);
    try {
      const result =
        domain === 'tunnels'
          ? await syncIpc.tunnelsUpload('google')
          : domain === 'snippets'
            ? await syncIpc.snippetsUpload('google')
            : await syncIpc.settingsUpload('google');
      setGoogleSync(prev =>
        prev
          ? { ...prev, lastSync: result.syncedAt, lastError: undefined, lastErrorCode: undefined }
          : prev,
      );
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
  ) => {
    const policy = domainPolicies.find(p => p.domain === domain);
    if (policy && !policy.enabled) {
      showToast('error', `${domain} sync is disabled. Enable ${domain} domain sync first.`);
      return;
    }
    if (!googleSync?.connected) {
      showToast('error', `Connect Google Drive before restoring ${domain}.`);
      return;
    }
    if (!googleCollection?.configured) {
      showToast('error', `Set up Google sync collection before restoring ${domain}.`);
      return;
    }
    if (!googleCollection?.keyCached) {
      showToast('error', `Unlock Google sync key before restoring ${domain}.`);
      return;
    }
    setLoading(true);
    try {
      const result =
        domain === 'tunnels'
          ? await syncIpc.tunnelsRestore('google')
          : domain === 'snippets'
            ? await syncIpc.snippetsRestore('google')
            : await syncIpc.settingsRestore('google');
      setGoogleSync(prev =>
        prev
          ? { ...prev, lastSync: result.syncedAt, lastError: undefined, lastErrorCode: undefined }
          : prev,
      );
      await loadGoogleSync();
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

  const hostsPolicy = domainPolicies.find(policy => policy.domain === 'hosts');
  const hostsSyncEnabled = hostsPolicy ? hostsPolicy.enabled : true;

  const handleSetDomainPolicyEnabled = async (domain: SyncDomainPolicy['domain'], enabled: boolean) => {
    setIsUpdatingHostsPolicy(true);
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
      setIsUpdatingHostsPolicy(false);
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
      await onRefresh();
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
    isSettingUpCollection,
    isUnlockingCollection,
    isLockingCollection,
    isRegeneratingCollectionRecoveryKey,
    syncingItemId,
    isSyncingHosts,
    isRestoringHosts,
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
    handleSyncCredentialItem,
    handleSyncHosts,
    handleRestoreHosts,
    handleSyncTunnels,
    handleRestoreTunnels,
    handleSyncSnippets,
    handleRestoreSnippets,
    handleSyncSettings,
    handleRestoreSettings,
    domainPolicies,
    hostsSyncEnabled,
    isUpdatingHostsPolicy,
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
