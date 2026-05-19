import { Cloud, Download, LogOut, RefreshCw, Shield, Server } from 'lucide-react';
import type { SyncCollectionStatus, SyncDomain, SyncDomainPolicy, SyncDomainStatus, SyncProviderStatus } from '../../../../vault/syncIpc';
import { getSyncDomainDefinition } from '../../../../vault/syncDomains';
import { Button } from '../../../ui/Button';
import { cn } from '../../../../lib/utils';

interface VaultSyncCardProps {
  googleSync: SyncProviderStatus | null;
  googleCollection: SyncCollectionStatus | null;
  isSyncing: boolean;
  isSyncingHosts: boolean;
  isRestoringHosts: boolean;
  isSyncingTunnels: boolean;
  isRestoringTunnels: boolean;
  isSyncingSnippets: boolean;
  isRestoringSnippets: boolean;
  isSyncingSettings: boolean;
  isRestoringSettings: boolean;
  hostsSyncEnabled: boolean;
  isUpdatingHostsPolicy: boolean;
  domainPolicies: SyncDomainPolicy[];
  isSettingUpCollection: boolean;
  isUnlockingCollection: boolean;
  isLockingCollection: boolean;
  isRegeneratingCollectionRecoveryKey: boolean;
  hasVaultConfigured: boolean;
  isVaultUnlocked: boolean;
  onConnect: () => void;
  onDisconnect: () => void;
  onSetupCollection: () => void;
  onUnlockCollection: () => void;
  onLockCollection: () => void;
  onRegenerateCollectionRecoveryKey: () => void;
  onUpload: () => void;
  onDownload: () => void;
  onSyncHosts: () => void;
  onRestoreHosts: () => void;
  onSetHostsSyncEnabled: (enabled: boolean) => void;
  onSetDomainPolicyEnabled: (domain: SyncDomainPolicy['domain'], enabled: boolean) => void;
  onSyncTunnels: () => void;
  onRestoreTunnels: () => void;
  onSyncSnippets: () => void;
  onRestoreSnippets: () => void;
  onSyncSettings: () => void;
  onRestoreSettings: () => void;
}

function formatSyncTime(value?: number): string {
  if (!value) {
    return 'Never synced';
  }
  return `Last sync ${new Date(value * 1000).toLocaleString()}`;
}

function domainStatusCopy(status?: SyncDomainStatus): string {
  if (status?.lastError) {
    return `Error${status.lastErrorCode ? ` (${status.lastErrorCode})` : ''}: ${status.lastError}`;
  }
  return formatSyncTime(status?.lastSync);
}

interface CollectionManagementSectionProps {
  googleCollection: SyncCollectionStatus | null;
  isSettingUpCollection: boolean;
  isUnlockingCollection: boolean;
  isLockingCollection: boolean;
  isRegeneratingCollectionRecoveryKey: boolean;
  isSyncing: boolean;
  onSetupCollection: () => void;
  onUnlockCollection: () => void;
  onLockCollection: () => void;
  onRegenerateCollectionRecoveryKey: () => void;
}

function CollectionManagementSection({
  googleCollection,
  isSettingUpCollection,
  isUnlockingCollection,
  isLockingCollection,
  isRegeneratingCollectionRecoveryKey,
  isSyncing,
  onSetupCollection,
  onUnlockCollection,
  onLockCollection,
  onRegenerateCollectionRecoveryKey,
}: CollectionManagementSectionProps) {
  return (
    <>
      {!googleCollection?.configured && (
        <div className="mb-2 flex items-center gap-2">
          <span className="text-[11px] text-amber-300/90">
            Set up Google sync collection before syncing domains.
          </span>
          <Button
            variant="secondary"
            size="sm"
            onClick={onSetupCollection}
            disabled={isSettingUpCollection}
            className="gap-1.5"
          >
            {isSettingUpCollection ? (
              <RefreshCw size={13} className="animate-spin" />
            ) : (
              <Cloud size={13} />
            )}
            Set up Sync Key
          </Button>
        </div>
      )}
      {googleCollection?.configured && !googleCollection.keyCached && (
        <div className="mb-2 flex items-center gap-2">
          <Button
            variant="secondary"
            size="sm"
            onClick={onUnlockCollection}
            disabled={
              isUnlockingCollection
              || isSyncing
              || isSettingUpCollection
              || isLockingCollection
              || isRegeneratingCollectionRecoveryKey
            }
            className="gap-1.5"
          >
            {isUnlockingCollection ? (
              <RefreshCw size={13} className="animate-spin" />
            ) : (
              <Cloud size={13} />
            )}
            Unlock Sync Key
          </Button>
        </div>
      )}
      {googleCollection?.configured && googleCollection.keyCached && (
        <div className="mb-2 flex items-center gap-2">
          <span className="text-[11px] text-[var(--color-app-muted)]">
            Sync key cache is unlocked on this device.
          </span>
          <Button
            variant="ghost"
            size="sm"
            onClick={onLockCollection}
            disabled={
              isLockingCollection
              || isUnlockingCollection
              || isRegeneratingCollectionRecoveryKey
              || isSyncing
              || isSettingUpCollection
            }
            className="gap-1.5"
          >
            {isLockingCollection ? (
              <RefreshCw size={13} className="animate-spin" />
            ) : (
              <Shield size={13} />
            )}
            Lock Sync Key
          </Button>
        </div>
      )}
      {googleCollection?.configured && (
        <div className="mb-2 flex items-center gap-2">
          <span className="text-[11px] text-[var(--color-app-muted)]">
            Rotate Google Sync Recovery Key.
          </span>
          <Button
            variant="ghost"
            size="sm"
            onClick={onRegenerateCollectionRecoveryKey}
            disabled={
              isRegeneratingCollectionRecoveryKey
              || isSyncing
              || isSettingUpCollection
              || isUnlockingCollection
              || isLockingCollection
              || !googleCollection?.keyCached
            }
            className="gap-1.5"
          >
            {isRegeneratingCollectionRecoveryKey ? (
              <RefreshCw size={13} className="animate-spin" />
            ) : (
              <Shield size={13} />
            )}
            Regenerate Recovery Key
          </Button>
        </div>
      )}
    </>
  );
}

export function VaultSyncCard({
  googleSync,
  googleCollection,
  isSyncing,
  isSyncingHosts,
  isRestoringHosts,
  isSyncingTunnels,
  isRestoringTunnels,
  isSyncingSnippets,
  isRestoringSnippets,
  isSyncingSettings,
  isRestoringSettings,
  hostsSyncEnabled,
  isUpdatingHostsPolicy,
  domainPolicies,
  isSettingUpCollection,
  isUnlockingCollection,
  isLockingCollection,
  isRegeneratingCollectionRecoveryKey,
  hasVaultConfigured,
  isVaultUnlocked,
  onConnect,
  onDisconnect,
  onSetupCollection,
  onUnlockCollection,
  onLockCollection,
  onRegenerateCollectionRecoveryKey,
  onUpload,
  onDownload,
  onSyncHosts,
  onRestoreHosts,
  onSetHostsSyncEnabled,
  onSetDomainPolicyEnabled,
  onSyncTunnels,
  onRestoreTunnels,
  onSyncSnippets,
  onRestoreSnippets,
  onSyncSettings,
  onRestoreSettings,
}: VaultSyncCardProps) {
  const googleStatusLabel = googleSync?.connected ? 'Connected' : 'Not connected';
  const googleStatusTone = googleSync?.connected
    ? 'bg-emerald-500/15 text-emerald-300 border-emerald-500/30'
    : 'bg-[var(--color-app-surface)] text-[var(--color-app-muted)] border-[var(--color-app-border)]/60';
  const isCollectionActionBlocked =
    isSyncing
    || isSettingUpCollection
    || isUnlockingCollection
    || isLockingCollection
    || isRegeneratingCollectionRecoveryKey;
  const isProviderDomainActionDisabled =
    isCollectionActionBlocked
    || !googleCollection?.configured
    || !googleCollection?.keyCached;
  const isBackupDisabled =
    isProviderDomainActionDisabled
    || !hasVaultConfigured;
  const isRestoreDisabled =
    isProviderDomainActionDisabled
    || !isVaultUnlocked;
  const domainStatusByKey = new Map((googleSync?.domainStatuses ?? []).map(status => [status.domain, status]));
  const domainPolicyEnabled = (domain: SyncDomain, fallback = getSyncDomainDefinition(domain).defaultEnabled) => (
    domainPolicies.find(policy => policy.domain === domain)?.enabled ?? fallback
  );
  const domainRows = [
    {
      key: 'vault',
      label: getSyncDomainDefinition('vault').label,
      description: getSyncDomainDefinition('vault').description,
      enabled: domainPolicyEnabled('vault'),
      syncing: isSyncing,
      restoring: isSyncing,
      onSync: onUpload,
      onRestore: onDownload,
      syncLabel: 'Backup',
      restoreLabel: 'Restore',
      syncDisabled: isBackupDisabled,
      restoreDisabled: isRestoreDisabled,
      onToggle: () => onSetDomainPolicyEnabled('vault', !domainPolicyEnabled('vault')),
    },
    {
      key: 'hosts',
      label: getSyncDomainDefinition('hosts').label,
      description: getSyncDomainDefinition('hosts').description,
      enabled: hostsSyncEnabled,
      syncing: isSyncingHosts,
      restoring: isRestoringHosts,
      onSync: onSyncHosts,
      onRestore: onRestoreHosts,
      syncLabel: 'Sync',
      restoreLabel: 'Restore',
      syncDisabled: isProviderDomainActionDisabled || !hostsSyncEnabled || isSyncingHosts,
      restoreDisabled: isProviderDomainActionDisabled || !hostsSyncEnabled || isRestoringHosts,
      onToggle: () => onSetHostsSyncEnabled(!hostsSyncEnabled),
    },
    {
      key: 'tunnels',
      label: getSyncDomainDefinition('tunnels').label,
      description: getSyncDomainDefinition('tunnels').description,
      enabled: domainPolicyEnabled('tunnels', false),
      syncing: isSyncingTunnels,
      restoring: isRestoringTunnels,
      onSync: onSyncTunnels,
      onRestore: onRestoreTunnels,
      syncLabel: 'Sync',
      restoreLabel: 'Restore',
      syncDisabled: isProviderDomainActionDisabled || !domainPolicyEnabled('tunnels', false) || isSyncingTunnels,
      restoreDisabled: isProviderDomainActionDisabled || !domainPolicyEnabled('tunnels', false) || isRestoringTunnels,
      onToggle: () => onSetDomainPolicyEnabled('tunnels', !domainPolicyEnabled('tunnels', false)),
    },
    {
      key: 'snippets',
      label: getSyncDomainDefinition('snippets').label,
      description: getSyncDomainDefinition('snippets').description,
      enabled: domainPolicyEnabled('snippets', false),
      syncing: isSyncingSnippets,
      restoring: isRestoringSnippets,
      onSync: onSyncSnippets,
      onRestore: onRestoreSnippets,
      syncLabel: 'Sync',
      restoreLabel: 'Restore',
      syncDisabled: isProviderDomainActionDisabled || !domainPolicyEnabled('snippets', false) || isSyncingSnippets,
      restoreDisabled: isProviderDomainActionDisabled || !domainPolicyEnabled('snippets', false) || isRestoringSnippets,
      onToggle: () => onSetDomainPolicyEnabled('snippets', !domainPolicyEnabled('snippets', false)),
    },
    {
      key: 'settings',
      label: getSyncDomainDefinition('settings').label,
      description: getSyncDomainDefinition('settings').description,
      enabled: domainPolicyEnabled('settings', false),
      syncing: isSyncingSettings,
      restoring: isRestoringSettings,
      onSync: onSyncSettings,
      onRestore: onRestoreSettings,
      syncLabel: 'Sync',
      restoreLabel: 'Restore',
      syncDisabled: isProviderDomainActionDisabled || !domainPolicyEnabled('settings', false) || isSyncingSettings,
      restoreDisabled: isProviderDomainActionDisabled || !domainPolicyEnabled('settings', false) || isRestoringSettings,
      onToggle: () => onSetDomainPolicyEnabled('settings', !domainPolicyEnabled('settings', false)),
    },
  ] as const;

  return (
    <div className="space-y-2">
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
              {googleSync?.connected && (
                <p className="text-xs text-[var(--color-app-muted)] mt-1">
                  Sync collection: {googleCollection?.configured ? 'configured' : 'not set up'}
                </p>
              )}
            </div>
          </div>
          {googleSync?.connected ? (
            <Button
              variant="ghost"
              size="sm"
              onClick={onDisconnect}
              className="gap-1.5 shrink-0 text-[var(--color-app-muted)] hover:text-red-400"
            >
              <LogOut size={13} />
              Disconnect
            </Button>
          ) : (
            <Button
              size="sm"
              onClick={onConnect}
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
            <CollectionManagementSection
              googleCollection={googleCollection}
              isSettingUpCollection={isSettingUpCollection}
              isUnlockingCollection={isUnlockingCollection}
              isLockingCollection={isLockingCollection}
              isRegeneratingCollectionRecoveryKey={isRegeneratingCollectionRecoveryKey}
              isSyncing={isSyncing}
              onSetupCollection={onSetupCollection}
              onUnlockCollection={onUnlockCollection}
              onLockCollection={onLockCollection}
              onRegenerateCollectionRecoveryKey={onRegenerateCollectionRecoveryKey}
            />
            <div className="mt-2.5 rounded-lg border border-[var(--color-app-border)]/50 bg-[var(--color-app-surface)]/20 p-3 space-y-2.5">
              <div className="flex items-center justify-between gap-3">
                <div>
                  <p className="text-[10px] font-semibold text-[var(--color-app-muted)] uppercase tracking-[0.14em]">
                    Sync Domains
                  </p>
                  <p className="mt-0.5 text-[11px] text-[var(--color-app-muted)]/75">
                    Choose what Google Drive sync manages. Each domain keeps its own sync state.
                  </p>
                </div>
                {googleSync?.lastSync != null && (
                  <span className="text-[11px] text-[var(--color-app-muted)] whitespace-nowrap">
                    Overall {formatSyncTime(googleSync.lastSync).toLowerCase()}
                  </span>
                )}
              </div>
              <div className="divide-y divide-[var(--color-app-border)]/35 overflow-hidden rounded-lg border border-[var(--color-app-border)]/40 bg-[var(--color-app-bg)]/20">
                {domainRows.map(row => {
                  const status = domainStatusByKey.get(row.key);
                  const hasError = Boolean(status?.lastError);
                  return (
                    <div
                      key={row.key}
                      className="grid grid-cols-[minmax(180px,1fr)_minmax(160px,0.75fr)_auto] items-center gap-3 px-3 py-2.5"
                    >
                      <div className="min-w-0">
                        <div className="flex items-center gap-2">
                          <span className="text-xs font-semibold text-[var(--color-app-text)]">{row.label}</span>
                          <span
                            className={cn(
                              'inline-flex items-center rounded border px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wide',
                              row.enabled
                                ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-300'
                                : 'border-[var(--color-app-border)]/60 bg-[var(--color-app-surface)] text-[var(--color-app-muted)]'
                            )}
                          >
                            {row.enabled ? 'On' : 'Off'}
                          </span>
                        </div>
                        <p className="mt-0.5 truncate text-[11px] text-[var(--color-app-muted)]">{row.description}</p>
                      </div>
                      <p className={cn(
                        'min-w-0 truncate text-[11px]',
                        hasError ? 'text-red-300/85' : 'text-[var(--color-app-muted)]/80'
                      )}>
                        {domainStatusCopy(status)}
                      </p>
                      <div className="flex items-center justify-end gap-1.5">
                        <Button
                          variant={row.enabled ? 'secondary' : 'ghost'}
                          size="sm"
                          onClick={row.onToggle}
                          disabled={isUpdatingHostsPolicy || isCollectionActionBlocked}
                          className="h-7 min-w-[68px] px-2 gap-1.5"
                        >
                          {isUpdatingHostsPolicy ? <RefreshCw size={13} className="animate-spin" /> : <Shield size={13} />}
                          {row.enabled ? 'Enabled' : 'Disabled'}
                        </Button>
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={row.onSync}
                          disabled={row.syncDisabled ?? (!row.enabled || row.syncing || isCollectionActionBlocked)}
                          className="h-7 min-w-[78px] px-2 gap-1.5"
                        >
                          {row.syncing ? <RefreshCw size={13} className="animate-spin" /> : <Server size={13} />}
                          {row.syncLabel}
                        </Button>
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={row.onRestore}
                          disabled={row.restoreDisabled ?? (!row.enabled || row.restoring || isCollectionActionBlocked)}
                          className="h-7 min-w-[78px] px-2 gap-1.5"
                        >
                          {row.restoring ? <RefreshCw size={13} className="animate-spin" /> : <Download size={13} />}
                          {row.restoreLabel}
                        </Button>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
            {!hasVaultConfigured && (
              <p className="mt-2 text-[11px] text-amber-400/85 leading-relaxed">
                Local vault is not set up. App-data domains can sync with a custom Google sync passphrase; vault credential backup/restore stays disabled until you create the local vault.
              </p>
            )}
          </div>
        )}

        {googleSync?.lastError && (
          <p className="text-[11px] text-red-300/85 leading-relaxed">
            Sync status warning{googleSync?.lastErrorCode ? ` (${googleSync?.lastErrorCode})` : ''}: {googleSync.lastError}
          </p>
        )}

        <p className="text-[11px] text-[var(--color-app-muted)]/70 leading-relaxed">
          The vault is always encrypted before upload. Zync never uploads plaintext data.
        </p>
        <p className="text-[11px] text-[var(--color-app-muted)]/70 leading-relaxed">
          Note: Backup uploads encrypted vault.redb (disaster recovery). Restore pulls encrypted credential records from the provider sync collection. Passphrase/recovery secrets are never backed up.
        </p>
        <p className="text-[11px] text-[var(--color-app-muted)]/70 leading-relaxed">
          Settings sync uses a strict allowlist (theme/editor/terminal preferences). Local machine paths and sensitive local-only settings are excluded.
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
  );
}
