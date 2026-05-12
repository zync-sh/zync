import { useState } from 'react';
import { Modal } from '../ui/Modal';
import { Input } from '../ui/Input';
import { Button } from '../ui/Button';
import { Shield, Lock, Eye, EyeOff } from 'lucide-react';
import { useVaultStore } from '../../vault/useVaultStore';

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
    <Modal isOpen={isOpen} onClose={handleClose} title={title} subtitle={subtitle} width="max-w-sm">
      <form onSubmit={handleSubmit} className="space-y-4">
        <div className="flex justify-center mb-2">
          <div className="w-12 h-12 rounded-full bg-[var(--color-app-accent)]/10 text-[var(--color-app-accent)] flex items-center justify-center">
            {isUninitialized ? <Shield size={22} /> : <Lock size={22} />}
          </div>
        </div>

        {canUseRecoveryKey && (
          <div className="flex gap-2 rounded-lg border border-[var(--color-app-border)]/50 bg-[var(--color-app-surface)]/20 p-1">
            <Button
              type="button"
              size="sm"
              variant={unlockMode === 'passphrase' ? 'primary' : 'ghost'}
              className="flex-1"
              onClick={() => setUnlockMode('passphrase')}
            >
              Passphrase
            </Button>
            <Button
              type="button"
              size="sm"
              variant={unlockMode === 'recovery' ? 'primary' : 'ghost'}
              className="flex-1"
              onClick={() => setUnlockMode('recovery')}
            >
              Recovery Key
            </Button>
          </div>
        )}

        {canUseRecoveryKey && unlockMode === 'passphrase' && (
          <p className="text-xs text-[var(--color-app-muted)]">
            Forgot passphrase? Switch to <span className="text-[var(--color-app-text)] font-medium">Recovery Key</span>.
          </p>
        )}

        {unlockMode === 'recovery' && canUseRecoveryKey ? (
          <Input
            label="Recovery Key"
            type={showPass ? 'text' : 'password'}
            value={recoveryKey}
            onChange={(e) => setRecoveryKey(e.target.value)}
            autoFocus
            placeholder="Enter recovery key"
            rightElement={
              <button
                type="button"
                onClick={() => setShowPass((v) => !v)}
                aria-label={showPass ? 'Hide recovery key' : 'Show recovery key'}
                className="text-app-muted hover:text-app-text transition-colors"
              >
                {showPass ? <EyeOff size={14} /> : <Eye size={14} />}
              </button>
            }
          />
        ) : (
          <Input
            label="Passphrase"
            type={showPass ? 'text' : 'password'}
            value={passphrase}
            onChange={(e) => setPassphrase(e.target.value)}
            autoFocus
            placeholder={isUninitialized ? 'Create a strong passphrase' : 'Enter passphrase'}
            rightElement={
              <button
                type="button"
                onClick={() => setShowPass((v) => !v)}
                aria-label={showPass ? 'Hide password' : 'Show password'}
                className="text-app-muted hover:text-app-text transition-colors"
              >
                {showPass ? <EyeOff size={14} /> : <Eye size={14} />}
              </button>
            }
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

        {localError && (
          <p className="text-xs text-red-400">{localError}</p>
        )}

        <div className="flex gap-2 pt-1">
          <Button type="button" variant="ghost" onClick={handleClose} className="flex-1">
            Cancel
          </Button>
          <Button
            type="submit"
            disabled={
              isLoading ||
              (unlockMode === 'recovery'
                ? !recoveryKey
                : !passphrase || (isUninitialized && !confirm))
            }
            className="flex-1"
          >
            {isLoading ? 'Please wait…' : isUninitialized ? 'Create Vault' : unlockMode === 'recovery' ? 'Unlock with Key' : 'Unlock'}
          </Button>
        </div>
      </form>
    </Modal>
  );
}
