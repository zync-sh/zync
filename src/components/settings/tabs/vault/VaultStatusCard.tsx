import { Lock, Shield, Unlock } from 'lucide-react';
import type { VaultStatus } from '../../../../vault/ipc';
import { isVaultStatusPending } from '../../../../vault/vaultLoading';
import { Button } from '../../../ui/Button';
import { cn } from '../../../../lib/utils';
import { VaultStatusCardSkeleton } from './VaultStatusCardSkeleton';

interface VaultStatusCardProps {
  status: VaultStatus | null;
  isLoading: boolean;
  isUnlocked: boolean;
  onLock: () => void;
  onOpenUnlock: () => void;
  onForgetDevice?: () => void;
}

export function VaultStatusCard({
  status,
  isLoading,
  isUnlocked,
  onLock,
  onOpenUnlock,
  onForgetDevice,
}: VaultStatusCardProps) {
  const unlockedStatus = status?.status === 'unlocked' ? status : null;
  const lockedStatus = status?.status === 'locked' ? status : null;

  if (isVaultStatusPending(status, isLoading)) {
    return <VaultStatusCardSkeleton />;
  }

  const statusSubtitle = (() => {
    if (isUnlocked) {
      const count = unlockedStatus?.itemCount ?? 0;
      return `${count} credential${count === 1 ? '' : 's'} · encrypted on this device`;
    }
    if (status?.status === 'locked') {
      const count = lockedStatus?.itemCount ?? 0;
      const countLabel = `${count} credential${count === 1 ? '' : 's'}`;
      if (lockedStatus?.rememberedOnDevice) {
        return `${countLabel} · remembered on this device · unlock to access`;
      }
      return `${countLabel} · unlock to access`;
    }
    return 'Create a vault to store SSH credentials securely';
  })();

  return (
    <div className="rounded-xl border border-[var(--color-app-border)]/60 bg-[var(--color-app-surface)]/25 p-4">
      <div className="flex items-center justify-between gap-4">
        <div className="flex items-center gap-3">
          <div
            className={cn(
              'flex h-10 w-10 shrink-0 items-center justify-center rounded-lg',
              isUnlocked
                ? 'bg-emerald-500/15 text-emerald-400'
                : status?.status === 'locked'
                  ? 'bg-amber-500/15 text-amber-400'
                  : 'bg-[var(--color-app-surface)] text-[var(--color-app-muted)]',
            )}
          >
            <Shield size={18} />
          </div>
          <div>
            <p className="text-sm font-semibold text-[var(--color-app-text)]">
              {isUnlocked
                ? 'Vault Unlocked'
                : status?.status === 'locked'
                  ? 'Vault Locked'
                  : 'Vault Not Set Up'}
            </p>
            <p className="mt-0.5 text-xs text-[var(--color-app-muted)]">{statusSubtitle}</p>
          </div>
        </div>

        {isUnlocked ? (
          <Button variant="secondary" size="sm" onClick={onLock} className="shrink-0 gap-1.5">
            <Lock size={13} />
            Lock
          </Button>
        ) : (
          <div className="flex shrink-0 items-center gap-2">
            {status?.status === 'locked' && lockedStatus?.rememberedOnDevice && onForgetDevice && (
              <Button variant="secondary" size="sm" onClick={onForgetDevice}>
                Forget Device
              </Button>
            )}
            <Button size="sm" onClick={onOpenUnlock} className="gap-1.5">
              {status?.status === 'locked' ? <Unlock size={13} /> : <Shield size={13} />}
              {status?.status === 'locked' ? 'Unlock' : 'Set Up Vault'}
            </Button>
          </div>
        )}
      </div>
    </div>
  );
}