import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Shield, Lock, Unlock, Trash2, RefreshCw, ArrowRight, KeyRound, Download, Upload, Cloud, LogOut, Search } from 'lucide-react';
import { open, save } from '@tauri-apps/plugin-dialog';
import { useVaultStore } from '../../../vault/useVaultStore';
import { vaultIpc, type MigrationPreview } from '../../../vault/ipc';
import { notifySyncStatusChanged, syncIpc, type SyncProviderStatus } from '../../../vault/syncIpc';
import { VaultUnlockModal } from '../../vault/VaultUnlockModal';
import { RecoveryKeyModal } from '../../vault/RecoveryKeyModal';
import { Button } from '../../ui/Button';
import { useAppStore } from '../../../store/useAppStore';
import { cn } from '../../../lib/utils';
import { DEFAULT_VAULT_PROFILE_ID, type VaultProfileId } from '../../../vault/profileTypes';
import { resolveVaultFocusProfile } from './vaultFocus';
import { disconnectVaultBackedIpc } from '../../../features/connections/infrastructure/connectionIpc';
import type { Connection } from '../../../features/connections/domain/types';

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
  const tabs = useAppStore((state) => state.tabs);
  const disconnectConnection = useAppStore((state) => state.disconnect);
  const loadConnections = useAppStore((state) => state.loadConnections);

  const [isUnlockModalOpen, setIsUnlockModalOpen] = useState(false);
  const [migrationPreview, setMigrationPreview] = useState<MigrationPreview | null>(null);
  const [isMigrating, setIsMigrating] = useState(false);
  const [isDeduplicating, setIsDeduplicating] = useState(false);
  const [recoveryKey, setRecoveryKey] = useState('');
  const [isRecoveryModalOpen, setIsRecoveryModalOpen] = useState(false);
  const [hasRecoveryKey, setHasRecoveryKey] = useState(false);
  const [googleSync, setGoogleSync] = useState<SyncProviderStatus | null>(null);
  const [isSyncing, setIsSyncing] = useState(false);
  const [itemSearch, setItemSearch] = useState('');
  const localSectionRef = useRef<HTMLDivElement | null>(null);
  const googleSectionRef = useRef<HTMLDivElement | null>(null);

  const isMigrableCandidate = useCallback(
    (candidate: { migrationKind: string }) =>
      candidate.migrationKind === 'ssh-password' || candidate.migrationKind === 'ssh-private-key',
    []
  );

  const loadMigrationPreview = useCallback(async () => {
    try {
      const preview = await vaultIpc.migrationPreview();
      setMigrationPreview(preview);
    } catch (error) {
      console.warn('[Vault] Failed to load migration preview:', error);
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
      loadMigrationPreview();
      vaultIpc.hasRecoveryKey().then(setHasRecoveryKey).catch((error) => {
        console.warn('[Vault] Failed to load recovery-key status:', error);
      });
    }
  }, [loadMigrationPreview, refreshItems, status?.status]);

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

  const handleMigrate = async () => {
    const migrableCount = migrationPreview?.candidates.filter(isMigrableCandidate).length ?? 0;

    const confirmed = await showConfirmDialog({
      title: 'Secure Credentials in Vault',
      message: `Secure ${migrableCount} connection credential(s) in the encrypted vault. A backup will be saved first.`,
      confirmText: 'Secure Keys',
    });
    if (!confirmed) return;

    setIsMigrating(true);
    try {
      const result = await vaultIpc.migrateExistingSecrets();
      showToast('success', `Secured ${result.migrated} credential(s).${result.backupPath ? ' Backup saved.' : ''}`);
      await loadConnections();
      await refresh();
      await loadMigrationPreview();
    } catch (e: unknown) {
      const msg = e && typeof e === 'object' && 'message' in e
        ? String((e as { message: unknown }).message)
        : String(e);
      showToast('error', `Migration failed: ${msg}`);
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

  const migrableCandidates = useMemo(
    () => migrationPreview?.candidates.filter(isMigrableCandidate) ?? [],
    [isMigrableCandidate, migrationPreview?.candidates]
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
  const unlockedStatus = isUnlocked ? status : null;
  const googleStatusLabel = googleSync?.connected ? 'Connected' : 'Not connected';
  const googleStatusTone = googleSync?.connected
    ? 'bg-emerald-500/15 text-emerald-300 border-emerald-500/30'
    : 'bg-[var(--color-app-surface)] text-[var(--color-app-muted)] border-[var(--color-app-border)]/60';

  return (
    <div className="space-y-5 animate-in fade-in duration-300">
      {/* Status card */}
      <div ref={localSectionRef} className="rounded-xl border border-[var(--color-app-border)]/60 bg-[var(--color-app-surface)]/25 p-4">
        <div className="flex items-center justify-between gap-4">
          <div className="flex items-center gap-3">
            <div className={cn(
              'w-10 h-10 rounded-lg flex items-center justify-center shrink-0',
              isUnlocked
                ? 'bg-emerald-500/15 text-emerald-400'
                : status?.status === 'locked'
                  ? 'bg-amber-500/15 text-amber-400'
                  : 'bg-[var(--color-app-surface)] text-[var(--color-app-muted)]'
            )}>
              <Shield size={18} />
            </div>
            <div>
              <p className="text-sm font-semibold text-[var(--color-app-text)]">
                {isUnlocked ? 'Vault Unlocked'
                  : status?.status === 'locked' ? 'Vault Locked'
                    : 'Vault Not Set Up'}
              </p>
              <p className="text-xs text-[var(--color-app-muted)] mt-0.5">
                {isUnlocked
                  ? `${unlockedStatus?.itemCount ?? 0} item(s) · XChaCha20-Poly1305 encrypted`
                  : status?.status === 'locked'
                    ? 'Unlock to access and manage credentials'
                    : 'Create a vault to store SSH credentials securely'}
              </p>
            </div>
          </div>

          {isUnlocked ? (
            <Button variant="secondary" size="sm" onClick={handleLock} className="gap-1.5 shrink-0">
              <Lock size={13} />
              Lock
            </Button>
          ) : (
            <Button size="sm" onClick={() => setIsUnlockModalOpen(true)} className="gap-1.5 shrink-0">
              {status?.status === 'locked' ? <Unlock size={13} /> : <Shield size={13} />}
              {status?.status === 'locked' ? 'Unlock' : 'Set Up Vault'}
            </Button>
          )}
        </div>
      </div>

      {/* Migration banner */}
      {isUnlocked && migrableCandidates.length > 0 && (
        <div className="rounded-xl border border-amber-500/30 bg-amber-500/8 p-4">
          <div className="flex items-start justify-between gap-4">
            <div>
              <p className="text-sm font-semibold text-amber-300">Unsecured credentials detected</p>
              <p className="text-xs text-amber-300/70 mt-1 leading-relaxed">
                {migrableCandidates.length} connection{migrableCandidates.length > 1 ? 's have' : ' has'} credentials
                stored in plaintext. Secure them with vault encryption at rest.
              </p>
              {(migrationPreview?.alreadyMigrated ?? 0) > 0 || (migrationPreview?.skippedNoFile ?? 0) > 0 ? (
                <p className="text-[11px] text-amber-300/60 mt-1.5 leading-relaxed">
                  {migrationPreview?.alreadyMigrated ?? 0} already use vault auth
                  {(migrationPreview?.skippedNoFile ?? 0) > 0
                    ? ` · ${migrationPreview?.skippedNoFile ?? 0} skipped (key file missing)`
                    : ''}
                </p>
              ) : null}
            </div>
            <Button
              size="sm"
              onClick={handleMigrate}
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
      <div ref={googleSectionRef} className="space-y-2">

        <h4 className="text-xs font-semibold uppercase tracking-wider text-[var(--color-app-muted)] px-1">
          Cloud Sync
        </h4>
        <div className="rounded-xl border border-[var(--color-app-border)]/60 bg-[var(--color-app-surface)]/25 p-4 space-y-3">
          <div className="flex items-start justify-between gap-3">
            <div className="flex items-start gap-3 min-w-0">
              <div className={cn(
                'w-9 h-9 rounded-lg flex items-center justify-center shrink-0',
                googleSync?.connected
                  ? 'bg-blue-500/15 text-blue-400'
                  : 'bg-[var(--color-app-surface)] text-[var(--color-app-muted)]'
              )}>
                <Cloud size={16} />
              </div>
              <div>
                <p className="text-sm font-medium text-[var(--color-app-text)]">Google Drive</p>
                <div className="mt-1 flex items-center gap-2">
                  <span className={cn(
                    'inline-flex items-center rounded-md border px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide',
                    googleStatusTone
                  )}>
                    {googleStatusLabel}
                  </span>
                  {googleSync?.email && (
                    <span className="text-xs text-[var(--color-app-muted)] truncate">
                      {googleSync.email}
                    </span>
                  )}
                </div>
                {!googleSync?.connected && (
                  <p className="text-xs text-[var(--color-app-muted)] mt-1">
                    Syncs to your Drive appdata folder (encrypted).
                  </p>
                )}
              </div>
            </div>
            {googleSync?.connected ? (
              <Button
                variant="ghost"
                size="sm"
                onClick={handleGoogleDisconnect}
                className="gap-1.5 shrink-0 text-[var(--color-app-muted)] hover:text-red-400"
              >
                <LogOut size={13} />
                Disconnect
              </Button>
            ) : (
              <Button
                size="sm"
                onClick={handleGoogleConnect}
                disabled={isSyncing}
                className="gap-1.5 shrink-0"
              >
                {isSyncing ? <RefreshCw size={13} className="animate-spin" /> : <Cloud size={13} />}
                Connect
              </Button>
            )}
          </div>

          {googleSync?.connected && (
            <div className="rounded-lg border border-[var(--color-app-border)]/50 bg-[var(--color-app-bg)]/25 p-2.5">
              <div className="flex items-center gap-2">
              <Button
                variant="secondary"
                size="sm"
                onClick={handleSyncUpload}
                disabled={isSyncing || !hasVaultConfigured}
                className="gap-1.5"
              >
                {isSyncing ? <RefreshCw size={13} className="animate-spin" /> : <Upload size={13} />}
                Backup to Drive
              </Button>
              <Button
                variant="secondary"
                size="sm"
                onClick={handleSyncDownload}
                disabled={isSyncing || !hasVaultConfigured}
                className="gap-1.5"
              >
                <Download size={13} />
                Restore from Drive
              </Button>
              {googleSync.lastSync && (
                <span className="text-[11px] text-[var(--color-app-muted)] ml-auto whitespace-nowrap">
                  Last sync: {new Date(googleSync.lastSync * 1000).toLocaleString()}
                </span>
              )}
              </div>
              {!hasVaultConfigured && (
                <p className="mt-2 text-[11px] text-amber-400/85">
                  Create or unlock a vault first, then use Backup/Restore.
                </p>
              )}
            </div>
          )}

          <p className="text-[11px] text-[var(--color-app-muted)]/70 leading-relaxed">
            The vault is always encrypted before upload. Zync never uploads plaintext data.
          </p>
          <div className="inline-flex items-center gap-2 rounded-md border border-[var(--color-app-accent)]/25 bg-[var(--color-app-accent)]/8 px-2.5 py-1.5">
            <img
              src="/icon.png"
              alt="Zync"
              className="w-4 h-4 rounded-sm ring-1 ring-[var(--color-app-border)]/60"
            />
            <span className="text-[11px] font-medium text-[var(--color-app-text)]/90">
              Powered by Zync Vault encryption
            </span>
          </div>
          {!googleSync?.connected && (
            <p className="text-[11px] text-amber-400/75 leading-relaxed">
              Tip: on the Google sign-in screen, make sure to check the Drive checkbox; Google requires explicit consent for storage access.
            </p>
          )}
        </div>
      </div>

      {/* Items list */}
      {isUnlocked && (
        <div className="space-y-2">
          <div className="flex items-center justify-between px-1">
            <h4 className="text-xs font-semibold uppercase tracking-wider text-app-muted">
                Stored Items
                <span className="ml-2 normal-case font-normal text-app-muted/60">
                  {itemSearch
                    ? `${filteredItems.length} of ${items.length}`
                    : items.length}
                </span>
            </h4>
            {duplicateCount > 0 && (
              <button
                onClick={handleDeduplicateItems}
                disabled={isDeduplicating}
                className="flex items-center gap-1 text-[11px] text-amber-400/80 hover:text-amber-300 transition-colors disabled:opacity-50"
              >
                {isDeduplicating ? <RefreshCw size={11} className="animate-spin" /> : null}
                {duplicateCount} duplicate{duplicateCount > 1 ? 's' : ''} — clean up
              </button>
            )}
          </div>
          {items.length === 0 ? (
            <div className="rounded-xl border border-[var(--color-app-border)]/40 bg-[var(--color-app-surface)]/15 py-8 text-center">
              <p className="text-sm text-[var(--color-app-muted)]">No items in vault</p>
              <p className="text-xs text-[var(--color-app-muted)]/60 mt-1">
                Items are added when you migrate connection credentials.
              </p>
            </div>
          ) : (
            <>
              <div className="relative">
                <Search size={13} className="absolute left-3 top-1/2 -translate-y-1/2 text-app-muted/50 pointer-events-none" />
                <input
                  type="text"
                  placeholder="Search items…"
                  value={itemSearch}
                  onChange={e => setItemSearch(e.target.value)}
                  className="w-full rounded-lg border border-app-border/60 bg-app-surface/25 pl-8 pr-3 py-2 text-xs text-app-text placeholder:text-app-muted/50 focus:outline-none focus:ring-1 focus:ring-app-accent/50"
                />
              </div>
              <div className="rounded-xl border border-app-border/60 bg-app-surface/25 divide-y divide-app-border/30">
                {filteredItems.length === 0 ? (
                  <div className="py-6 text-center">
                    <p className="text-xs text-app-muted">No items match &quot;{itemSearch}&quot;</p>
                  </div>
                ) : (
                  filteredItems
                    .map((item) => (
                      <div key={item.id} className="flex items-center justify-between px-4 py-3 group">
                        <div className="min-w-0">
                          <p className="text-sm text-app-text font-medium truncate">{item.label}</p>
                          <p className="text-xs text-app-muted">
                            {item.kind} · {item.id.slice(0, 8)}
                          </p>
                        </div>
                        <button
                          onClick={() => handleDeleteItem(item.id, item.label)}
                          className="opacity-0 group-hover:opacity-100 focus:opacity-100 focus-visible:opacity-100 focus:outline-none focus:ring-2 focus:ring-red-400/40 p-1.5 rounded-md text-[var(--color-app-muted)] hover:text-red-400 hover:bg-red-400/10 transition-all"
                          title="Delete item"
                          aria-label={`Delete ${item.label}`}
                        >
                          <Trash2 size={14} />
                        </button>
                      </div>
                    ))
                )}
              </div>
            </>
          )}
        </div>
      )}

      <RecoveryKeyModal
        isOpen={isRecoveryModalOpen}
        recoveryKey={recoveryKey}
        onClose={() => {
          setRecoveryKey('');
          setIsRecoveryModalOpen(false);
        }}
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
    </div>
  );
}
