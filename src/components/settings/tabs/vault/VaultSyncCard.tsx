import { Cloud, Download, LogOut, RefreshCw, Shield, Server } from 'lucide-react';
import type {
  SyncCollectionStatus,
  SyncDomain,
  SyncDomainPolicy,
  SyncDomainStatus,
  SyncProviderStatus,
} from '../../../../vault/syncIpc';
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
  isUpdatingDomainPolicy: boolean;
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
  if (!value) return 'Never synced';
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
  isActionBlocked: boolean;
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
  isActionBlocked,
  onSetupCollection,
  onUnlockCollection,
  onLockCollection,
  onRegenerateCollectionRecoveryKey,
}: CollectionManagementSectionProps) {
  if (!googleCollection?.configured) {
    return (
      <div className="mb-2 flex flex-col gap-2 rounded-lg border border-amber-500/20 bg-amber-500/8 p-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="min-w-0">
          <p className="text-xs font-semibold text-amber-200">
            Google encryption is not set up
          </p>
          <p className="mt-1 text-[11px] leading-relaxed text-[var(--color-app-muted)]">
            Set this up once before syncing or restoring hosts, tunnels, snippets,
            settings, or vault credentials. This is separate from Local Vault setup.
          </p>
        </div>
        <Button
          variant="secondary"
          size="sm"
          onClick={onSetupCollection}
          disabled={isSettingUpCollection || isActionBlocked}
          className="gap-1.5"
        >
          {isSettingUpCollection ? (
            <RefreshCw size={13} className="animate-spin" />
          ) : (
            <Shield size={13} />
          )}
          Set up Google Encryption
        </Button>
      </div>
    );
  }

  if (!googleCollection.keyCached) {
    return (
      <div className="mb-2 flex flex-col gap-2 rounded-lg border border-amber-500/20 bg-amber-500/8 p-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="min-w-0">
          <p className="text-xs font-semibold text-amber-200">
            Google encryption is locked
          </p>
          <p className="mt-1 text-[11px] leading-relaxed text-[var(--color-app-muted)]">
            Unlock encryption on this device to sync or restore provider records.
            Passphrases and recovery keys are never uploaded.
          </p>
        </div>
        <Button
          variant="secondary"
          size="sm"
          onClick={onUnlockCollection}
          disabled={
            isUnlockingCollection
            || isActionBlocked
            || isSettingUpCollection
            || isLockingCollection
            || isRegeneratingCollectionRecoveryKey
          }
          className="gap-1.5"
        >
          {isUnlockingCollection ? (
            <RefreshCw size={13} className="animate-spin" />
          ) : (
            <Shield size={13} />
          )}
          Unlock Google Encryption
        </Button>
      </div>
    );
  }

  return (
    <div className="mb-2 flex flex-wrap items-center gap-2">
      <Button
        variant="ghost"
        size="sm"
        onClick={onLockCollection}
        disabled={
          isLockingCollection
          || isUnlockingCollection
          || isRegeneratingCollectionRecoveryKey
          || isActionBlocked
          || isSettingUpCollection
        }
        className="gap-1.5"
      >
        {isLockingCollection ? (
          <RefreshCw size={13} className="animate-spin" />
        ) : (
          <Shield size={13} />
        )}
        Lock Encryption
      </Button>
      <Button
        variant="ghost"
        size="sm"
        onClick={onRegenerateCollectionRecoveryKey}
        disabled={
          isRegeneratingCollectionRecoveryKey
          || isActionBlocked
          || isSettingUpCollection
          || isUnlockingCollection
          || isLockingCollection
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
  isUpdatingDomainPolicy,
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
  const isDomainActionInFlight =
    isSyncing
    || isSyncingHosts
    || isRestoringHosts
    || isSyncingTunnels
    || isRestoringTunnels
    || isSyncingSnippets
    || isRestoringSnippets
    || isSyncingSettings
    || isRestoringSettings;
  const isCollectionActionBlocked =
    isDomainActionInFlight
    || isSettingUpCollection
    || isUnlockingCollection
    || isLockingCollection
    || isRegeneratingCollectionRecoveryKey;
  const isProviderDomainActionDisabled =
    isCollectionActionBlocked
    || !googleCollection?.configured
    || !googleCollection?.keyCached;
  const providerGateReason =
    !googleCollection?.configured
      ? 'Set up Google encryption to enable Sync and Restore.'
      : !googleCollection?.keyCached
        ? 'Unlock Google encryption on this device to enable Sync and Restore.'
        : isCollectionActionBlocked
          ? 'Finish the current sync or Google encryption action first.'
          : null;
  const isVaultSyncDisabled = isProviderDomainActionDisabled || !hasVaultConfigured;
  const isRestoreDisabled = isProviderDomainActionDisabled || !isVaultUnlocked;
  const domainStatusByKey = new Map(
    (googleSync?.domainStatuses ?? []).map(status => [status.domain, status]),
  );
  const domainPolicyEnabled = (
    domain: SyncDomain,
    fallback = getSyncDomainDefinition(domain).defaultEnabled,
  ) => domainPolicies.find(policy => policy.domain === domain)?.enabled ?? fallback;
  const isVaultDomainEnabled = domainPolicyEnabled('vault');
  const domainRows = [
    {
      key: 'vault' as const,
      enabled: isVaultDomainEnabled,
      syncing: isSyncing,
      restoring: isSyncing,
      onSync: onUpload,
      onRestore: onDownload,
      syncLabel: 'Sync',
      restoreLabel: 'Restore',
      syncDisabled: isVaultSyncDisabled || !isVaultDomainEnabled,
      restoreDisabled: isRestoreDisabled || !isVaultDomainEnabled,
      onToggle: () => onSetDomainPolicyEnabled('vault', !isVaultDomainEnabled),
      disabledReason: providerGateReason
        ?? (!isVaultDomainEnabled
          ? 'Enable Vault credentials sync to use this domain.'
          : !hasVaultConfigured
          ? 'Create the Local Vault before syncing vault credentials.'
          : !isVaultUnlocked
            ? 'Unlock the Local Vault before restoring vault credentials.'
            : null),
    },
    {
      key: 'hosts' as const,
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
      disabledReason: providerGateReason ?? (!hostsSyncEnabled ? 'Enable Hosts sync to use this domain.' : null),
    },
    {
      key: 'tunnels' as const,
      enabled: domainPolicyEnabled('tunnels'),
      syncing: isSyncingTunnels,
      restoring: isRestoringTunnels,
      onSync: onSyncTunnels,
      onRestore: onRestoreTunnels,
      syncLabel: 'Sync',
      restoreLabel: 'Restore',
      syncDisabled: isProviderDomainActionDisabled || !domainPolicyEnabled('tunnels') || isSyncingTunnels,
      restoreDisabled: isProviderDomainActionDisabled || !domainPolicyEnabled('tunnels') || isRestoringTunnels,
      onToggle: () => onSetDomainPolicyEnabled('tunnels', !domainPolicyEnabled('tunnels')),
      disabledReason: providerGateReason
        ?? (!domainPolicyEnabled('tunnels') ? 'Enable Tunnels sync to use this domain.' : null),
    },
    {
      key: 'snippets' as const,
      enabled: domainPolicyEnabled('snippets'),
      syncing: isSyncingSnippets,
      restoring: isRestoringSnippets,
      onSync: onSyncSnippets,
      onRestore: onRestoreSnippets,
      syncLabel: 'Sync',
      restoreLabel: 'Restore',
      syncDisabled: isProviderDomainActionDisabled || !domainPolicyEnabled('snippets') || isSyncingSnippets,
      restoreDisabled: isProviderDomainActionDisabled || !domainPolicyEnabled('snippets') || isRestoringSnippets,
      onToggle: () => onSetDomainPolicyEnabled('snippets', !domainPolicyEnabled('snippets')),
      disabledReason: providerGateReason
        ?? (!domainPolicyEnabled('snippets') ? 'Enable Snippets sync to use this domain.' : null),
    },
    {
      key: 'settings' as const,
      enabled: domainPolicyEnabled('settings'),
      syncing: isSyncingSettings,
      restoring: isRestoringSettings,
      onSync: onSyncSettings,
      onRestore: onRestoreSettings,
      syncLabel: 'Sync',
      restoreLabel: 'Restore',
      syncDisabled: isProviderDomainActionDisabled || !domainPolicyEnabled('settings') || isSyncingSettings,
      restoreDisabled: isProviderDomainActionDisabled || !domainPolicyEnabled('settings') || isRestoringSettings,
      onToggle: () => onSetDomainPolicyEnabled('settings', !domainPolicyEnabled('settings')),
      disabledReason: providerGateReason
        ?? (!domainPolicyEnabled('settings') ? 'Enable Settings sync to use this domain.' : null),
    },
  ];

  return (
    <div className="space-y-2">
      <h4 className="px-1 text-xs font-semibold uppercase tracking-wider text-[var(--color-app-muted)]">
        Provider Sync
      </h4>
      <div className="space-y-3 rounded-xl border border-[var(--color-app-border)]/60 bg-[var(--color-app-surface)]/25 p-4">
        <div className="flex items-start justify-between gap-3">
          <div className="flex min-w-0 items-start gap-3">
            <div className={cn(
              'flex h-9 w-9 shrink-0 items-center justify-center rounded-lg',
              googleSync?.connected
                ? 'bg-blue-500/15 text-blue-400'
                : 'bg-[var(--color-app-surface)] text-[var(--color-app-muted)]',
            )}>
              <Cloud size={16} />
            </div>
            <div className="min-w-0">
              <p className="text-sm font-medium text-[var(--color-app-text)]">Google Drive</p>
              <div className="mt-1 flex min-w-0 flex-wrap items-center gap-2">
                <span className={cn(
                  'inline-flex items-center rounded-md border px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide',
                  googleStatusTone,
                )}>
                  {googleStatusLabel}
                </span>
                {googleSync?.email && (
                  <span className="truncate text-xs text-[var(--color-app-muted)]">
                    {googleSync.email}
                  </span>
                )}
              </div>
              <p className="mt-1 text-xs text-[var(--color-app-muted)]">
                {googleSync?.connected
                  ? `Google encryption: ${
                    googleCollection?.configured
                      ? googleCollection.keyCached
                        ? 'ready'
                        : 'locked'
                      : 'not set up'
                  }`
                  : 'Syncs to your Drive appdata folder with Zync encryption.'}
              </p>
            </div>
          </div>
          {googleSync?.connected ? (
            <Button
              variant="ghost"
              size="sm"
              onClick={onDisconnect}
              disabled={isCollectionActionBlocked}
              className="gap-1.5 shrink-0 text-[var(--color-app-muted)] hover:text-red-400"
            >
              <LogOut size={13} />
              Disconnect
            </Button>
          ) : (
            <Button
              size="sm"
              onClick={onConnect}
              disabled={isCollectionActionBlocked}
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
              isActionBlocked={isCollectionActionBlocked}
              onSetupCollection={onSetupCollection}
              onUnlockCollection={onUnlockCollection}
              onLockCollection={onLockCollection}
              onRegenerateCollectionRecoveryKey={onRegenerateCollectionRecoveryKey}
            />

            <div className="mt-2.5 space-y-2.5 rounded-lg border border-[var(--color-app-border)]/50 bg-[var(--color-app-surface)]/20 p-3">
              <div className="flex items-center justify-between gap-3">
                <div>
                  <p className="text-[10px] font-semibold uppercase tracking-[0.14em] text-[var(--color-app-muted)]">
                    Sync Domains
                  </p>
                  <p className="mt-0.5 text-[11px] text-[var(--color-app-muted)]/75">
                    Choose what Google Drive manages. Each domain keeps separate sync state.
                  </p>
                </div>
                {googleSync?.lastSync != null && (
                  <span className="whitespace-nowrap text-[11px] text-[var(--color-app-muted)]">
                    Overall {formatSyncTime(googleSync.lastSync).toLowerCase()}
                  </span>
                )}
              </div>

              <div className="grid gap-2 md:grid-cols-2">
                {domainRows.map(row => {
                  const definition = getSyncDomainDefinition(row.key);
                  const status = domainStatusByKey.get(row.key);
                  const hasError = Boolean(status?.lastError);
                  return (
                    <div
                      key={row.key}
                      className={cn(
                        'rounded-lg border p-3 transition-colors',
                        row.enabled
                          ? 'border-[var(--color-app-accent)]/25 bg-[var(--color-app-accent)]/5'
                          : 'border-[var(--color-app-border)]/45 bg-[var(--color-app-bg)]/20',
                      )}
                    >
                      <div className="flex items-start justify-between gap-3">
                        <div className="min-w-0">
                          <div className="flex items-center gap-2">
                            <span className="text-xs font-semibold text-[var(--color-app-text)]">
                              {definition.label}
                            </span>
                            <span
                              className={cn(
                                'inline-flex items-center rounded border px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wide',
                                row.enabled
                                  ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-300'
                                  : 'border-[var(--color-app-border)]/60 bg-[var(--color-app-surface)] text-[var(--color-app-muted)]',
                              )}
                            >
                              {row.enabled ? 'On' : 'Off'}
                            </span>
                          </div>
                          <p className="mt-1 text-[11px] leading-relaxed text-[var(--color-app-muted)]">
                            {definition.description}
                          </p>
                        </div>
                        <Button
                          variant={row.enabled ? 'secondary' : 'ghost'}
                          size="sm"
                          onClick={row.onToggle}
                          disabled={isUpdatingDomainPolicy || isCollectionActionBlocked}
                          className="h-7 min-w-[72px] shrink-0 gap-1.5 px-2"
                        >
                          {isUpdatingDomainPolicy ? <RefreshCw size={13} className="animate-spin" /> : <Shield size={13} />}
                          {row.enabled ? 'Enabled' : 'Disabled'}
                        </Button>
                      </div>

                      <div className="mt-3 flex flex-col gap-2">
                        <p className={cn(
                          'min-w-0 text-[11px]',
                          hasError ? 'text-red-300/85' : 'text-[var(--color-app-muted)]/80',
                        )}>
                          {domainStatusCopy(status)}
                        </p>
                        <div className="flex flex-wrap items-center gap-1.5">
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={row.onSync}
                            disabled={row.syncDisabled}
                            className="h-7 min-w-[78px] gap-1.5 px-2"
                          >
                            {row.syncing ? <RefreshCw size={13} className="animate-spin" /> : <Server size={13} />}
                            {row.syncLabel}
                          </Button>
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={row.onRestore}
                            disabled={row.restoreDisabled}
                            className="h-7 min-w-[78px] gap-1.5 px-2"
                          >
                            {row.restoring ? <RefreshCw size={13} className="animate-spin" /> : <Download size={13} />}
                            {row.restoreLabel}
                          </Button>
                        </div>
                        {(row.syncDisabled || row.restoreDisabled) && row.disabledReason && (
                          <p className="text-[10px] leading-relaxed text-amber-300/80">
                            {row.disabledReason}
                          </p>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>

            {!hasVaultConfigured && (
              <p className="mt-2 text-[11px] leading-relaxed text-amber-400/85">
                Local vault is not set up. App-data domains can sync with a custom Google sync passphrase; vault credential sync/restore stays disabled until you create the local vault.
              </p>
            )}
          </div>
        )}

        {googleSync?.lastError && (
          <p className="text-[11px] leading-relaxed text-red-300/85">
            Sync status warning{googleSync?.lastErrorCode ? ` (${googleSync?.lastErrorCode})` : ''}: {googleSync.lastError}
          </p>
        )}

        <p className="text-[11px] leading-relaxed text-[var(--color-app-muted)]/70">
          Google Drive records are encrypted by Zync before upload. Zync never uploads plaintext credentials, sync passphrases, or recovery keys.
        </p>
        <p className="text-[11px] leading-relaxed text-[var(--color-app-muted)]/70">
          Credential sync stores item-level encrypted vault records. Full vault backup remains a disaster-recovery path and stays separate from domain sync.
        </p>
        <div className="inline-flex items-center gap-2 rounded-md border border-[var(--color-app-accent)]/25 bg-[var(--color-app-accent)]/8 px-2.5 py-1.5">
          <img
            src="/icon.png"
            alt="Zync"
            className="h-4 w-4 rounded-sm ring-1 ring-[var(--color-app-border)]/60"
          />
          <span className="text-[11px] font-medium text-[var(--color-app-text)]/90">
            Encrypted locally before Google Drive
          </span>
        </div>
        {!googleSync?.connected && (
          <p className="text-[11px] leading-relaxed text-amber-400/75">
            Tip: on the Google sign-in screen, make sure to check the Drive checkbox; Google requires explicit consent for storage access.
          </p>
        )}
      </div>
    </div>
  );
}
