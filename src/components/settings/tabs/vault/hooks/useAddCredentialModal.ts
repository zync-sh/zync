import { useState } from 'react';
import { vaultIpc } from '../../../../../vault/ipc';
import type { ToastType } from '../../../../../store/toastSlice';

interface UseAddCredentialModalOptions {
  isUnlocked: boolean;
  showToast: (type: ToastType, message: string) => void;
  onCreated: () => Promise<void>;
}

export function useAddCredentialModal({
  isUnlocked,
  showToast,
  onCreated,
}: UseAddCredentialModalOptions) {
  const [isOpen, setIsOpen] = useState(false);
  const [kind, setKind] = useState<'ssh-private-key' | 'ssh-password'>('ssh-private-key');
  const [label, setLabel] = useState('');
  const [secret, setSecret] = useState('');
  const [passphrase, setPassphrase] = useState('');
  const [notes, setNotes] = useState('');
  const [isCreating, setIsCreating] = useState(false);

  const reset = () => {
    setKind('ssh-private-key');
    setLabel('');
    setSecret('');
    setPassphrase('');
    setNotes('');
  };

  const open = () => setIsOpen(true);

  const close = () => {
    if (isCreating) return;
    setIsOpen(false);
    reset();
  };

  const submit = async () => {
    if (!isUnlocked) {
      showToast('error', 'Unlock the vault before adding credentials.');
      return;
    }

    const trimmedLabel = label.trim();
    const trimmedSecret = secret.trim();
    const trimmedPassphrase = passphrase.trim();

    if (!trimmedLabel) {
      showToast('error', 'Credential label is required.');
      return;
    }
    if (!trimmedSecret) {
      showToast('error', 'Credential secret is required.');
      return;
    }

    const secretToSave =
      kind === 'ssh-private-key' && trimmedPassphrase
        ? JSON.stringify({ key: trimmedSecret, passphrase: trimmedPassphrase })
        : trimmedSecret;

    setIsCreating(true);
    try {
      const item = await vaultIpc.itemCreate(
        trimmedLabel,
        kind,
        secretToSave,
        notes.trim() || undefined,
      );
      await onCreated();
      setIsOpen(false);
      reset();
      showToast('success', `Added "${item.label}" to Vault. You can now assign it to hosts.`);
    } catch (e: unknown) {
      const msg = String((e as { message?: unknown } | null | undefined)?.message ?? e);
      showToast('error', `Failed to add credential: ${msg}`);
    } finally {
      setIsCreating(false);
    }
  };

  return {
    isOpen,
    kind,
    label,
    secret,
    passphrase,
    notes,
    isCreating,
    open,
    close,
    setKind,
    setLabel,
    setSecret,
    setPassphrase,
    setNotes,
    submit,
  };
}
