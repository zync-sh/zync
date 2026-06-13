import { useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import { Cloud, Database, KeyRound, RefreshCw, Server, Shield, SlidersHorizontal } from 'lucide-react';
import { useAppStore } from '../../store/useAppStore';
import { useVaultStore } from '../../vault/useVaultStore';
import { SYNC_DOMAIN_ORDER, getSyncDomainDefinition } from '../../vault/syncDomains';
import { cn } from '../../lib/utils';
import { Button } from '../ui/Button';
import { VaultSyncCard } from '../settings/tabs/vault/VaultSyncCard';
import { SyncCollectionSetupModal } from '../settings/tabs/vault/SyncCollectionSetupModal';
import { SyncCollectionUnlockModal } from '../settings/tabs/vault/SyncCollectionUnlockModal';
import { RestoreConflictModal } from '../settings/tabs/vault/RestoreConflictModal';
import { RecoveryKeyModal } from '../vault/RecoveryKeyModal';
import { useVaultPanelActions } from '../settings/tabs/vault/hooks/useVaultPanelActions';

function formatCountLabel(count: number, singular: string, plural = `${singular}s`): string {
  return `${count} ${count === 1 ? singular : plural}`;
}

interface SyncSummaryCardProps {
  icon: ReactNode;
  label: string;
  value: string;
  description: string;
  tone?: 'default' | 'success' | 'warning';
}

function SyncSummaryCard({
  icon,
  label,
  value,
  description,
  tone = 'default',
}: SyncSummaryCardProps) {
  return (
    <div className="rounded-xl border border-[var(--color-app-border)]/60 bg-[var(--color-app-surface)]/25 p-4">
      <div className="flex items-start gap-3">
        <div
          className={cn(
            'flex h-9 w-9 shrink-0 items-center justify-center rounded-lg',
            tone === 'success' && 'bg-emerald-500/15 text-emerald-300',
            tone === 'warning' && 'bg-amber-500/15 text-amber-300',
            tone === 'default' && 'bg-[var(--color-app-surface)] text-[var(--color-app-muted)]',
          )}
        >
          {icon}
        </div>
        <div className="min-w-0">
          <p className="text-[11px] font-semibold uppercase tracking-[0.14em] text-[var(--color-app-muted)]">
            {label}
          </p>
          <p className="mt-1 text-sm font-semibold text-[var(--color-app-text)]">{value}</p>
          <p className="mt-1 text-xs leading-relaxed text-[var(--color-app-muted)]">{description}</p>
        </div>
      </div>
    </div>
  );
}

function formatUpdatedAt(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return 'Unknown';
  return new Date(value * 1000).toLocaleString();
}

export default function SyncBackupWorkspacePanel() {
  const { status, items, refresh, lock, refreshItems } = useVaultStore();
  const showToast = useAppStore(state => state.showToast);
  const showConfirmDialog = useAppStore(state => state.showConfirmDialog);
  const connections = useAppStore(state => state.connections);
  const tabs = useAppStore(state => state.tabs);
  const disconnectConnection = useAppStore(state => state.disconnect);
  const loadConnections = useAppStore(state => state.loadConnections);
  const openVaultTab = useAppStore(state => state.openVaultTab);

  const [isSyncCollectionSetupOpen, setIsSyncCollectionSetupOpen] = useState(false);
  const [isSyncCollectionUnlockOpen, setIsSyncCollectionUnlockOpen] = useState(false);

  const isVaultUnlocked = status?.status === 'unlocked';
  const hasVaultConfigured = status?.status === 'locked' || status?.status === 'unlocked';

  const loadAllTunnels = useAppStore(state => state.loadAllTunnels);
  const loadSnippets = useAppStore(state => state.loadSnippets);
  const loadSettings = useAppStore(state => state.loadSettings);

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
    onReloadTunnels: loadAllTunnels,
    onReloadSnippets: loadSnippets,
    onReloadSettings: loadSettings,
  });

  const {
    loadGoogleSync,
    loadGoogleCollection,
    loadDomainPolicies,
  } = panel;

  useEffect(() => {
    void refresh().catch(error => {
      console.warn('[Sync & Backup] Failed to refresh vault status:', error);
    });
    void loadGoogleSync();
    void loadGoogleCollection();
    void loadDomainPolicies();
  }, [refresh, loadGoogleSync, loadGoogleCollection, loadDomainPolicies]);

  const enabledDomainCount = useMemo(
    () =>
      SYNC_DOMAIN_ORDER.filter(domain => {
        const fallback = getSyncDomainDefinition(domain).defaultEnabled;
        return panel.domainPolicies.find(policy => policy.domain === domain)?.enabled ?? fallback;
      }).length,
    [panel.domainPolicies],
  );

  const providerState = panel.googleSync?.connected ? 'Connected' : 'Not connected';
  const syncKeyState = !panel.googleSync?.connected
    ? 'Connect provider first'
    : panel.googleCollection?.configured
      ? panel.googleCollection.keyCached
        ? 'Ready'
        : 'Locked'
      : 'Not set up';
  const canLoadRemoteHosts = Boolean(
    panel.googleSync?.connected
    && panel.googleCollection?.configured
    && panel.googleCollection?.keyCached
    && panel.hostsSyncEnabled,
  );
  const remoteHostCount = panel.remoteHostsInventory?.hosts.length ?? 0;
  const remoteOnlyHostCount =
    panel.remoteHostsInventory?.hosts.filter(host => !host.localExists).length ?? 0;

  useEffect(() => {
    if (!canLoadRemoteHosts) return;
    void panel.loadRemoteHostsInventory();
  }, [canLoadRemoteHosts, panel.loadRemoteHostsInventory]);

  return (
    <div className="h-full overflow-auto">
      <div className="mx-auto flex w-full max-w-6xl flex-col gap-5 p-5">
        <section className="rounded-2xl border border-[var(--color-app-border)]/60 bg-gradient-to-br from-[var(--color-app-surface)]/55 to-[var(--color-app-bg)]/40 p-5 shadow-sm">
          <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
            <div className="min-w-0">
              <div className="mb-3 inline-flex items-center gap-2 rounded-full border border-[var(--color-app-accent)]/25 bg-[var(--color-app-accent)]/10 px-3 py-1 text-[11px] font-semibold uppercase tracking-[0.16em] text-[var(--color-app-accent)]">
                <Cloud size={13} />
                Sync & Backup
              </div>
              <h1 className="text-2xl font-semibold tracking-tight text-[var(--color-app-text)]">
                Choose what follows you across devices
              </h1>
              <p className="mt-2 max-w-3xl text-sm leading-relaxed text-[var(--color-app-muted)]">
                Google sync is separate from Local Vault setup. Hosts, tunnels, snippets,
                settings, and vault credentials are encrypted locally before they are written
                to Google Drive.
              </p>
            </div>
            <div className="flex shrink-0 flex-wrap gap-2">
              <Button
                variant="secondary"
                size="sm"
                onClick={() => openVaultTab('local')}
                className="gap-1.5"
              >
                <KeyRound size={13} />
                Vault Credentials
              </Button>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => {
                  void Promise.all([
                    refresh(),
                    loadGoogleSync(),
                    loadGoogleCollection(),
                    loadDomainPolicies(),
                  ]).catch(error => {
                    console.warn('[Sync & Backup] Refresh failed:', error);
                  });
                }}
                className="gap-1.5"
              >
                <RefreshCw size={13} />
                Refresh
              </Button>
            </div>
          </div>
        </section>

        <section className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
          <SyncSummaryCard
            icon={<Cloud size={16} />}
            label="Provider"
            value={providerState}
            description={panel.googleSync?.email || 'Connect Google Drive to use provider sync.'}
            tone={panel.googleSync?.connected ? 'success' : 'default'}
          />
          <SyncSummaryCard
            icon={<Shield size={16} />}
            label="Google encryption"
            value={syncKeyState}
            description="Encrypts provider records before upload. Passphrases and recovery keys are never uploaded."
            tone={syncKeyState === 'Ready' ? 'success' : syncKeyState === 'Locked' ? 'warning' : 'default'}
          />
          <SyncSummaryCard
            icon={<Database size={16} />}
            label="Domains"
            value={formatCountLabel(enabledDomainCount, 'enabled domain')}
            description="Hosts, tunnels, snippets, settings, and vault credentials keep separate sync state."
          />
          <SyncSummaryCard
            icon={<SlidersHorizontal size={16} />}
            label="Mode"
            value="Manual"
            description="No data is uploaded or restored automatically until the auto-sync engine lands."
          />
        </section>

        <VaultSyncCard
          googleSync={panel.googleSync}
          googleCollection={panel.googleCollection}
          isSyncing={panel.isSyncing}
          isSyncingHosts={panel.isSyncingHosts}
          isRestoringHosts={panel.isRestoringHosts}
          isSyncingTunnels={panel.isSyncingTunnels}
          isRestoringTunnels={panel.isRestoringTunnels}
          isSyncingSnippets={panel.isSyncingSnippets}
          isRestoringSnippets={panel.isRestoringSnippets}
          isSyncingSettings={panel.isSyncingSettings}
          isRestoringSettings={panel.isRestoringSettings}
          hostsSyncEnabled={panel.hostsSyncEnabled}
          isUpdatingDomainPolicy={panel.isUpdatingDomainPolicy}
          domainPolicies={panel.domainPolicies}
          isSettingUpCollection={panel.isSettingUpCollection}
          isUnlockingCollection={panel.isUnlockingCollection}
          isLockingCollection={panel.isLockingCollection}
          isRegeneratingCollectionRecoveryKey={panel.isRegeneratingCollectionRecoveryKey}
          hasVaultConfigured={hasVaultConfigured}
          isVaultUnlocked={isVaultUnlocked}
          onConnect={panel.handleGoogleConnect}
          onDisconnect={panel.handleGoogleDisconnect}
          onSetupCollection={() => setIsSyncCollectionSetupOpen(true)}
          onUnlockCollection={() => setIsSyncCollectionUnlockOpen(true)}
          onLockCollection={panel.handleLockGoogleCollection}
          onRegenerateCollectionRecoveryKey={panel.handleRegenerateGoogleCollectionRecoveryKey}
          onUpload={panel.handleSyncUpload}
          onDownload={panel.handleSyncDownload}
          onSyncHosts={() => void panel.handleSyncHosts()}
          onRestoreHosts={() => void panel.handleRestoreHosts()}
          onSetHostsSyncEnabled={enabled => void panel.handleSetHostsSyncEnabled(enabled)}
          onSetDomainPolicyEnabled={(domain, enabled) =>
            void panel.handleSetDomainPolicyEnabled(domain, enabled)
          }
          onSyncTunnels={() => void panel.handleSyncTunnels()}
          onRestoreTunnels={() => void panel.handleRestoreTunnels()}
          onSyncSnippets={() => void panel.handleSyncSnippets()}
          onRestoreSnippets={() => void panel.handleRestoreSnippets()}
          onSyncSettings={() => void panel.handleSyncSettings()}
          onRestoreSettings={() => void panel.handleRestoreSettings()}
        />

        <section className="rounded-xl border border-[var(--color-app-border)]/60 bg-[var(--color-app-surface)]/25 p-4">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <Server size={15} className="text-[var(--color-app-muted)]" />
                <h2 className="text-sm font-semibold text-[var(--color-app-text)]">
                  Google Drive Hosts
                </h2>
              </div>
              <p className="mt-1 text-xs leading-relaxed text-[var(--color-app-muted)]">
                Hosts stored in the provider collection. Loading this list does not restore
                or overwrite local hosts.
              </p>
            </div>
            <Button
              variant="secondary"
              size="sm"
              onClick={() => void panel.loadRemoteHostsInventory()}
              disabled={!canLoadRemoteHosts || panel.isLoadingRemoteHosts}
              className="gap-1.5"
            >
              <RefreshCw
                size={13}
                className={panel.isLoadingRemoteHosts ? 'animate-spin' : undefined}
              />
              Refresh Hosts
            </Button>
          </div>

          <div className="mt-3 flex flex-wrap gap-2 text-[11px] text-[var(--color-app-muted)]">
            <span className="rounded-md border border-[var(--color-app-border)]/60 px-2 py-1">
              {remoteHostCount} remote
            </span>
            <span className="rounded-md border border-[var(--color-app-border)]/60 px-2 py-1">
              {remoteOnlyHostCount} remote only
            </span>
            {panel.remoteHostsInventory && (
              <span className="rounded-md border border-[var(--color-app-border)]/60 px-2 py-1">
                {panel.remoteHostsInventory.scanned} scanned
                {panel.remoteHostsInventory.failed > 0
                  ? `, ${panel.remoteHostsInventory.failed} failed`
                  : ''}
              </span>
            )}
          </div>

          {!canLoadRemoteHosts ? (
            <div className="mt-3 rounded-lg border border-[var(--color-app-border)]/50 bg-[var(--color-app-bg)]/40 px-3 py-3 text-xs text-[var(--color-app-muted)]">
              Connect Google Drive, enable Hosts, and unlock Google encryption to list
              provider hosts.
            </div>
          ) : panel.remoteHostsInventory && panel.remoteHostsInventory.hosts.length > 0 ? (
            <div className="mt-3 overflow-hidden rounded-lg border border-[var(--color-app-border)]/60">
              {panel.remoteHostsInventory.hosts.slice(0, 12).map(host => (
                <div
                  key={host.logicalId}
                  className="flex flex-col gap-2 border-b border-[var(--color-app-border)]/45 px-3 py-2 last:border-b-0 sm:flex-row sm:items-center sm:justify-between"
                >
                  <div className="min-w-0">
                    <div className="flex min-w-0 flex-wrap items-center gap-2">
                      <span className="truncate text-sm font-medium text-[var(--color-app-text)]">
                        {host.name}
                      </span>
                      <span className={cn(
                        'rounded-md border px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide',
                        host.localExists
                          ? 'border-emerald-500/30 bg-emerald-500/12 text-emerald-300'
                          : 'border-blue-500/30 bg-blue-500/12 text-blue-300',
                      )}>
                        {host.localExists ? 'Local' : 'Remote only'}
                      </span>
                      {host.hasAuthRef && (
                        <span className="rounded-md border border-[var(--color-app-border)]/60 px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-[var(--color-app-muted)]">
                          Vault ref
                        </span>
                      )}
                    </div>
                    <p className="mt-1 truncate text-xs text-[var(--color-app-muted)]">
                      {host.username}@{host.host}:{host.port}
                    </p>
                  </div>
                  <div className="shrink-0 text-left text-[11px] text-[var(--color-app-muted)] sm:text-right">
                    <p>rev {host.revision}</p>
                    <p>{formatUpdatedAt(host.updatedAt)}</p>
                  </div>
                </div>
              ))}
              {panel.remoteHostsInventory.hosts.length > 12 && (
                <div className="px-3 py-2 text-xs text-[var(--color-app-muted)]">
                  Showing 12 of {panel.remoteHostsInventory.hosts.length}. Search and selected restore will land in the next slice.
                </div>
              )}
            </div>
          ) : (
            <div className="mt-3 rounded-lg border border-[var(--color-app-border)]/50 bg-[var(--color-app-bg)]/40 px-3 py-3 text-xs text-[var(--color-app-muted)]">
              {panel.isLoadingRemoteHosts ? 'Loading Google hosts...' : 'No Google hosts found in this sync collection.'}
            </div>
          )}
        </section>
      </div>

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

      <SyncCollectionSetupModal
        isOpen={isSyncCollectionSetupOpen}
        isSubmitting={panel.isSettingUpCollection}
        hasLocalVaultConfigured={hasVaultConfigured}
        onClose={() => setIsSyncCollectionSetupOpen(false)}
        onSubmit={panel.handleSetupGoogleCollection}
      />

      <SyncCollectionUnlockModal
        isOpen={isSyncCollectionUnlockOpen}
        isSubmitting={panel.isUnlockingCollection}
        hasRecoveryKey={Boolean(panel.googleCollection?.hasRecoveryKey)}
        onClose={() => setIsSyncCollectionUnlockOpen(false)}
        onSubmit={panel.handleUnlockGoogleCollection}
      />

      <RestoreConflictModal
        isOpen={panel.isRestoreConflictModalOpen}
        isSubmitting={panel.isSyncing}
        preview={panel.restorePreview}
        conflicts={panel.restoreConflictItems}
        selectedLogicalIds={panel.selectedConflictLogicalIds}
        onClose={panel.closeRestoreConflictModal}
        onToggleLogicalId={panel.toggleConflictLogicalId}
        onSelectAll={panel.selectAllConflictLogicalIds}
        onClearAll={panel.clearConflictLogicalIds}
        onConfirmRestore={panel.confirmRestoreWithConflictSelection}
      />
    </div>
  );
}
