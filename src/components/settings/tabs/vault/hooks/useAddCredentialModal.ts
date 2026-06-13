import { useRef, useState } from 'react';
import { vaultIpc } from '../../../../../vault/ipc';
import type { ToastType } from '../../../../../store/toastSlice';
import {
  isSupportedCreateCredentialKind,
  type SupportedCreateCredentialKind,
} from '../../../../../vault/credentialTypes';

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
  const [kind, setKind] = useState<SupportedCreateCredentialKind>('ssh-private-key');
  const [label, setLabel] = useState('');
  const [secret, setSecret] = useState('');
  const [passphrase, setPassphrase] = useState('');
  const [notes, setNotes] = useState('');
  const [isCreating, setIsCreating] = useState(false);
  const creatingRef = useRef(false);

  const reset = () => {
    setKind('ssh-private-key');
    setLabel('');
    setSecret('');
    setPassphrase('');
    setNotes('');
  };

  const open = () => setIsOpen(true);

  const close = () => {
    if (creatingRef.current || isCreating) return;
    setIsOpen(false);
    reset();
  };

  const submit = async () => {
    if (creatingRef.current) return;

    if (!isUnlocked) {
      showToast('error', 'Unlock the vault before adding credentials.');
      return;
    }

    const trimmedLabel = label.trim();
    const rawSecret = secret;
    const rawPassphrase = passphrase;

    if (!isSupportedCreateCredentialKind(kind)) {
      showToast('error', 'This credential type is not ready yet.');
      return;
    }

    if (!trimmedLabel) {
      showToast('error', 'Credential label is required.');
      return;
    }
    if (!rawSecret.trim()) {
      showToast('error', 'Credential secret is required.');
      return;
    }

    const secretValues: Record<string, string> =
      kind === 'ssh-private-key'
        ? {
            privateKey: rawSecret,
            ...(rawPassphrase.length > 0 ? { passphrase: rawPassphrase } : {}),
          }
        : { password: rawSecret };

    creatingRef.current = true;
    setIsCreating(true);
    try {
      const item = await vaultIpc.itemCreate(
        trimmedLabel,
        kind,
        secretValues,
        notes.trim() || undefined,
      );
      setIsOpen(false);
      reset();
      showToast('success', `Added "${item.label}" to Vault. You can now assign it to hosts.`);
      try {
        await onCreated();
      } catch (refreshError) {
        console.warn('[Vault] Post-create refresh failed:', refreshError);
        const refreshMessage =
          refreshError instanceof Error ? refreshError.message : String(refreshError);
        showToast('info', `Credential added, but refresh did not complete: ${refreshMessage}`);
      }
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      showToast('error', `Failed to add credential: ${msg}`);
    } finally {
      creatingRef.current = false;
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
