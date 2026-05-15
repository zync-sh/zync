import { useEffect, useMemo, useState } from 'react';
import { KeyRound } from 'lucide-react';
import { UnlockModalShell } from '../../../vault/UnlockModalShell';
import { SecretField } from '../../../vault/SecretField';
import type { SyncCollectionUnlockArgs } from '../../../../vault/syncIpc';

const SYNC_PASSPHRASE_MIN_LENGTH = 12;

type UnlockMode = 'passphrase' | 'recovery-key';

interface SyncCollectionUnlockModalProps {
  isOpen: boolean;
  isSubmitting: boolean;
  hasRecoveryKey: boolean;
  onClose: () => void;
  onSubmit: (args: SyncCollectionUnlockArgs) => Promise<void>;
}

export function SyncCollectionUnlockModal({
  isOpen,
  isSubmitting,
  hasRecoveryKey,
  onClose,
  onSubmit,
}: SyncCollectionUnlockModalProps) {
  const [mode, setMode] = useState<UnlockMode>('passphrase');
  const [secret, setSecret] = useState('');
  const [showSecret, setShowSecret] = useState(false);
  const [error, setError] = useState('');

  const resetModalState = () => {
    setMode('passphrase');
    setSecret('');
    setShowSecret(false);
    setError('');
  };

  useEffect(() => {
    if (!isOpen) {
      resetModalState();
    }
  }, [isOpen]);

  const canSubmit = useMemo(() => {
    if (isSubmitting) return false;
    const trimmed = secret.trim();
    return mode === 'passphrase'
      ? trimmed.length >= SYNC_PASSPHRASE_MIN_LENGTH
      : trimmed.length > 0;
  }, [isSubmitting, mode, secret]);

  const handleClose = () => {
    resetModalState();
    onClose();
  };

  const handleSubmit = async (event: React.FormEvent) => {
    event.preventDefault();
    setError('');

    const trimmed = secret.trim();
    if (mode === 'passphrase' && trimmed.length < SYNC_PASSPHRASE_MIN_LENGTH) {
      setError(`Sync passphrase must be at least ${SYNC_PASSPHRASE_MIN_LENGTH} characters.`);
      return;
    }
    if (mode === 'recovery-key' && !trimmed) {
      setError('Enter the provider sync recovery key.');
      return;
    }

    try {
      await onSubmit(
        mode === 'recovery-key'
          ? { recoveryKey: trimmed }
          : { passphrase: trimmed },
      );
      handleClose();
    } catch (submissionError) {
      const message = submissionError instanceof Error ? submissionError.message : String(submissionError);
      setError(message);
    }
  };

  return (
    <UnlockModalShell
      isOpen={isOpen}
      onClose={handleClose}
      title="Unlock Google Sync Key"
      subtitle="Restore access to the cached provider sync key for this device."
      mode={mode}
      modeOptions={[
        { value: 'passphrase', label: 'Passphrase' },
        { value: 'recovery-key', label: 'Recovery Key', disabled: !hasRecoveryKey },
      ]}
      onModeChange={setMode}
      hintText={
        mode === 'passphrase' && hasRecoveryKey
          ? <>Forgot passphrase? Switch to <span className="text-[var(--color-app-text)] font-medium">Recovery Key</span>.</>
          : !hasRecoveryKey && mode === 'passphrase'
            ? 'Recovery key is not configured for this Google sync collection.'
            : undefined
      }
      details={(
        <div className="rounded-lg border border-[var(--color-app-border)]/50 bg-[var(--color-app-surface)]/20 p-3 text-[11px] text-[var(--color-app-muted)] leading-relaxed">
          <div className="flex items-center gap-2 text-[var(--color-app-text)] mb-1">
            <KeyRound size={12} />
            Security note
          </div>
          This unlocks only the provider sync key cache on this device. It does not upload your passphrase or recovery key.
        </div>
      )}
      error={error}
      isSubmitting={isSubmitting}
      submitDisabled={!canSubmit}
      submitLabel={isSubmitting ? 'Unlocking…' : 'Unlock'}
      onSubmit={handleSubmit}
    >
      <SecretField
        label={mode === 'recovery-key' ? 'Recovery Key' : 'Passphrase'}
        value={secret}
        onChange={setSecret}
        showSecret={showSecret}
        onToggleShow={() => setShowSecret(value => !value)}
        autoFocus
        placeholder={
          mode === 'recovery-key'
            ? 'Enter recovery key'
            : 'Enter passphrase'
        }
      />
    </UnlockModalShell>
  );
}
