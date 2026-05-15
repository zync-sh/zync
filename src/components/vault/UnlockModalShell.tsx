import type { ReactNode } from 'react';
import { Lock } from 'lucide-react';
import { Modal } from '../ui/Modal';
import { Button } from '../ui/Button';
import { VaultModeSwitch, type VaultModeOption } from './VaultModeSwitch';

interface UnlockModalShellProps<T extends string> {
  isOpen: boolean;
  onClose: () => void;
  title: string;
  subtitle: string;
  mode?: T;
  modeOptions?: VaultModeOption<T>[];
  onModeChange?: (mode: T) => void;
  hintText?: ReactNode;
  children: ReactNode;
  details?: ReactNode;
  error?: string;
  isSubmitting?: boolean;
  submitDisabled?: boolean;
  submitLabel: string;
  onSubmit: (event: React.FormEvent) => void;
  contentClassName?: string;
}

export function UnlockModalShell<T extends string>({
  isOpen,
  onClose,
  title,
  subtitle,
  mode,
  modeOptions,
  onModeChange,
  hintText,
  children,
  details,
  error,
  isSubmitting,
  submitDisabled,
  submitLabel,
  onSubmit,
  contentClassName,
}: UnlockModalShellProps<T>) {
  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      title={title}
      subtitle={subtitle}
      width="max-w-sm"
      contentClassName={contentClassName ?? 'min-h-[360px]'}
    >
      <form onSubmit={onSubmit} className="space-y-4">
        <div className="flex justify-center mb-2">
          <div className="w-12 h-12 rounded-full bg-[var(--color-app-accent)]/10 text-[var(--color-app-accent)] flex items-center justify-center">
            <Lock size={22} />
          </div>
        </div>

        {mode && modeOptions && onModeChange && (
          <VaultModeSwitch value={mode} onChange={onModeChange} options={modeOptions} />
        )}

        <div className="min-h-[20px]">
          {hintText && <p className="text-xs text-[var(--color-app-muted)]">{hintText}</p>}
        </div>

        {children}

        {details}

        {error && (
          <p className="text-xs text-red-400" role="alert" aria-live="polite" aria-atomic="true">{error}</p>
        )}

        <div className="flex gap-2 pt-1">
          <Button type="button" variant="ghost" onClick={onClose} className="flex-1" disabled={isSubmitting}>
            Cancel
          </Button>
          <Button type="submit" className="flex-1" disabled={Boolean(submitDisabled || isSubmitting)}>
            {submitLabel}
          </Button>
        </div>
      </form>
    </Modal>
  );
}
