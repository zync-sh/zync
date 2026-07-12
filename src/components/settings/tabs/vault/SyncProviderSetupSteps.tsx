import { Check, Shield } from 'lucide-react';
import { Button } from '../../../ui/Button';
import { cn } from '../../../../lib/utils';
import { GoogleMarkIcon } from '../../../icons/providerIcons';

interface SyncProviderSetupStepsProps {
  isConnected: boolean;
  isEncryptionConfigured: boolean;
  isEncryptionUnlocked: boolean;
  isConnectLoading: boolean;
  isSettingUpCollection: boolean;
  isUnlockingCollection: boolean;
  isActionBlocked: boolean;
  onConnect: () => void;
  onSetupCollection: () => void;
  onUnlockCollection: () => void;
}

const STEPS = [
  { key: 'connect', label: 'Connect', detail: 'Google Drive', icon: 'google' as const },
  { key: 'setup', label: 'Encrypt', detail: 'Set up key', icon: 'shield' as const },
  { key: 'unlock', label: 'Unlock', detail: 'This device', icon: 'shield' as const },
] as const;

export function SyncProviderSetupSteps({
  isConnected,
  isEncryptionConfigured,
  isEncryptionUnlocked,
  isConnectLoading,
  isSettingUpCollection,
  isUnlockingCollection,
  isActionBlocked,
  onConnect,
  onSetupCollection,
  onUnlockCollection,
}: SyncProviderSetupStepsProps) {
  const done = [isConnected, isEncryptionConfigured, isEncryptionUnlocked];
  const activeIndex = done.findIndex(step => !step);
  const currentIndex = activeIndex === -1 ? STEPS.length - 1 : activeIndex;

  const action =
    currentIndex === 0
      ? { label: isConnectLoading ? 'Connecting...' : 'Connect Google Drive', onClick: onConnect, loading: isConnectLoading }
      : currentIndex === 1
        ? {
            label: isSettingUpCollection ? 'Setting up...' : 'Set up encryption',
            onClick: onSetupCollection,
            loading: isSettingUpCollection,
          }
        : {
            label: isUnlockingCollection ? 'Unlocking...' : 'Unlock on this device',
            onClick: onUnlockCollection,
            loading: isUnlockingCollection,
          };

  return (
    <div className="rounded-xl border border-[var(--color-app-border)]/50 bg-gradient-to-br from-[var(--color-app-surface)]/30 to-[var(--color-app-bg)]/20 p-4">
      <p className="text-[10px] font-semibold uppercase tracking-[0.14em] text-[var(--color-app-muted)]">
        Before you can sync
      </p>
      <p className="mt-1 text-sm text-[var(--color-app-text)]">
        Complete these three steps to reveal sync and restore controls.
      </p>

      <div className="mt-4 grid grid-cols-3 gap-2">
        {STEPS.map((step, index) => {
          const isDone = done[index];
          const isActive = index === currentIndex && !isDone;
          return (
            <div key={step.key} className="relative flex flex-col items-center text-center">
              {index < STEPS.length - 1 && (
                <div
                  className={cn(
                    'absolute left-[calc(50%+18px)] top-4 h-px w-[calc(100%-36px)]',
                    isDone ? 'bg-emerald-500/40' : 'bg-[var(--color-app-border)]/50',
                  )}
                />
              )}
              <div
                className={cn(
                  'relative z-10 flex h-8 w-8 items-center justify-center rounded-full border',
                  isDone
                    ? 'border-emerald-500/40 bg-emerald-500/15 text-emerald-300'
                    : isActive
                      ? 'border-[var(--color-app-accent)]/40 bg-[var(--color-app-accent)]/15 text-[var(--color-app-accent)]'
                      : 'border-[var(--color-app-border)]/60 bg-[var(--color-app-surface)]/40 text-[var(--color-app-muted)]',
                )}
              >
                {isDone ? (
                  <Check size={14} />
                ) : step.icon === 'google' ? (
                  <GoogleMarkIcon size={14} variant={isActive ? 'color' : 'mono'} />
                ) : (
                  <Shield size={14} />
                )}
              </div>
              <p className="mt-2 text-[11px] font-semibold text-[var(--color-app-text)]">{step.label}</p>
              <p className="text-[10px] text-[var(--color-app-muted)]">{step.detail}</p>
            </div>
          );
        })}
      </div>

      {!isEncryptionUnlocked && (
        <Button
          size="sm"
          variant={currentIndex === 0 ? 'primary' : 'secondary'}
          onClick={action.onClick}
          disabled={isActionBlocked || action.loading}
          className="mt-4 gap-1.5"
        >
          {action.label}
        </Button>
      )}
    </div>
  );
}