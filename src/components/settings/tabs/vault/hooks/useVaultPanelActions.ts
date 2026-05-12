import { useCallback, useRef, useState } from 'react';
import { open, save } from '@tauri-apps/plugin-dialog';
import { vaultIpc, type SecureToVaultPreview } from '../../../../../vault/ipc';
import { notifySyncStatusChanged, syncIpc, type SyncProviderStatus } from '../../../../../vault/syncIpc';
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

      await onLocked();
      showToast('info', 'Vault locked.');
      if (vaultBackedConnectionIds.size > 0) {
        showToast(
          'info',
          `Disconnected ${vaultBackedConnectionIds.size} vault-backed connection${vaultBackedConnectionIds.size > 1 ? 's' : ''} for security.`,
        );
      }
    } catch (e: unknown) {
      const msg = extractErrorMessage(e);
      showToast('error', `Failed to lock vault: ${msg}`);
    }
  };

  // ── Recovery key ──────────────────────────────────────────────────────────
  const [recoveryKey, setRecoveryKey] = useState('');
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
      setRecoveryKey(key);
      setHasRecoveryKey(true);
      setIsRecoveryModalOpen(true);
    } catch (e: unknown) {
      const msg = extractErrorMessage(e);
      showToast('error', `Failed to generate recovery key: ${msg}`);
    }
  };

  const closeRecoveryModal = () => {
    setRecoveryKey('');
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
  const [isSyncing, setIsSyncing] = useState(false);

  const loadGoogleSync = useCallback(async () => {
    try {
      const status = await syncIpc.status('google');
      setGoogleSync(status);
    } catch (error) {
      console.warn('[Vault] Failed to load Google sync status:', error);
    }
  }, []);

  const handleGoogleConnect = async () => {
    setIsSyncing(true);
    try {
      await syncIpc.connect('google');
      const status = await syncIpc.status('google');
      setGoogleSync(status);
      showToast(
        'success',
        `Connected to Google Drive${status.email ? ` as ${status.email}` : ''}.`,
      );
    } catch (e: unknown) {
      const msg = extractErrorMessage(e);
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
      const msg = extractErrorMessage(e);
      const hasCode = e && typeof e === 'object' && 'code' in e;
      const code = hasCode ? String((e as { code: unknown }).code) : '';
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
      showToast('success', 'Vault uploaded to Google Drive.');
    } catch (e: unknown) {
      const msg = extractErrorMessage(e);
      showToast('error', `Upload failed: ${msg}`);
    } finally {
      setIsSyncing(false);
    }
  };

  const handleSyncDownload = async () => {
    const confirmed = await showConfirmDialog({
      title: 'Download Vault from Drive',
      message:
        'This replaces your local vault with the Drive backup. A local backup is saved first. You will need to unlock the vault afterwards.',
      confirmText: 'Download',
      variant: 'danger',
    });
    if (!confirmed) return;
    setIsSyncing(true);
    try {
      await syncIpc.download('google');
      await onRefresh();
      showToast('success', 'Vault downloaded from Google Drive. Please unlock it.');
    } catch (e: unknown) {
      const msg = extractErrorMessage(e);
      showToast('error', `Download failed: ${msg}`);
    } finally {
      setIsSyncing(false);
    }
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
      backfilledVaultIdsRef.current.add(vaultId);
      try {
        const result = await vaultIpc.backfillConnectionRefs();
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
    recoveryKey,
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
    isSyncing,
    loadGoogleSync,
    handleGoogleConnect,
    handleGoogleDisconnect,
    handleSyncUpload,
    handleSyncDownload,
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
