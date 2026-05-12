import { Lock, RefreshCw, Shield, Unlock } from 'lucide-react';
import type { VaultStatus } from '../../../../vault/ipc';
import { Button } from '../../../ui/Button';
import { cn } from '../../../../lib/utils';

interface VaultStatusCardProps {
  status: VaultStatus | null;
  isUnlocked: boolean;
  isRepairingRefs: boolean;
  onRepairRefs: () => void;
  onLock: () => void;
  onOpenUnlock: () => void;
}

export function VaultStatusCard({
  status,
  isUnlocked,
  isRepairingRefs,
  onRepairRefs,
  onLock,
  onOpenUnlock,
}: VaultStatusCardProps) {
  const unlockedStatus = status?.status === 'unlocked' ? status : null;

  return (
    <div className="rounded-xl border border-(--color-app-border)/60 bg-(--color-app-surface)/25 p-4">
      <div className="flex items-center justify-between gap-4">
        <div className="flex items-center gap-3">
          <div className={cn(
            'w-10 h-10 rounded-lg flex items-center justify-center shrink-0',
            isUnlocked
              ? 'bg-emerald-500/15 text-emerald-400'
              : status?.status === 'locked'
                ? 'bg-amber-500/15 text-amber-400'
                : 'bg-(--color-app-surface) text-(--color-app-muted)'
          )}>
            <Shield size={18} />
          </div>
          <div>
            <p className="text-sm font-semibold text-(--color-app-text)">
              {isUnlocked ? 'Vault Unlocked'
                : status?.status === 'locked' ? 'Vault Locked'
                  : 'Vault Not Set Up'}
            </p>
            <p className="text-xs text-(--color-app-muted) mt-0.5">
              {isUnlocked
                ? `${unlockedStatus?.itemCount ?? 0} item(s) · XChaCha20-Poly1305 encrypted`
                : status?.status === 'locked'
                  ? 'Unlock to access and manage credentials'
                  : 'Create a vault to store SSH credentials securely'}
            </p>
          </div>
        </div>

        {isUnlocked ? (
          <div className="flex items-center gap-2">
            <Button
              variant="secondary"
              size="sm"
              onClick={onRepairRefs}
              disabled={isRepairingRefs}
              className="gap-1.5 shrink-0"
            >
              {isRepairingRefs ? <RefreshCw size={13} className="animate-spin" /> : <RefreshCw size={13} />}
              Repair Refs
            </Button>
            <Button variant="secondary" size="sm" onClick={onLock} className="gap-1.5 shrink-0">
              <Lock size={13} />
              Lock
            </Button>
          </div>
        ) : (
          <Button size="sm" onClick={onOpenUnlock} className="gap-1.5 shrink-0">
            {status?.status === 'locked' ? <Unlock size={13} /> : <Shield size={13} />}
            {status?.status === 'locked' ? 'Unlock' : 'Set Up Vault'}
          </Button>
        )}
      </div>
    </div>
  );
}
