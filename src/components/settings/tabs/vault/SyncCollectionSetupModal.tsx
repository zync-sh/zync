import { useEffect, useMemo, useState } from 'react';
import { Eye, EyeOff, Shield } from 'lucide-react';
import { Modal } from '../../../ui/Modal';
import { Input } from '../../../ui/Input';
import { Button } from '../../../ui/Button';
import { VaultModeSwitch } from '../../../vault/VaultModeSwitch';
import type { SyncCollectionSetupArgs, SyncKeyPolicyMode } from '../../../../vault/syncIpc';

const SYNC_PASSPHRASE_MIN_LENGTH = 12;

interface SyncCollectionSetupModalProps {
  isOpen: boolean;
  isSubmitting: boolean;
  onClose: () => void;
  onSubmit: (args: SyncCollectionSetupArgs) => Promise<void>;
}

export function SyncCollectionSetupModal({
  isOpen,
  isSubmitting,
  onClose,
  onSubmit,
}: SyncCollectionSetupModalProps) {
  const [mode, setMode] = useState<SyncKeyPolicyMode>('local-passphrase');
  const [passphrase, setPassphrase] = useState('');
  const [confirmPassphrase, setConfirmPassphrase] = useState('');
  const [showPassphrase, setShowPassphrase] = useState(false);
  const [hasRecoveryKey, setHasRecoveryKey] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!isOpen) {
      setMode('local-passphrase');
      setPassphrase('');
      setConfirmPassphrase('');
      setShowPassphrase(false);
      setHasRecoveryKey(true);
      setError('');
    }
  }, [isOpen]);

  const canSubmit = useMemo(() => {
    return (
      !isSubmitting
      && passphrase.length >= SYNC_PASSPHRASE_MIN_LENGTH
      && passphrase === confirmPassphrase
    );
  }, [confirmPassphrase, isSubmitting, passphrase]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');

    if (passphrase.length < SYNC_PASSPHRASE_MIN_LENGTH) {
      setError(
        `${mode === 'local-passphrase' ? 'Local Vault passphrase' : 'Sync passphrase'} must be at least ${SYNC_PASSPHRASE_MIN_LENGTH} characters.`,
      );
      return;
    }
    if (passphrase !== confirmPassphrase) {
      setError('Passphrases do not match.');
      return;
    }

    try {
      await onSubmit({
        keyPolicyMode: mode,
        passphrase,
        hasRecoveryKey,
      });
      onClose();
    } catch (submissionError) {
      const message = submissionError instanceof Error ? submissionError.message : String(submissionError);
      setError(message);
    }
  };

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      title="Set up Google Sync Key"
      subtitle="Configure how Google provider credentials are encrypted for cloud sync."
      width="max-w-md"
    >
      <form onSubmit={handleSubmit} className="space-y-4">
        <div className="flex justify-center mb-2">
          <div className="w-12 h-12 rounded-full bg-[var(--color-app-accent)]/10 text-[var(--color-app-accent)] flex items-center justify-center">
            <Shield size={22} />
          </div>
        </div>

        <VaultModeSwitch
          value={mode}
          onChange={setMode}
          options={[
            { value: 'local-passphrase', label: 'Use Local Passphrase' },
            { value: 'custom-passphrase', label: 'Use Custom Passphrase' },
          ]}
        />

        {mode === 'local-passphrase' && (
          <p className="text-xs text-[var(--color-app-muted)]">
            Recommended: reuses your local vault passphrase for Google sync key unlock.
          </p>
        )}

        <Input
          label={mode === 'local-passphrase' ? 'Local Vault passphrase' : 'Sync passphrase'}
          type={showPassphrase ? 'text' : 'password'}
          value={passphrase}
          onChange={(e) => setPassphrase(e.target.value)}
          placeholder={
            mode === 'local-passphrase'
              ? 'Enter your local vault passphrase'
              : 'Create sync passphrase'
          }
          rightElement={
            <button
              type="button"
              onClick={() => setShowPassphrase(v => !v)}
              aria-label={showPassphrase ? 'Hide passphrase' : 'Show passphrase'}
              className="text-app-muted hover:text-app-text transition-colors"
            >
              {showPassphrase ? <EyeOff size={14} /> : <Eye size={14} />}
            </button>
          }
        />
        <Input
          label={mode === 'local-passphrase' ? 'Confirm local passphrase' : 'Confirm sync passphrase'}
          type={showPassphrase ? 'text' : 'password'}
          value={confirmPassphrase}
          onChange={(e) => setConfirmPassphrase(e.target.value)}
          placeholder={
            mode === 'local-passphrase'
              ? 'Repeat local vault passphrase'
            : 'Repeat sync passphrase'
          }
        />

        <p className="text-[11px] text-[var(--color-app-muted)]">
          Minimum 12 characters.
        </p>

        <label className="flex items-start gap-2 text-sm text-[var(--color-app-muted)] cursor-pointer">
          <input
            type="checkbox"
            checked={hasRecoveryKey}
            onChange={(e) => setHasRecoveryKey(e.target.checked)}
            className="mt-0.5"
          />
          <span>
            Generate a provider sync recovery key (recommended).
          </span>
        </label>

        <div className="rounded-lg border border-[var(--color-app-border)]/50 bg-[var(--color-app-surface)]/20 p-3 text-[11px] text-[var(--color-app-muted)] leading-relaxed">
          <div className="flex items-center gap-2 text-[var(--color-app-text)] mb-1">
            <Shield size={12} />
            Security note
          </div>
          Cloud providers only store encrypted credential records and sync metadata. Passphrases are not uploaded.
        </div>

        {error && (
          <p className="text-xs text-red-400">{error}</p>
        )}

        <div className="flex gap-2 pt-1">
          <Button type="button" variant="ghost" onClick={onClose} className="flex-1" disabled={isSubmitting}>
            Cancel
          </Button>
          <Button type="submit" className="flex-1" disabled={!canSubmit}>
            {isSubmitting ? 'Setting up…' : 'Set up Sync Key'}
          </Button>
        </div>
      </form>
    </Modal>
  );
}
