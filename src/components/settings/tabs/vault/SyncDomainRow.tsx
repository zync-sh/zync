import { Download, RefreshCw, Upload } from 'lucide-react';
import type { ReactNode } from 'react';
import { domainStatusCopy } from '../../../../vault/syncDomainUi';
import type { SyncDomainStatusLike } from '../../../../vault/syncDomainUi';
import { Button } from '../../../ui/Button';
import { cn } from '../../../../lib/utils';

export interface SyncDomainRowProps {
  label: string;
  description: string;
  hint?: ReactNode;
  enabled: boolean;
  status?: SyncDomainStatusLike;
  isUpdatingPolicy: boolean;
  isActionBlocked: boolean;
  syncDisabled: boolean;
  restoreDisabled: boolean;
  isSyncing: boolean;
  isRestoring: boolean;
  syncLabel?: string;
  restoreLabel?: string;
  restoreVariant?: 'primary' | 'secondary' | 'ghost';
  extraActions?: ReactNode;
  gateMessage?: string;
  onToggleEnabled: () => void;
  onSync: () => void;
  onRestore: () => void;
  footer?: ReactNode;
}

export function SyncDomainRow({
  label,
  description,
  hint,
  enabled,
  status,
  isUpdatingPolicy,
  isActionBlocked,
  syncDisabled,
  restoreDisabled,
  isSyncing,
  isRestoring,
  syncLabel = 'Upload',
  restoreLabel = 'Restore',
  restoreVariant = 'secondary',
  extraActions,
  gateMessage,
  onToggleEnabled,
  onSync,
  onRestore,
  footer,
}: SyncDomainRowProps) {
  const hasError = Boolean(status?.lastError);

  const syncToggleButton = (
    <Button
      variant={enabled ? 'secondary' : 'ghost'}
      size="sm"
      onClick={onToggleEnabled}
      disabled={isUpdatingPolicy || isActionBlocked}
      className="h-6 shrink-0 gap-1 px-2 text-[11px]"
    >
      {isUpdatingPolicy ? <RefreshCw size={12} className="animate-spin" /> : null}
      {enabled ? 'Sync on' : 'Sync off'}
    </Button>
  );

  return (
    <div className="px-4 py-3">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between sm:gap-4">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <p className="text-sm font-medium text-[var(--color-app-text)]">{label}</p>
            {syncToggleButton}
          </div>
          <p className="mt-0.5 text-xs leading-relaxed text-[var(--color-app-muted)]">{description}</p>
          {hint && (
            <p className="mt-1 text-[10px] leading-relaxed text-[var(--color-app-muted)]/85">{hint}</p>
          )}
          <p
            className={cn(
              'mt-1.5 text-[11px]',
              hasError ? 'text-red-300/85' : 'text-[var(--color-app-muted)]/80',
            )}
          >
            {domainStatusCopy(status)}
          </p>
          {gateMessage && (
            <p className="mt-1.5 text-[10px] leading-relaxed text-[var(--color-app-muted)]">
              {gateMessage}
            </p>
          )}
        </div>

        <div className="flex w-full shrink-0 flex-wrap items-center justify-start gap-1.5 sm:w-auto sm:justify-end">
          {extraActions}
          <Button
            variant="ghost"
            size="sm"
            onClick={onSync}
            disabled={syncDisabled}
            className="h-7 gap-1.5 px-2"
          >
            {isSyncing ? <RefreshCw size={13} className="animate-spin" /> : <Upload size={13} />}
            {syncLabel}
          </Button>
          <Button
            variant={restoreVariant}
            size="sm"
            onClick={onRestore}
            disabled={restoreDisabled}
            className="h-7 gap-1.5 px-2"
          >
            {isRestoring ? <RefreshCw size={13} className="animate-spin" /> : <Download size={13} />}
            {restoreLabel}
          </Button>
        </div>
      </div>
      {footer}
    </div>
  );
}