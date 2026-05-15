import { Cloud, Download, LogOut, RefreshCw, Shield, Upload } from 'lucide-react';
import type { SyncCollectionStatus, SyncProviderStatus } from '../../../../vault/syncIpc';
import { Button } from '../../../ui/Button';
import { cn } from '../../../../lib/utils';

interface VaultSyncCardProps {
  googleSync: SyncProviderStatus | null;
  googleCollection: SyncCollectionStatus | null;
  isSyncing: boolean;
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
}

interface CollectionManagementSectionProps {
  googleCollection: SyncCollectionStatus | null;
  hasVaultConfigured: boolean;
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
  hasVaultConfigured,
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
            Set up Google sync collection before Backup/Restore.
          </span>
          <Button
            variant="secondary"
            size="sm"
            onClick={onSetupCollection}
            disabled={isSettingUpCollection || !hasVaultConfigured}
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
  const isBackupDisabled =
    isCollectionActionBlocked
    || !hasVaultConfigured
    || !googleCollection?.configured
    || !googleCollection?.keyCached;
  const isRestoreDisabled =
    isCollectionActionBlocked
    || !isVaultUnlocked
    || !googleCollection?.configured
    || !googleCollection?.keyCached;

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
              hasVaultConfigured={hasVaultConfigured}
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
            <div className="flex items-center gap-2">
              <Button
                variant="secondary"
                size="sm"
                onClick={onUpload}
                disabled={isBackupDisabled}
                className="gap-1.5"
              >
                {isSyncing ? <RefreshCw size={13} className="animate-spin" /> : <Upload size={13} />}
                Backup Vault File
              </Button>
              <Button
                variant="secondary"
                size="sm"
                onClick={onDownload}
                disabled={isRestoreDisabled}
                className="gap-1.5"
              >
                <Download size={13} />
                Restore Credentials
              </Button>
              {googleSync?.lastSync != null && (
                <span className="text-[11px] text-[var(--color-app-muted)] ml-auto whitespace-nowrap">
                  Last sync: {new Date(googleSync?.lastSync * 1000).toLocaleString()}
                </span>
              )}
            </div>
            {!hasVaultConfigured && (
              <p className="mt-2 text-[11px] text-amber-400/85">
                Initialize the local vault before setting up provider sync.
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
