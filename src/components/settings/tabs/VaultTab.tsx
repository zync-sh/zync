import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { RefreshCw, ArrowRight, KeyRound, Download, Upload } from 'lucide-react';
import { open, save } from '@tauri-apps/plugin-dialog';
import { useVaultStore } from '../../../vault/useVaultStore';
import { vaultIpc, type SecureToVaultPreview } from '../../../vault/ipc';
import { notifySyncStatusChanged, syncIpc, type SyncProviderStatus } from '../../../vault/syncIpc';
import { VaultUnlockModal } from '../../vault/VaultUnlockModal';
import { RecoveryKeyModal } from '../../vault/RecoveryKeyModal';
import { Button } from '../../ui/Button';
import { useAppStore } from '../../../store/useAppStore';
import { DEFAULT_VAULT_PROFILE_ID, type VaultProfileId } from '../../../vault/profileTypes';
import { resolveVaultFocusProfile } from './vaultFocus';
import { disconnectVaultBackedIpc } from '../../../features/connections/infrastructure/connectionIpc';
import type { Connection } from '../../../features/connections/domain/types';
import { syncCredentialAssignments } from '../../../features/connections/domain';
import { saveConnectionsIpc } from '../../../features/connections/infrastructure/connectionPersistence';
import { VaultStatusCard } from './vault/VaultStatusCard';
import { VaultSyncCard } from './vault/VaultSyncCard';
import { VaultItemsPanel } from './vault/VaultItemsPanel';
import { AddCredentialModal } from './vault/AddCredentialModal';
import { ManageAssignmentsModal } from './vault/ManageAssignmentsModal';
import { RotateCredentialModal } from './vault/RotateCredentialModal';

interface VaultTabProps {
  focusedProfileId?: VaultProfileId;
}

function connectionUsesVaultCredential(
  connections: Connection[],
  connectionId: string,
  visited = new Set<string>(),
): boolean {
  if (visited.has(connectionId)) return false;
  visited.add(connectionId);

  const connection = connections.find(item => item.id === connectionId);
  if (!connection) return false;
  if (connection.authRef) return true;
  return connection.jumpServerId
    ? connectionUsesVaultCredential(connections, connection.jumpServerId, visited)
    : false;
}

export function VaultTab({
  focusedProfileId = DEFAULT_VAULT_PROFILE_ID,
}: VaultTabProps) {
  const { status, items, refresh, lock, deleteItem, refreshItems } = useVaultStore();
  const showToast = useAppStore((state) => state.showToast);
  const showConfirmDialog = useAppStore((state) => state.showConfirmDialog);
  const connections = useAppStore((state) => state.connections);
  const folders = useAppStore((state) => state.folders);
  const tabs = useAppStore((state) => state.tabs);
  const disconnectConnection = useAppStore((state) => state.disconnect);
  const loadConnections = useAppStore((state) => state.loadConnections);

  const [isUnlockModalOpen, setIsUnlockModalOpen] = useState(false);
  const [securePreview, setSecurePreview] = useState<SecureToVaultPreview | null>(null);
  const [isMigrating, setIsMigrating] = useState(false);
  const [isDeduplicating, setIsDeduplicating] = useState(false);
  const [recoveryKey, setRecoveryKey] = useState('');
  const [isRecoveryModalOpen, setIsRecoveryModalOpen] = useState(false);
  const [hasRecoveryKey, setHasRecoveryKey] = useState(false);
  const [googleSync, setGoogleSync] = useState<SyncProviderStatus | null>(null);
  const [isSyncing, setIsSyncing] = useState(false);
  const [itemSearch, setItemSearch] = useState('');
  const [isAddCredentialOpen, setIsAddCredentialOpen] = useState(false);
  const [newCredentialKind, setNewCredentialKind] = useState<'ssh-private-key' | 'ssh-password'>('ssh-private-key');
  const [newCredentialLabel, setNewCredentialLabel] = useState('');
  const [newCredentialSecret, setNewCredentialSecret] = useState('');
  const [newCredentialPassphrase, setNewCredentialPassphrase] = useState('');
  const [newCredentialNotes, setNewCredentialNotes] = useState('');
  const [isCreatingCredential, setIsCreatingCredential] = useState(false);
  const [isRepairingRefs, setIsRepairingRefs] = useState(false);
  const [assignItemId, setAssignItemId] = useState<string | null>(null);
  const [assignSearch, setAssignSearch] = useState('');
  const [selectedAssignConnectionIds, setSelectedAssignConnectionIds] = useState<string[]>([]);
  const [isAssigningCredential, setIsAssigningCredential] = useState(false);
  const [rotateItemId, setRotateItemId] = useState<string | null>(null);
  const [rotateLabel, setRotateLabel] = useState('');
  const [rotateSecret, setRotateSecret] = useState('');
  const [rotatePassphrase, setRotatePassphrase] = useState('');
  const [rotateNotes, setRotateNotes] = useState('');
  const [isRotateLoading, setIsRotateLoading] = useState(false);
  const backfilledVaultIdsRef = useRef<Set<string>>(new Set());
  const localSectionRef = useRef<HTMLDivElement | null>(null);
  const googleSectionRef = useRef<HTMLDivElement | null>(null);

  const isSecureCandidate = useCallback(
    (candidate: { secureKind: string }) =>
      candidate.secureKind === 'ssh-password' || candidate.secureKind === 'ssh-private-key',
    []
  );

  const loadSecurePreview = useCallback(async () => {
    try {
      const preview = await vaultIpc.secureToVaultPreview();
      setSecurePreview(preview);
    } catch (error) {
      console.warn('[Vault] Failed to load secure-to-vault preview:', error);
    }
  }, []);

  useEffect(() => {
    void refresh().catch(error => {
      console.warn('[Vault] Failed to refresh vault status:', error);
    });
    syncIpc.status('google').then(setGoogleSync).catch(error => {
      console.warn('[Vault] Failed to load Google sync status:', error);
    });
  }, [refresh]);

  useEffect(() => {
    const targetProfile = resolveVaultFocusProfile(focusedProfileId);
    const target = targetProfile === 'google' ? googleSectionRef.current : localSectionRef.current;
    if (!target) return;

    requestAnimationFrame(() => {
      target.scrollIntoView({ block: 'start', behavior: 'smooth' });
    });
  }, [focusedProfileId]);

  useEffect(() => {
    if (status?.status === 'unlocked') {
      void refreshItems().catch(error => {
        console.warn('[Vault] Failed to refresh vault items:', error);
      });
      loadSecurePreview();
      vaultIpc.hasRecoveryKey().then(setHasRecoveryKey).catch((error) => {
        console.warn('[Vault] Failed to load recovery-key status:', error);
      });

      if (!backfilledVaultIdsRef.current.has(status.vaultId)) {
        backfilledVaultIdsRef.current.add(status.vaultId);
        vaultIpc.backfillConnectionRefs()
          .then(async (result) => {
            if (result.updated > 0) {
              await loadConnections();
              showToast(
                'info',
                `Backfilled stable credential IDs for ${result.updated} connection${result.updated > 1 ? 's' : ''}.`,
              );
            }
          })
          .catch((error) => {
            console.warn('[Vault] Failed to backfill credential ids:', error);
          });
      }
    }
  }, [loadConnections, loadSecurePreview, refreshItems, showToast, status]);

  const assignItem = useMemo(
    () => items.find(item => item.id === assignItemId) ?? null,
    [assignItemId, items]
  );

  const rotateItem = useMemo(
    () => items.find(item => item.id === rotateItemId) ?? null,
    [items, rotateItemId]
  );

  const handleLock = async () => {
    try {
      const backendVaultBackedIds = await disconnectVaultBackedIpc().catch((error) => {
        console.warn('[Vault] Backend vault-backed disconnect failed:', error);
        return [] as string[];
      });
      const activeTabConnectionIds = tabs
        .map(tab => tab.connectionId)
        .filter((id): id is string => Boolean(id) && id !== 'local');
      const vaultBackedConnectionIds = new Set(
        [
          ...backendVaultBackedIds,
          ...connections
            .filter(connection =>
              connection.id !== 'local'
              && (connection.status === 'connected' || connection.status === 'connecting')
              && connectionUsesVaultCredential(connections, connection.id)
            )
            .map(connection => connection.id),
          ...activeTabConnectionIds.filter(id => connectionUsesVaultCredential(connections, id)),
        ]
      );
      const vaultBackedIds = [...vaultBackedConnectionIds];
      const disconnectResults = await Promise.allSettled(vaultBackedIds.map((id) => disconnectConnection(id)));
      disconnectResults.forEach((result, index) => {
        if (result.status === 'rejected') {
          console.error('[Vault] Failed to disconnect vault-backed connection:', vaultBackedIds[index], result.reason);
        }
      });
      await lock();
      showToast('info', 'Vault locked.');
      if (vaultBackedConnectionIds.size > 0) {
        showToast(
          'info',
          `Disconnected ${vaultBackedConnectionIds.size} vault-backed connection${vaultBackedConnectionIds.size > 1 ? 's' : ''} for security.`
        );
      }
    } catch (e: unknown) {
      const msg = e && typeof e === 'object' && 'message' in e
        ? String((e as { message: unknown }).message)
        : String(e);
      showToast('error', `Failed to lock vault: ${msg}`);
    }
  };

  const handleSecureToVault = async () => {
    const securableCount = securePreview?.candidates.filter(isSecureCandidate).length ?? 0;

    const confirmed = await showConfirmDialog({
      title: 'Secure Credentials in Vault',
      message: `Secure ${securableCount} connection credential(s) in the encrypted vault. A backup will be saved first.`,
      confirmText: 'Secure Keys',
    });
    if (!confirmed) return;

    setIsMigrating(true);
    try {
      const result = await vaultIpc.secureToVault();
      showToast('success', `Secured ${result.secured} credential(s).${result.backupPath ? ' Backup saved.' : ''}`);
      await loadConnections();
      await refresh();
      await loadSecurePreview();
    } catch (e: unknown) {
      const msg = e && typeof e === 'object' && 'message' in e
        ? String((e as { message: unknown }).message)
        : String(e);
      showToast('error', `Secure to vault failed: ${msg}`);
    } finally {
      setIsMigrating(false);
    }
  };

  const handleDeleteItem = async (itemId: string, label: string) => {
    const confirmed = await showConfirmDialog({
      title: 'Delete Vault Item',
      message: `Delete "${label}"? Connections referencing this item will fail to connect.`,
      confirmText: 'Delete',
      variant: 'danger',
    });
    if (!confirmed) return;

    try {
      await deleteItem(itemId);
      showToast('success', `Deleted "${label}".`);
    } catch (e: unknown) {
      const msg = e && typeof e === 'object' && 'message' in e
        ? String((e as { message: unknown }).message)
        : String(e);
      showToast('error', `Failed to delete: ${msg}`);
    }
  };

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
      const msg = e && typeof e === 'object' && 'message' in e
        ? String((e as { message: unknown }).message) : String(e);
      showToast('error', `Failed to generate recovery key: ${msg}`);
    }
  };

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
      const msg = e && typeof e === 'object' && 'message' in e
        ? String((e as { message: unknown }).message) : String(e);
      showToast('error', `Export failed: ${msg}`);
    }
  };

  const handleImport = async () => {
    const confirmed = await showConfirmDialog({
      title: 'Import Vault',
      message: 'This replaces your current vault with the imported file. A backup is saved first. You will need to unlock the imported vault with its passphrase.',
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
      await refresh();
      showToast('success', 'Vault imported. Please unlock it with the vault passphrase.');
    } catch (e: unknown) {
      const msg = e && typeof e === 'object' && 'message' in e
        ? String((e as { message: unknown }).message) : String(e);
      showToast('error', `Import failed: ${msg}`);
    }
  };

  const handleGoogleConnect = async () => {
    setIsSyncing(true);
    try {
      await syncIpc.connect('google');
      const status = await syncIpc.status('google');
      setGoogleSync(status);
      showToast('success', `Connected to Google Drive${status.email ? ` as ${status.email}` : ''}.`);
    } catch (e: unknown) {
      const msg = e && typeof e === 'object' && 'message' in e
        ? String((e as { message: unknown }).message) : String(e);
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
      const msg = e && typeof e === 'object' && 'message' in e
        ? String((e as { message: unknown }).message)
        : String(e);
      if (msg.startsWith('Disconnected locally,')) {
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
      setGoogleSync((prev) => prev ? { ...prev, lastSync: ts } : prev);
      showToast('success', 'Vault uploaded to Google Drive.');
    } catch (e: unknown) {
      const msg = e && typeof e === 'object' && 'message' in e
        ? String((e as { message: unknown }).message) : String(e);
      showToast('error', `Upload failed: ${msg}`);
    } finally {
      setIsSyncing(false);
    }
  };

  const handleSyncDownload = async () => {
    const confirmed = await showConfirmDialog({
      title: 'Download Vault from Drive',
      message: 'This replaces your local vault with the Drive backup. A local backup is saved first. You will need to unlock the vault afterwards.',
      confirmText: 'Download',
      variant: 'danger',
    });
    if (!confirmed) return;
    setIsSyncing(true);
    try {
      await syncIpc.download('google');
      await refresh();
      showToast('success', 'Vault downloaded from Google Drive. Please unlock it.');
    } catch (e: unknown) {
      const msg = e && typeof e === 'object' && 'message' in e
        ? String((e as { message: unknown }).message) : String(e);
      showToast('error', `Download failed: ${msg}`);
    } finally {
      setIsSyncing(false);
    }
  };

  const promptDisconnectAffectedConnections = async (
    affectedConnectionIds: string[],
    actionLabel: string,
  ) => {
    const activeIds = affectedConnectionIds.filter((id) => {
      const connection = connections.find((entry) => entry.id === id);
      return connection && (connection.status === 'connected' || connection.status === 'connecting');
    });
    if (activeIds.length === 0) return;

    const confirmed = await showConfirmDialog({
      title: 'Reconnect Affected Sessions?',
      message: `${actionLabel} updated credentials used by ${activeIds.length} active session${activeIds.length === 1 ? '' : 's'}. Disconnect them now so the next connect uses the latest secret?`,
      confirmText: 'Disconnect Now',
      variant: 'danger',
    });
    if (!confirmed) {
      showToast(
        'info',
        `Active sessions keep their current authentication until they reconnect.`,
      );
      return;
    }

    const results = await Promise.allSettled(activeIds.map((id) => disconnectConnection(id)));
    const failed = results.filter((result) => result.status === 'rejected').length;
    if (failed > 0) {
      showToast('error', `Disconnected ${activeIds.length - failed} session(s); ${failed} failed.`);
      return;
    }
    showToast('info', `Disconnected ${activeIds.length} active session${activeIds.length === 1 ? '' : 's'} to apply updated credentials.`);
  };

  const resetAddCredentialForm = () => {
    setNewCredentialKind('ssh-private-key');
    setNewCredentialLabel('');
    setNewCredentialSecret('');
    setNewCredentialPassphrase('');
    setNewCredentialNotes('');
  };

  const closeAddCredentialModal = () => {
    if (isCreatingCredential) return;
    setIsAddCredentialOpen(false);
    resetAddCredentialForm();
  };

  const handleCreateCredential = async () => {
    if (status?.status !== 'unlocked') {
      showToast('error', 'Unlock the vault before adding credentials.');
      return;
    }

    const label = newCredentialLabel.trim();
    const secret = newCredentialKind === 'ssh-private-key'
      ? newCredentialSecret.trim()
      : newCredentialSecret;
    if (!label) {
      showToast('error', 'Credential label is required.');
      return;
    }
    if (!secret.trim()) {
      showToast('error', 'Credential secret is required.');
      return;
    }

    const secretToSave = newCredentialKind === 'ssh-private-key' && newCredentialPassphrase.trim()
      ? JSON.stringify({ key: secret, passphrase: newCredentialPassphrase })
      : secret;

    setIsCreatingCredential(true);
    try {
      const item = await vaultIpc.itemCreate(
        label,
        newCredentialKind,
        secretToSave,
        newCredentialNotes.trim() || undefined,
      );
      await refreshItems();
      setIsAddCredentialOpen(false);
      resetAddCredentialForm();
      showToast('success', `Added "${item.label}" to Vault. You can now assign it to hosts.`);
    } catch (e: unknown) {
      const msg = e && typeof e === 'object' && 'message' in e ? String((e as { message: unknown }).message) : String(e);
      showToast('error', `Failed to add credential: ${msg}`);
    } finally {
      setIsCreatingCredential(false);
    }
  };

  const openAssignModal = (itemId: string) => {
    const item = items.find(entry => entry.id === itemId);
    if (!item) return;
    setAssignItemId(item.id);
    setAssignSearch('');
    setSelectedAssignConnectionIds(
      connections
        .filter(connection =>
          connection.id !== 'local'
          && (
            connection.authRef?.credentialId === item.logicalId
            || connection.authRef?.itemId === item.id
          ))
        .map(connection => connection.id),
    );
  };

  const closeAssignModal = () => {
    if (isAssigningCredential) return;
    setAssignItemId(null);
    setAssignSearch('');
    setSelectedAssignConnectionIds([]);
  };

  const toggleAssignConnection = (connectionId: string) => {
    setSelectedAssignConnectionIds((current) =>
      current.includes(connectionId)
        ? current.filter(id => id !== connectionId)
        : [...current, connectionId]
    );
  };

  const handleSyncAssignments = async () => {
    if (!assignItem || status?.status !== 'unlocked') {
      showToast('error', 'Unlock the vault before assigning credentials.');
      return;
    }

    setIsAssigningCredential(true);
    try {
      const previouslyAssignedIds = connections
        .filter(connection =>
          connection.authRef?.credentialId === assignItem.logicalId
          || connection.authRef?.itemId === assignItem.id,
        )
        .map(connection => connection.id);
      const affectedConnectionIds = [...new Set([...previouslyAssignedIds, ...selectedAssignConnectionIds])];
      const nextConnections = syncCredentialAssignments(
        connections,
        selectedAssignConnectionIds,
        {
          vaultId: status.vaultId,
          credentialId: assignItem.logicalId,
          itemId: assignItem.id,
          itemKind: assignItem.kind as NonNullable<Connection['authRef']>['itemKind'],
          purpose: 'ssh-auth',
        },
      );
      await saveConnectionsIpc(nextConnections, folders);
      await loadConnections();
      closeAssignModal();
      showToast(
        'success',
        `Updated assignments for "${assignItem.label}" across ${affectedConnectionIds.length} host${affectedConnectionIds.length === 1 ? '' : 's'}.`,
      );
      await promptDisconnectAffectedConnections(affectedConnectionIds, `Updating assignments for "${assignItem.label}"`);
    } catch (e: unknown) {
      const msg = e && typeof e === 'object' && 'message' in e ? String((e as { message: unknown }).message) : String(e);
      showToast('error', `Failed to assign credential: ${msg}`);
    } finally {
      setIsAssigningCredential(false);
    }
  };

  const handleRepairRefs = async () => {
    if (status?.status !== 'unlocked') {
      showToast('error', 'Unlock the vault before repairing references.');
      return;
    }
    setIsRepairingRefs(true);
    try {
      const result = await vaultIpc.backfillConnectionRefs();
      await loadConnections();
      const parts: string[] = [];
      if (result.updated > 0) parts.push(`${result.updated} credential ID backfilled`);
      if (result.relinkedItemIds > 0) parts.push(`${result.relinkedItemIds} item reference relinked`);
      if (result.skippedMissingItems > 0) parts.push(`${result.skippedMissingItems} still missing`);
      showToast('success', parts.length > 0 ? `Vault repair complete: ${parts.join(' · ')}.` : 'Vault repair complete. No changes were needed.');
    } catch (e: unknown) {
      const msg = e && typeof e === 'object' && 'message' in e ? String((e as { message: unknown }).message) : String(e);
      showToast('error', `Vault repair failed: ${msg}`);
    } finally {
      setIsRepairingRefs(false);
    }
  };

  const openRotateModal = async (itemId: string) => {
    const item = items.find(entry => entry.id === itemId);
    if (!item) return;
    setRotateItemId(item.id);
    setRotateLabel(item.label);
    setRotateSecret('');
    setRotatePassphrase('');
    setRotateNotes('');
    try {
      const secret = await vaultIpc.itemGet(item.id);
      setRotateNotes(secret.notes || '');
    } catch (error) {
      console.warn('[Vault] Failed to load item for rotation:', error);
    }
  };

  const closeRotateModal = () => {
    if (isRotateLoading) return;
    setRotateItemId(null);
    setRotateLabel('');
    setRotateSecret('');
    setRotatePassphrase('');
    setRotateNotes('');
  };

  const handleRotateCredential = async () => {
    if (!rotateItem) return;
    const label = rotateLabel.trim();
    const baseSecret = rotateItem.kind === 'ssh-private-key' ? rotateSecret.trim() : rotateSecret;
    if (!label) {
      showToast('error', 'Credential label is required.');
      return;
    }
    if (!baseSecret.trim()) {
      showToast('error', 'New credential secret is required.');
      return;
    }

    const secretToSave = rotateItem.kind === 'ssh-private-key' && rotatePassphrase.trim()
      ? JSON.stringify({ key: baseSecret, passphrase: rotatePassphrase })
      : baseSecret;

    setIsRotateLoading(true);
    try {
      const affectedConnectionIds = connections
        .filter(connection => connection.authRef?.credentialId === rotateItem.logicalId)
        .map(connection => connection.id);
      await vaultIpc.itemUpdate(
        rotateItem.id,
        label,
        rotateItem.kind,
        secretToSave,
        rotateNotes.trim() || undefined,
      );
      await refreshItems();
      await loadSecurePreview();
      closeRotateModal();
      showToast('success', `Rotated "${label}". Hosts keep the same credential identity.`);
      await promptDisconnectAffectedConnections(affectedConnectionIds, `Rotating "${label}"`);
    } catch (e: unknown) {
      const msg = e && typeof e === 'object' && 'message' in e ? String((e as { message: unknown }).message) : String(e);
      showToast('error', `Failed to rotate credential: ${msg}`);
    } finally {
      setIsRotateLoading(false);
    }
  };

  const securableCandidates = useMemo(
    () => securePreview?.candidates.filter(isSecureCandidate) ?? [],
    [isSecureCandidate, securePreview?.candidates]
  );

  const duplicateCount = useMemo(() => {
    const seen = new Set<string>();
    let count = 0;
    for (const item of items) {
      const fingerprint = `${item.kind}:${item.secretFingerprint}`;
      if (seen.has(fingerprint)) count++;
      else seen.add(fingerprint);
    }
    return count;
  }, [items]);

  const filteredAssignableConnections = useMemo(() => {
    const search = assignSearch.trim().toLowerCase();
    const assignable = connections.filter(connection => connection.id !== 'local');
    if (!search) return assignable;
    return assignable.filter(connection =>
      connection.name.toLowerCase().includes(search)
      || connection.host.toLowerCase().includes(search)
      || connection.username.toLowerCase().includes(search)
    );
  }, [assignSearch, connections]);

  const filteredItems = useMemo(() => {
    const search = itemSearch.trim().toLowerCase();
    return search ? items.filter(item => item.label.toLowerCase().includes(search)) : items;
  }, [items, itemSearch]);

  const handleDeduplicateItems = async () => {
    const confirmed = await showConfirmDialog({
      title: 'Remove Duplicate Items',
      message: `Found ${duplicateCount} duplicate vault item(s). Items referenced by a connection are kept; unreferenced duplicates are deleted. This cannot be undone.`,
      confirmText: 'Remove Duplicates',
      variant: 'danger',
    });
    if (!confirmed) return;

    const referencedIds = new Set(connections.map(c => c.authRef?.itemId).filter(Boolean));
    const referencedCredentialIds = new Set(connections.map(c => c.authRef?.credentialId).filter(Boolean));
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
      if (group) {
        group.push(item);
      } else {
        groups.set(fingerprint, [item]);
      }
    }

    for (const group of groups.values()) {
      if (group.length <= 1) continue;
      const sorted = [...group].sort((a, b) => {
        const aReferenced = referencedIds.has(a.id) ? 1 : 0;
        const bReferenced = referencedIds.has(b.id) ? 1 : 0;
        if (aReferenced !== bReferenced) return bReferenced - aReferenced;
        return b.createdAt - a.createdAt;
      });
      const [, ...duplicates] = sorted;
      toDelete.push(...duplicates.map(item => item.id));
    }

    setIsDeduplicating(true);
    try {
      const deleteResults = await Promise.allSettled(toDelete.map(id => vaultIpc.itemDelete(id)));
      const failedDeletes = deleteResults.filter(result => result.status === 'rejected');
      if (failedDeletes.length > 0) {
        throw new Error(`${failedDeletes.length} duplicate item(s) could not be deleted.`);
      }
      await refreshItems();
      showToast('success', `Removed ${toDelete.length} duplicate item(s).`);
    } catch (e: unknown) {
      const msg = e && typeof e === 'object' && 'message' in e ? String((e as { message: unknown }).message) : String(e);
      showToast('error', `Deduplication failed: ${msg}`);
    } finally {
      setIsDeduplicating(false);
    }
  };

  const isUnlocked = status?.status === 'unlocked';
  const hasVaultConfigured = status?.status === 'locked' || status?.status === 'unlocked';

  return (
    <div className="space-y-5 animate-in fade-in duration-300">
      {/* Status card */}
      <div ref={localSectionRef}>
        <VaultStatusCard
          status={status}
          isUnlocked={isUnlocked}
          isRepairingRefs={isRepairingRefs}
          onRepairRefs={handleRepairRefs}
          onLock={handleLock}
          onOpenUnlock={() => setIsUnlockModalOpen(true)}
        />
      </div>

      {/* Secure-to-vault banner */}
      {isUnlocked && securableCandidates.length > 0 && (
        <div className="rounded-xl border border-amber-500/30 bg-amber-500/8 p-4">
          <div className="flex items-start justify-between gap-4">
            <div>
              <p className="text-sm font-semibold text-amber-300">Unsecured credentials detected</p>
              <p className="text-xs text-amber-300/70 mt-1 leading-relaxed">
                {securableCandidates.length} connection{securableCandidates.length > 1 ? 's have' : ' has'} credentials
                stored in plaintext. Secure them with vault encryption at rest.
              </p>
              {(securePreview?.alreadySecured ?? 0) > 0 || (securePreview?.skippedNoFile ?? 0) > 0 ? (
                <p className="text-[11px] text-amber-300/60 mt-1.5 leading-relaxed">
                  {securePreview?.alreadySecured ?? 0} already use vault auth
                  {(securePreview?.skippedNoFile ?? 0) > 0
                    ? ` · ${securePreview?.skippedNoFile ?? 0} skipped (key file missing)`
                    : ''}
                </p>
              ) : null}
            </div>
            <Button
              size="sm"
              onClick={handleSecureToVault}
              disabled={isMigrating}
              className="shrink-0 gap-1.5"
            >
              {isMigrating
                ? <RefreshCw size={13} className="animate-spin" />
                : <ArrowRight size={13} />}
              Secure Keys
            </Button>
          </div>
        </div>
      )}

      {/* Security actions */}
      {isUnlocked && (
        <div className="space-y-2">
          <h4 className="text-xs font-semibold uppercase tracking-wider text-[var(--color-app-muted)] px-1">
            Security
          </h4>
          <div className="rounded-xl border border-[var(--color-app-border)]/60 bg-[var(--color-app-surface)]/25 divide-y divide-[var(--color-app-border)]/30">
            <div className="flex items-center justify-between px-4 py-3">
              <div>
                <p className="text-sm text-[var(--color-app-text)] font-medium">Recovery Key</p>
                <p className="text-xs text-[var(--color-app-muted)] mt-0.5">
                  {hasRecoveryKey ? 'A recovery key is set' : 'No recovery key — create one as a passphrase fallback'}
                </p>
              </div>
              <Button variant="secondary" size="sm" onClick={handleGenerateRecoveryKey} className="gap-1.5 shrink-0">
                <KeyRound size={13} />
                {hasRecoveryKey ? 'Regenerate' : 'Generate'}
              </Button>
            </div>
            <div className="flex items-center justify-between px-4 py-3">
              <div>
                <p className="text-sm text-[var(--color-app-text)] font-medium">Export Vault</p>
                <p className="text-xs text-[var(--color-app-muted)] mt-0.5">Save an encrypted backup of the vault file</p>
              </div>
              <Button variant="secondary" size="sm" onClick={handleExport} className="gap-1.5 shrink-0">
                <Download size={13} />
                Export
              </Button>
            </div>
            <div className="flex items-center justify-between px-4 py-3">
              <div>
                <p className="text-sm text-[var(--color-app-text)] font-medium">Import Vault</p>
                <p className="text-xs text-[var(--color-app-muted)] mt-0.5">Replace the vault from a backup file</p>
              </div>
              <Button variant="secondary" size="sm" onClick={handleImport} className="gap-1.5 shrink-0">
                <Upload size={13} />
                Import
              </Button>
            </div>
          </div>
        </div>
      )}

      {/* Cloud Sync */}
      <div ref={googleSectionRef}>
        <VaultSyncCard
          googleSync={googleSync}
          isSyncing={isSyncing}
          hasVaultConfigured={hasVaultConfigured}
          onConnect={handleGoogleConnect}
          onDisconnect={handleGoogleDisconnect}
          onUpload={handleSyncUpload}
          onDownload={handleSyncDownload}
        />
      </div>

      {/* Items list */}
      {isUnlocked && (
        <VaultItemsPanel
          items={items}
          filteredItems={filteredItems}
          itemSearch={itemSearch}
          duplicateCount={duplicateCount}
          isDeduplicating={isDeduplicating}
          onItemSearchChange={setItemSearch}
          onDeduplicate={handleDeduplicateItems}
          onAddCredential={() => setIsAddCredentialOpen(true)}
          onAssign={openAssignModal}
          onRotate={(itemId) => void openRotateModal(itemId)}
          onDelete={handleDeleteItem}
        />
      )}

      <RecoveryKeyModal
        isOpen={isRecoveryModalOpen}
        recoveryKey={recoveryKey}
        onClose={() => {
          setRecoveryKey('');
          setIsRecoveryModalOpen(false);
        }}
      />

      <ManageAssignmentsModal
        isOpen={Boolean(assignItem)}
        itemLabel={assignItem?.label ?? null}
        assignSearch={assignSearch}
        selectedAssignConnectionIds={selectedAssignConnectionIds}
        filteredConnections={filteredAssignableConnections}
        isAssigning={isAssigningCredential}
        onClose={closeAssignModal}
        onSearchChange={setAssignSearch}
        onToggleConnection={toggleAssignConnection}
        onSelectAll={() => setSelectedAssignConnectionIds(filteredAssignableConnections.map(connection => connection.id))}
        onClear={() => setSelectedAssignConnectionIds([])}
        onSubmit={handleSyncAssignments}
      />

      <RotateCredentialModal
        isOpen={Boolean(rotateItem)}
        item={rotateItem}
        label={rotateLabel}
        secret={rotateSecret}
        passphrase={rotatePassphrase}
        notes={rotateNotes}
        isLoading={isRotateLoading}
        onClose={closeRotateModal}
        onLabelChange={setRotateLabel}
        onSecretChange={setRotateSecret}
        onPassphraseChange={setRotatePassphrase}
        onNotesChange={setRotateNotes}
        onSubmit={handleRotateCredential}
      />

      <VaultUnlockModal
        isOpen={isUnlockModalOpen}
        onClose={() => {
          setIsUnlockModalOpen(false);
          void refresh().catch(error => {
            console.warn('[Vault] Failed to refresh vault after unlock modal close:', error);
          });
        }}
      />

      <AddCredentialModal
        isOpen={isAddCredentialOpen}
        kind={newCredentialKind}
        label={newCredentialLabel}
        secret={newCredentialSecret}
        passphrase={newCredentialPassphrase}
        notes={newCredentialNotes}
        isCreating={isCreatingCredential}
        onClose={closeAddCredentialModal}
        onKindChange={setNewCredentialKind}
        onLabelChange={setNewCredentialLabel}
        onSecretChange={setNewCredentialSecret}
        onPassphraseChange={setNewCredentialPassphrase}
        onNotesChange={setNewCredentialNotes}
        onSubmit={handleCreateCredential}
      />
    </div>
  );
}
