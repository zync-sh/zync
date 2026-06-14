import { Lock } from 'lucide-react';
import { Button } from '../../../ui/Button';

interface VaultLockedPanelProps {
  title: string;
  message: string;
  onUnlock: () => void;
  actionLabel?: string;
}

export function VaultLockedPanel({
  title,
  message,
  onUnlock,
  actionLabel = 'Unlock Vault',
}: VaultLockedPanelProps) {
  return (
    <div className="space-y-2">
      <h4 className="px-1 text-xs font-semibold uppercase tracking-wider text-app-muted">
        {title}
      </h4>
      <div className="rounded-xl border border-dashed border-app-border/50 bg-app-surface/10 px-4 py-8 text-center">
        <div className="mx-auto mb-3 flex h-10 w-10 items-center justify-center rounded-lg bg-amber-500/10 text-amber-400">
          <Lock size={18} />
        </div>
        <p className="text-sm text-app-muted">{message}</p>
        <Button size="sm" onClick={onUnlock} className="mt-4 gap-1.5">
          {actionLabel}
        </Button>
      </div>
    </div>
  );
}