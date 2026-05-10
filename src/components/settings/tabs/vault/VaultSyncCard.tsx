import { Cloud, Download, LogOut, RefreshCw, Upload } from 'lucide-react';
import type { SyncProviderStatus } from '../../../../vault/syncIpc';
import { Button } from '../../../ui/Button';
import { cn } from '../../../../lib/utils';

interface VaultSyncCardProps {
  googleSync: SyncProviderStatus | null;
  isSyncing: boolean;
  hasVaultConfigured: boolean;
  onConnect: () => void;
  onDisconnect: () => void;
  onUpload: () => void;
  onDownload: () => void;
}

export function VaultSyncCard({
  googleSync,
  isSyncing,
  hasVaultConfigured,
  onConnect,
  onDisconnect,
  onUpload,
  onDownload,
}: VaultSyncCardProps) {
  const googleStatusLabel = googleSync?.connected ? 'Connected' : 'Not connected';
  const googleStatusTone = googleSync?.connected
    ? 'bg-emerald-500/15 text-emerald-300 border-emerald-500/30'
    : 'bg-[var(--color-app-surface)] text-[var(--color-app-muted)] border-[var(--color-app-border)]/60';

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
            <div className="flex items-center gap-2">
              <Button
                variant="secondary"
                size="sm"
                onClick={onUpload}
                disabled={isSyncing || !hasVaultConfigured}
                className="gap-1.5"
              >
                {isSyncing ? <RefreshCw size={13} className="animate-spin" /> : <Upload size={13} />}
                Backup to Drive
              </Button>
              <Button
                variant="secondary"
                size="sm"
                onClick={onDownload}
                disabled={isSyncing || !hasVaultConfigured}
                className="gap-1.5"
              >
                <Download size={13} />
                Restore from Drive
              </Button>
              {googleSync.lastSync != null && (
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
  );
}
