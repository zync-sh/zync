import { useId, useState } from 'react';
import { ChevronDown, LogOut, RefreshCw, Shield } from 'lucide-react';
import { GoogleMarkIcon } from '../../../icons/providerIcons';
import type {
  SyncCollectionStatus,
  SyncConnectionsRestoreArgs,
  SyncDomainPolicy,
  SyncProviderStatus,
} from '../../../../vault/syncIpc';
import { Button } from '../../../ui/Button';
import { cn } from '../../../../lib/utils';
import { getProviderGateReason, getProviderReadiness } from '../../../../vault/syncProviderGate';
import { SyncDomainsGrouped } from './SyncDomainsGrouped';
import { SyncProviderSetupSteps } from './SyncProviderSetupSteps';

interface VaultSyncCardProps {
  googleSync: SyncProviderStatus | null;
  googleCollection: SyncCollectionStatus | null;
  isSyncing: boolean;
  isSyncingVault: boolean;
  isRestoringVault: boolean;
  isSyncingHosts: boolean;
  isRestoringHosts: boolean;
  isPreviewingConnections: boolean;
  isRestoringConnections: boolean;
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
  onRestoreConnections: (args: SyncConnectionsRestoreArgs) => void;
  onRestoreGlobalSnippets: () => void;
  onSetHostsSyncEnabled: (enabled: boolean) => void;
  onSetDomainPolicyEnabled: (domain: SyncDomainPolicy['domain'], enabled: boolean) => void;
  onSyncTunnels: () => void;
  onRestoreTunnels: () => void;
  onSyncSnippets: () => void;
  onRestoreSnippets: () => void;
  onSyncSettings: () => void;
  onRestoreSettings: () => void;
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
      <div className="mb-2 flex flex-col gap-2 rounded-lg border border-[var(--color-app-warning)]/30 bg-[var(--color-app-warning)]/12 p-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="min-w-0">
          <p className="text-xs font-semibold text-[var(--color-app-text)]">
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
      <div className="mb-2 flex flex-col gap-2 rounded-lg border border-[var(--color-app-warning)]/30 bg-[var(--color-app-warning)]/12 p-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="min-w-0">
          <p className="text-xs font-semibold text-[var(--color-app-text)]">
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
        variant="secondary"
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
        variant="secondary"
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
  isSyncingVault,
  isRestoringVault,
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
  onRestoreConnections,
  onRestoreGlobalSnippets,
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
  // Domain ops only — Google OAuth connect (isSyncing) must not block Upload/Restore.
  const isDomainActionInFlight =
    isSyncingVault
    || isRestoringVault
    || isSyncingHosts
    || isRestoringHosts
    || isPreviewingConnections
    || isRestoringConnections
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
    || isRegeneratingCollectionRecoveryKey
    || isSyncing; // still block while OAuth connect is running
  const isProviderDomainActionDisabled =
    isCollectionActionBlocked
    || !googleCollection?.configured
    || !googleCollection?.keyCached;
  const providerReadiness = getProviderReadiness(googleSync, googleCollection);
  // Only show setup/unlock guidance here — not "finish current action" (that was blocking
  // restore when encryption was already ready and confused users).
  const providerGateReason = getProviderGateReason(providerReadiness);
  const isProviderReady = providerReadiness.isProviderReady;
  const encryptionHelpId = useId();
  const [encryptionHelpOpen, setEncryptionHelpOpen] = useState(false);
  return (
    <div className="space-y-2">
      <h4 className="px-1 text-xs font-semibold uppercase tracking-wider text-[var(--color-app-muted)]">
        Provider Sync
      </h4>
      <div className="space-y-3 rounded-xl border border-[var(--color-app-border)]/60 bg-[var(--color-app-surface)]/25 p-4">
        <div className="flex items-start justify-between gap-3">
          <div className="flex min-w-0 items-start gap-3">
            <div className={cn(
              'flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border',
              'border-[var(--color-app-border)]/50 bg-[var(--color-app-surface)]',
              !googleSync?.connected && 'text-[var(--color-app-muted)]',
            )}>
              <GoogleMarkIcon
                size={18}
                variant={googleSync?.connected ? 'color' : 'mono'}
              />
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
              {isSyncing ? (
                <RefreshCw size={13} className="animate-spin" />
              ) : (
                <GoogleMarkIcon size={14} variant="mono" className="opacity-90" />
              )}
              Connect
            </Button>
          )}
        </div>

        {!isProviderReady && (
          <SyncProviderSetupSteps
            isConnected={providerReadiness.isConnected}
            isEncryptionConfigured={providerReadiness.isEncryptionConfigured}
            isEncryptionUnlocked={providerReadiness.isEncryptionUnlocked}
            isConnectLoading={isSyncing}
            isSettingUpCollection={isSettingUpCollection}
            isUnlockingCollection={isUnlockingCollection}
            isActionBlocked={isCollectionActionBlocked}
            onConnect={onConnect}
            onSetupCollection={onSetupCollection}
            onUnlockCollection={onUnlockCollection}
          />
        )}

        {isProviderReady && (
          <div className="space-y-4 border-t border-[var(--color-app-border)]/30 pt-4">
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

            <SyncDomainsGrouped
                googleSync={googleSync}
                googleCollection={googleCollection}
                hostsSyncEnabled={hostsSyncEnabled}
                domainPolicies={domainPolicies}
                isUpdatingDomainPolicy={isUpdatingDomainPolicy}
                isCollectionActionBlocked={isCollectionActionBlocked}
                isProviderDomainActionDisabled={isProviderDomainActionDisabled}
                providerGateReason={providerGateReason}
                hasVaultConfigured={hasVaultConfigured}
                isVaultUnlocked={isVaultUnlocked}
                isSyncingVault={isSyncingVault}
                isRestoringVault={isRestoringVault}
                isSyncingHosts={isSyncingHosts}
                isRestoringHosts={isRestoringHosts}
                isPreviewingConnections={isPreviewingConnections}
                isRestoringConnections={isRestoringConnections}
                isSyncingTunnels={isSyncingTunnels}
                isRestoringTunnels={isRestoringTunnels}
                isSyncingSnippets={isSyncingSnippets}
                isRestoringSnippets={isRestoringSnippets}
                isSyncingSettings={isSyncingSettings}
                isRestoringSettings={isRestoringSettings}
                onSetHostsSyncEnabled={onSetHostsSyncEnabled}
                onSetDomainPolicyEnabled={onSetDomainPolicyEnabled}
                onSyncHosts={onSyncHosts}
                onRestoreConnections={onRestoreConnections}
                onRestoreHosts={onRestoreHosts}
                onSyncTunnels={onSyncTunnels}
                onRestoreTunnels={onRestoreTunnels}
                onSyncSnippets={onSyncSnippets}
                onRestoreGlobalSnippets={onRestoreGlobalSnippets}
                onRestoreSnippets={onRestoreSnippets}
                onSyncSettings={onSyncSettings}
                onRestoreSettings={onRestoreSettings}
                onUpload={onUpload}
                onDownload={onDownload}
              />

            {!hasVaultConfigured && (
              <p className="text-[11px] leading-relaxed text-[var(--color-app-muted)]">
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

        <button
          type="button"
          onClick={() => setEncryptionHelpOpen(value => !value)}
          aria-expanded={encryptionHelpOpen}
          aria-controls={encryptionHelpId}
          className="flex w-full items-center justify-between rounded-lg border border-[var(--color-app-border)]/45 bg-[var(--color-app-bg)]/15 px-3 py-2 text-left"
        >
          <span className="text-[11px] font-medium text-[var(--color-app-text)]">
            How encryption & backup work
          </span>
          <ChevronDown
            size={14}
            className={cn(
              'shrink-0 text-[var(--color-app-muted)] transition-transform',
              encryptionHelpOpen && 'rotate-180',
            )}
          />
        </button>
        {encryptionHelpOpen && (
          <div
            id={encryptionHelpId}
            className="space-y-2 rounded-lg border border-[var(--color-app-border)]/40 bg-[var(--color-app-bg)]/15 px-3 py-2.5"
          >
            <p className="text-[11px] leading-relaxed text-[var(--color-app-muted)]/80">
              Google Drive records are encrypted by Zync before upload. Zync never uploads plaintext credentials, sync passphrases, or recovery keys.
            </p>
            <p className="text-[11px] leading-relaxed text-[var(--color-app-muted)]/80">
              Domain sync stores encrypted app data per category. Vault credential sync stores item-level records; full vault backup stays a separate disaster-recovery path.
            </p>
            {!googleSync?.connected && (
              <p className="text-[11px] leading-relaxed text-[var(--color-app-muted)]">
                Tip: on the Google sign-in screen, check the Drive checkbox — Google requires explicit consent for storage access.
              </p>
            )}
          </div>
        )}

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
      </div>
    </div>
  );
}
