import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { RefreshCw, ArrowRight, KeyRound, Download, Upload, Cloud } from 'lucide-react';
import { useVaultStore } from '../../../vault/useVaultStore';
import { vaultIpc, type VaultItemDetail } from '../../../vault/ipc';
import { VaultUnlockModal } from '../../vault/VaultUnlockModal';
import { RecoveryKeyModal } from '../../vault/RecoveryKeyModal';
import { Button } from '../../ui/Button';
import { useAppStore } from '../../../store/useAppStore';
import { DEFAULT_VAULT_PROFILE_ID, type VaultProfileId } from '../../../vault/profileTypes';
import { resolveVaultFocusProfile } from './vaultFocus';
import { VaultStatusCard } from './vault/VaultStatusCard';
import { VaultItemsPanel } from './vault/VaultItemsPanel';
import { VaultCredentialDetailModal } from './vault/VaultCredentialDetailModal';
import { AddCredentialModal } from './vault/AddCredentialModal';
import { ManageAssignmentsModal } from './vault/ManageAssignmentsModal';
import { RotateCredentialModal } from './vault/RotateCredentialModal';
import { CredentialHistoryModal } from './vault/CredentialHistoryModal';
import { useAddCredentialModal } from './vault/hooks/useAddCredentialModal';
import { useRotateCredentialModal } from './vault/hooks/useRotateCredentialModal';
import { useAssignCredentialModal } from './vault/hooks/useAssignCredentialModal';
import { useHistoryModal } from './vault/hooks/useHistoryModal';
import { useVaultPanelActions } from './vault/hooks/useVaultPanelActions';

interface VaultTabProps {
  focusedProfileId?: VaultProfileId;
}

export function VaultTab({ focusedProfileId = DEFAULT_VAULT_PROFILE_ID }: VaultTabProps) {
  const { status, items, refresh, lock, refreshItems } = useVaultStore();
  const showToast = useAppStore(state => state.showToast);
  const showConfirmDialog = useAppStore(state => state.showConfirmDialog);
  const connections = useAppStore(state => state.connections);
  const folders = useAppStore(state => state.folders);
  const tabs = useAppStore(state => state.tabs);
  const disconnectConnection = useAppStore(state => state.disconnect);
  const loadConnections = useAppStore(state => state.loadConnections);
  const openSyncBackupTab = useAppStore(state => state.openSyncBackupTab);

  const [isUnlockModalOpen, setIsUnlockModalOpen] = useState(false);
  const [detailItemId, setDetailItemId] = useState<string | null>(null);
  const [detailItem, setDetailItem] = useState<VaultItemDetail | null>(null);
  const [isDetailLoading, setIsDetailLoading] = useState(false);
  const detailRequestRef = useRef<string | null>(null);

  const localSectionRef = useRef<HTMLDivElement | null>(null);
  const syncHandoffRef = useRef<HTMLDivElement | null>(null);

  const isUnlocked = status?.status === 'unlocked';
  const vaultId = status?.status === 'unlocked' ? status.vaultId : null;

  // ── Shared helper: prompt to disconnect affected sessions ─────────────────
  const promptDisconnectAffectedConnections = useCallback(
    async (affectedConnectionIds: string[], actionLabel: string) => {
      const activeIds = affectedConnectionIds.filter(id => {
        const c = connections.find(entry => entry.id === id);
        return c && (c.status === 'connected' || c.status === 'connecting');
      });
      if (activeIds.length === 0) return;

      const confirmed = await showConfirmDialog({
        title: 'Reconnect Affected Sessions?',
        message: `${actionLabel} updated credentials used by ${activeIds.length} active session${activeIds.length === 1 ? '' : 's'}. Disconnect them now so the next connect uses the latest secret?`,
        confirmText: 'Disconnect Now',
        variant: 'danger',
      });
      if (!confirmed) {
        showToast('info', 'Active sessions keep their current authentication until they reconnect.');
        return;
      }

      const results = await Promise.allSettled(activeIds.map(id => disconnectConnection(id)));
      const failed = results.filter(r => r.status === 'rejected').length;
      if (failed > 0) {
        showToast('error', `Disconnected ${activeIds.length - failed} session(s); ${failed} failed.`);
        return;
      }
      showToast(
        'info',
        `Disconnected ${activeIds.length} active session${activeIds.length === 1 ? '' : 's'} to apply updated credentials.`,
      );
    },
    [connections, disconnectConnection, showConfirmDialog, showToast],
  );

  // ── Focused hooks ─────────────────────────────────────────────────────────
  const addCredential = useAddCredentialModal({
    isUnlocked,
    showToast,
    onCreated: refreshItems,
  });

  const rotateCredential = useRotateCredentialModal({
    items,
    connections,
    showToast,
    onRotated: refreshItems,
    onPromptDisconnect: promptDisconnectAffectedConnections,
  });

  const assignCredential = useAssignCredentialModal({
    items,
    connections,
    folders,
    vaultId,
    showToast,
    onAssigned: loadConnections,
    onPromptDisconnect: promptDisconnectAffectedConnections,
  });

  const history = useHistoryModal({
    items,
    connections,
    showToast,
    showConfirmDialog,
    onRestored: refreshItems,
    onPromptDisconnect: promptDisconnectAffectedConnections,
  });

  const panel = useVaultPanelActions({
    connections,
    tabs,
    items,
    showToast,
    showConfirmDialog,
    onLocked: lock,
    onRefresh: refresh,
    onRefreshItems: refreshItems,
    onLoadConnections: loadConnections,
    onDisconnectConnection: disconnectConnection,
  });

  // Destructure stable callbacks used in effects so deps are explicit and accurate.
  const {
    loadSecurePreview,
    loadHasRecoveryKey,
    runBackfillIfNeeded,
    loadGoogleSync,
    loadGoogleCollection,
    loadDomainPolicies,
  } = panel;

  // ── Effects ───────────────────────────────────────────────────────────────
  useEffect(() => {
    void refresh().catch(error => {
      console.warn('[Vault] Failed to refresh vault status:', error);
    });
    void loadGoogleSync();
    void loadGoogleCollection();
    void loadDomainPolicies();
  }, [refresh, loadGoogleSync, loadGoogleCollection, loadDomainPolicies]);

  useEffect(() => {
    const targetProfile = resolveVaultFocusProfile(focusedProfileId);
    const target =
      targetProfile === 'google' ? syncHandoffRef.current : localSectionRef.current;
    if (!target) return;
    requestAnimationFrame(() => {
      target.scrollIntoView({ block: 'start', behavior: 'smooth' });
    });
  }, [focusedProfileId]);

  // Stable key — only changes when vault transitions to unlocked or vaultId changes.
  const unlockedKey = status?.status === 'unlocked' ? `unlocked:${status.vaultId}` : null;

  useEffect(() => {
    if (!unlockedKey) return;
    void refreshItems().catch(error => {
      console.warn('[Vault] Failed to refresh vault items:', error);
    });
    loadSecurePreview();
    loadHasRecoveryKey();
    const vid = (status as Extract<typeof status, { status: 'unlocked' }>)!.vaultId;
    void runBackfillIfNeeded(vid);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  // Why: `unlockedKey` is a stable string derived from `status?.status` and `status.vaultId`,
  // capturing all relevant state without re-running on every object reference change.
  // The type-assertion reading `status.vaultId` is safe because the effect only runs when
  // `unlockedKey` is non-null, guaranteeing status is 'unlocked'. `backfilledVaultIdsRef`
  // lives inside `useVaultPanelActions` and is a ref — intentionally excluded.
  }, [unlockedKey, refreshItems, loadSecurePreview, loadHasRecoveryKey, runBackfillIfNeeded]);

  // ── Derived values ────────────────────────────────────────────────────────
  const securableCandidates = useMemo(
    () =>
      panel.securePreview?.candidates.filter(
        c => c.secureKind === 'ssh-password' || c.secureKind === 'ssh-private-key',
      ) ?? [],
    [panel.securePreview],
  );

  const duplicateCount = useMemo(() => {
    const seen = new Set<string>();
    let count = 0;
    for (const item of items) {
      const fp = `${item.kind}:${item.secretFingerprint}`;
      if (seen.has(fp)) count++;
      else seen.add(fp);
    }
    return count;
  }, [items]);

  const assignedHostCounts = useMemo(() => {
    const counts: Record<string, number> = {};
    for (const connection of connections) {
      const logicalId = connection.authRef?.credentialId;
      if (!logicalId) continue;
      counts[logicalId] = (counts[logicalId] ?? 0) + 1;
    }
    return counts;
  }, [connections]);

  const detailAssignedConnections = useMemo(() => {
    if (!detailItem) return [];
    return connections.filter(connection => connection.authRef?.credentialId === detailItem.logicalId);
  }, [connections, detailItem]);

  const filteredItems = useMemo(() => {
    const q = panel.itemSearch.trim().toLowerCase();
    return q ? items.filter(item => item.label.toLowerCase().includes(q)) : items;
  }, [items, panel.itemSearch]);

  const openCredentialDetails = useCallback(async (itemId: string) => {
    const requestToken = `${itemId}:${Date.now()}:${Math.random().toString(36).slice(2)}`;
    detailRequestRef.current = requestToken;
    setDetailItemId(itemId);
    setIsDetailLoading(true);
    try {
      const full = await vaultIpc.itemGet(itemId);
      if (detailRequestRef.current === requestToken) {
        setDetailItemId(itemId);
        setDetailItem(full);
      }
    } catch (error) {
      console.warn('[Vault] Failed to load credential detail:', error);
      const message = error instanceof Error ? error.message : String(error);
      if (detailRequestRef.current === requestToken) {
        showToast('error', `Failed to load credential details: ${message}`);
        setDetailItemId(null);
        setDetailItem(null);
      }
    } finally {
      if (detailRequestRef.current === requestToken) {
        detailRequestRef.current = null;
        setIsDetailLoading(false);
      }
    }
  }, [showToast]);

  const closeCredentialDetails = useCallback(() => {
    detailRequestRef.current = null;
    setDetailItemId(null);
    setDetailItem(null);
    setIsDetailLoading(false);
  }, []);

  useEffect(() => {
    if (isUnlocked) return;
    panel.closeRecoveryModal();
    assignCredential.close();
    rotateCredential.close();
    history.close();
    addCredential.close();
    closeCredentialDetails();
    setIsUnlockModalOpen(false);
  }, [
    addCredential,
    assignCredential,
    closeCredentialDetails,
    history,
    isUnlocked,
    panel,
    rotateCredential,
  ]);
  const canSyncItemsToGoogle = Boolean(
    panel.googleSync?.connected
    && panel.googleCollection?.configured
    && panel.googleCollection?.keyCached,
  );
  const syncStatusLabel = !panel.googleSync?.connected
    ? 'Google Drive not connected'
    : panel.googleCollection?.configured
      ? panel.googleCollection.keyCached
        ? 'Google encryption ready'
        : 'Google encryption locked'
      : 'Google encryption not set up';

  // ── Render ────────────────────────────────────────────────────────────────
  return (
    <div className="space-y-5 animate-in fade-in duration-300">
      {/* Status card */}
      <div ref={localSectionRef}>
        <VaultStatusCard
          status={status}
          isUnlocked={isUnlocked}
          isRepairingRefs={panel.isRepairingRefs}
          onRepairRefs={panel.handleRepairRefs}
          onLock={panel.handleLock}
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
                {securableCandidates.length} connection
                {securableCandidates.length > 1 ? 's have' : ' has'} credentials stored in
                plaintext. Secure them with vault encryption at rest.
              </p>
              {((panel.securePreview?.alreadySecured ?? 0) > 0 ||
                (panel.securePreview?.skippedNoFile ?? 0) > 0) && (
                <p className="text-[11px] text-amber-300/60 mt-1.5 leading-relaxed">
                  {panel.securePreview?.alreadySecured ?? 0} already use vault auth
                  {(panel.securePreview?.skippedNoFile ?? 0) > 0
                    ? ` · ${panel.securePreview?.skippedNoFile ?? 0} skipped (key file missing)`
                    : ''}
                </p>
              )}
            </div>
            <Button
              size="sm"
              onClick={panel.handleSecureToVault}
              disabled={panel.isMigrating}
              className="shrink-0 gap-1.5"
            >
              {panel.isMigrating ? (
                <RefreshCw size={13} className="animate-spin" />
              ) : (
                <ArrowRight size={13} />
              )}
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
                  {panel.hasRecoveryKey
                    ? 'A recovery key is set'
                    : 'No recovery key — create one as a passphrase fallback'}
                </p>
              </div>
              <Button
                variant="secondary"
                size="sm"
                onClick={panel.handleGenerateRecoveryKey}
                className="gap-1.5 shrink-0"
              >
                <KeyRound size={13} />
                {panel.hasRecoveryKey ? 'Regenerate' : 'Generate'}
              </Button>
            </div>
            <div className="flex items-center justify-between px-4 py-3">
              <div>
                <p className="text-sm text-[var(--color-app-text)] font-medium">Export Vault</p>
                <p className="text-xs text-[var(--color-app-muted)] mt-0.5">
                  Save an encrypted backup of the vault file
                </p>
              </div>
              <Button
                variant="secondary"
                size="sm"
                onClick={panel.handleExport}
                className="gap-1.5 shrink-0"
              >
                <Download size={13} />
                Export
              </Button>
            </div>
            <div className="flex items-center justify-between px-4 py-3">
              <div>
                <p className="text-sm text-[var(--color-app-text)] font-medium">Import Vault</p>
                <p className="text-xs text-[var(--color-app-muted)] mt-0.5">
                  Replace the vault from a backup file
                </p>
              </div>
              <Button
                variant="secondary"
                size="sm"
                onClick={panel.handleImport}
                className="gap-1.5 shrink-0"
              >
                <Upload size={13} />
                Import
              </Button>
            </div>
          </div>
        </div>
      )}

      {/* Sync handoff */}
      <div ref={syncHandoffRef} className="space-y-2">
        <h4 className="text-xs font-semibold uppercase tracking-wider text-[var(--color-app-muted)] px-1">
          Sync & Backup
        </h4>
        <div className="rounded-xl border border-[var(--color-app-border)]/60 bg-[var(--color-app-surface)]/25 p-4">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <div className="flex min-w-0 items-start gap-3">
              <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-blue-500/15 text-blue-300">
                <Cloud size={16} />
              </div>
              <div className="min-w-0">
                <p className="text-sm font-semibold text-[var(--color-app-text)]">
                  Provider sync lives in Sync & Backup
                </p>
                <p className="mt-1 text-xs leading-relaxed text-[var(--color-app-muted)]">
                  {syncStatusLabel}. Use the dedicated sync workspace to connect providers,
                  set up Google encryption, and sync hosts, tunnels, snippets, settings,
                  or vault credential backups.
                </p>
                {canSyncItemsToGoogle && (
                  <p className="mt-1 text-[11px] text-emerald-300/80">
                    Individual credential backup is available from the credential list below.
                  </p>
                )}
              </div>
            </div>
            <Button
              variant="secondary"
              size="sm"
              onClick={openSyncBackupTab}
              className="gap-1.5 shrink-0"
            >
              <Cloud size={13} />
              Open Sync & Backup
            </Button>
          </div>
        </div>
      </div>

      {/* Items list */}
      {isUnlocked && (
        <VaultItemsPanel
          items={items}
          filteredItems={filteredItems}
          itemSearch={panel.itemSearch}
          duplicateCount={duplicateCount}
          isDeduplicating={panel.isDeduplicating}
          onItemSearchChange={panel.setItemSearch}
          onDeduplicate={panel.handleDeduplicateItems}
          onAddCredential={addCredential.open}
          onInspect={id => void openCredentialDetails(id)}
          onAssign={assignCredential.open}
          onRotate={id => void rotateCredential.open(id)}
          onHistory={id => void history.open(id)}
          onDelete={panel.handleDeleteItem}
          onSyncItem={panel.handleSyncCredentialItem}
          canSyncItems={canSyncItemsToGoogle}
          syncingItemId={panel.syncingItemId}
          assignedHostCounts={assignedHostCounts}
        />
      )}

      {/* ── Modals ── */}
      <RecoveryKeyModal
        isOpen={panel.isRecoveryModalOpen}
        recoveryKey={panel.recoveryKey}
        onClose={panel.closeRecoveryModal}
        title={panel.recoveryKeyTitle}
        subtitle={panel.recoveryKeySubtitle}
        fileTitle={panel.recoveryKeyFileTitle}
        fileDescription={panel.recoveryKeyFileDescription}
        downloadFileName={panel.recoveryKeyDownloadFileName}
      />

      <ManageAssignmentsModal
        isOpen={assignCredential.isOpen}
        itemLabel={assignCredential.item?.label ?? null}
        assignSearch={assignCredential.search}
        selectedAssignConnectionIds={assignCredential.selectedConnectionIds}
        filteredConnections={assignCredential.filteredConnections}
        isAssigning={assignCredential.isAssigning}
        onClose={assignCredential.close}
        onSearchChange={assignCredential.setSearch}
        onToggleConnection={assignCredential.toggleConnection}
        onSelectAll={assignCredential.selectAll}
        onClear={assignCredential.clearAll}
        onSubmit={assignCredential.submit}
      />

      <RotateCredentialModal
        isOpen={rotateCredential.isOpen}
        item={rotateCredential.item}
        label={rotateCredential.label}
        secret={rotateCredential.secret}
        passphrase={rotateCredential.passphrase}
        notes={rotateCredential.notes}
        isLoading={rotateCredential.isLoading}
        onClose={rotateCredential.close}
        onLabelChange={rotateCredential.setLabel}
        onSecretChange={rotateCredential.setSecret}
        onPassphraseChange={rotateCredential.setPassphrase}
        onNotesChange={rotateCredential.setNotes}
        onSubmit={rotateCredential.submit}
      />

      <CredentialHistoryModal
        isOpen={history.isOpen}
        item={history.item}
        history={history.revisions}
        isLoading={history.isLoading}
        isRestoring={history.isRestoring}
        onClose={history.close}
        onRestore={history.restore}
      />

      <VaultCredentialDetailModal
        isOpen={detailItemId !== null}
        item={detailItem}
        assignedConnections={detailAssignedConnections}
        isLoading={isDetailLoading}
        onClose={closeCredentialDetails}
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
        isOpen={addCredential.isOpen}
        kind={addCredential.kind}
        label={addCredential.label}
        secret={addCredential.secret}
        passphrase={addCredential.passphrase}
        notes={addCredential.notes}
        isCreating={addCredential.isCreating}
        onClose={addCredential.close}
        onKindChange={addCredential.setKind}
        onLabelChange={addCredential.setLabel}
        onSecretChange={addCredential.setSecret}
        onPassphraseChange={addCredential.setPassphrase}
        onNotesChange={addCredential.setNotes}
        onSubmit={addCredential.submit}
      />
    </div>
  );
}
