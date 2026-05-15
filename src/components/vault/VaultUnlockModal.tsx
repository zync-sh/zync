import { useState } from 'react';
import { Input } from '../ui/Input';
import { KeyRound } from 'lucide-react';
import { useVaultStore } from '../../vault/useVaultStore';
import { UnlockModalShell } from './UnlockModalShell';
import { SecretField } from './SecretField';

/** Minimum passphrase length enforced at vault creation time. */
export const PASSPHRASE_MIN_LENGTH = 12;

interface Props {
  isOpen: boolean;
  onClose: () => void;
}

export function VaultUnlockModal({ isOpen, onClose }: Props) {
  const { status, initialize, unlock, unlockWithRecoveryKey, isLoading, clearError } = useVaultStore();
  const isUninitialized = !status || status.status === 'uninitialized';
  const canUseRecoveryKey = !isUninitialized;

  const [passphrase, setPassphrase] = useState('');
  const [confirm, setConfirm] = useState('');
  const [recoveryKey, setRecoveryKey] = useState('');
  const [showPass, setShowPass] = useState(false);
  const [localError, setLocalError] = useState('');
  const [unlockMode, setUnlockMode] = useState<'passphrase' | 'recovery'>('passphrase');

  const extractError = (error: unknown): { code?: string; message: string } => {
    if (error && typeof error === 'object') {
      const code = 'code' in error ? String((error as { code: unknown }).code) : undefined;
      const message = 'message' in error
        ? String((error as { message: unknown }).message)
        : String(error);
      return { code, message };
    }
    return { message: String(error) };
  };

  const handleClose = () => {
    setPassphrase('');
    setConfirm('');
    setRecoveryKey('');
    setShowPass(false);
    setUnlockMode('passphrase');
    setLocalError('');
    clearError();
    onClose();
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLocalError('');
    clearError();

    if (isUninitialized) {
      if (passphrase.length < PASSPHRASE_MIN_LENGTH) {
        setLocalError(`Passphrase must be at least ${PASSPHRASE_MIN_LENGTH} characters.`);
        return;
      }
      if (passphrase !== confirm) {
        setLocalError('Passphrases do not match.');
        return;
      }
      try {
        await initialize(passphrase);
        handleClose();
      } catch (e: unknown) {
        const { message } = extractError(e);
        setLocalError(message || 'Failed to create vault.');
      }
    } else if (unlockMode === 'recovery') {
      if (!recoveryKey.trim()) {
        setLocalError('Recovery key is required.');
        return;
      }
      try {
        await unlockWithRecoveryKey(recoveryKey.trim());
        handleClose();
      } catch (e: unknown) {
        const { code, message } = extractError(e);
        const parts = [code, message].filter(Boolean);
        setLocalError(parts.join(': ') || 'Failed to unlock with recovery key.');
      }
    } else {
      try {
        await unlock(passphrase);
        handleClose();
      } catch (e: unknown) {
        const { code, message } = extractError(e);
        const parts = [code, message].filter(Boolean);
        const raw = parts.join(': ');
        setLocalError(
          code === 'wrong_passphrase' ? 'Incorrect passphrase.' : raw || 'Failed to unlock vault.'
        );
      }
    }
  };

  const title = isUninitialized ? 'Create Vault' : 'Unlock Vault';
  const subtitle = isUninitialized
    ? 'Set a strong passphrase to protect your credentials.'
    : unlockMode === 'recovery'
      ? 'Enter your recovery key to unlock the vault.'
      : 'Enter your vault passphrase to access credentials.';

  return (
    <UnlockModalShell
      isOpen={isOpen}
      onClose={handleClose}
      title={title}
      subtitle={subtitle}
      mode={canUseRecoveryKey ? unlockMode : undefined}
      modeOptions={canUseRecoveryKey ? [
        { value: 'passphrase', label: 'Passphrase' },
        { value: 'recovery', label: 'Recovery Key' },
      ] : undefined}
      onModeChange={canUseRecoveryKey ? setUnlockMode : undefined}
      hintText={
        canUseRecoveryKey && unlockMode === 'passphrase'
          ? <>Forgot passphrase? Switch to <span className="text-[var(--color-app-text)] font-medium">Recovery Key</span>.</>
          : undefined
      }
      error={localError}
      isSubmitting={isLoading}
      submitDisabled={
        isLoading ||
        (unlockMode === 'recovery'
          ? !recoveryKey.trim()
          : !passphrase || (isUninitialized && !confirm))
      }
      submitLabel={
        isLoading ? 'Please wait…' : isUninitialized ? 'Create Vault' : unlockMode === 'recovery' ? 'Unlock with Key' : 'Unlock'
      }
      onSubmit={handleSubmit}
      details={!isUninitialized ? (
        <div className="rounded-lg border border-[var(--color-app-border)]/50 bg-[var(--color-app-surface)]/20 p-3 text-[11px] text-[var(--color-app-muted)] leading-relaxed">
          <div className="flex items-center gap-2 text-[var(--color-app-text)] mb-1">
            <KeyRound size={12} />
            Security note
          </div>
          This unlocks your local vault on this device. Your passphrase or recovery key is never uploaded.
        </div>
      ) : undefined}
    >
      {unlockMode === 'recovery' && canUseRecoveryKey ? (
        <SecretField
          label="Recovery Key"
          value={recoveryKey}
          onChange={setRecoveryKey}
          showSecret={showPass}
          onToggleShow={() => setShowPass((v) => !v)}
          autoFocus
          placeholder="Enter recovery key"
        />
      ) : (
        <SecretField
          label="Passphrase"
          value={passphrase}
          onChange={setPassphrase}
          showSecret={showPass}
          onToggleShow={() => setShowPass((v) => !v)}
          autoFocus
          placeholder={isUninitialized ? 'Create a strong passphrase' : 'Enter passphrase'}
        />
      )}

      {isUninitialized && unlockMode === 'passphrase' && (
        <Input
          label="Confirm Passphrase"
          type={showPass ? 'text' : 'password'}
          value={confirm}
          onChange={(e) => setConfirm(e.target.value)}
          placeholder="Repeat your passphrase"
        />
      )}
    </UnlockModalShell>
  );
}
