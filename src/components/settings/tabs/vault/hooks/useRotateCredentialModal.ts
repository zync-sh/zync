import { useMemo, useRef, useState } from 'react';
import { vaultIpc, type VaultItem } from '../../../../../vault/ipc';
import type { ToastType } from '../../../../../store/toastSlice';
import type { Connection } from '../../../../../features/connections/domain/types';

interface UseRotateCredentialModalOptions {
  items: VaultItem[];
  connections: Connection[];
  showToast: (type: ToastType, message: string) => void;
  onRotated: () => Promise<void>;
  onPromptDisconnect: (affectedIds: string[], actionLabel: string) => Promise<void>;
}

const extractErrorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

export function useRotateCredentialModal({
  items,
  connections,
  showToast,
  onRotated,
  onPromptDisconnect,
}: UseRotateCredentialModalOptions) {
  const [itemId, setItemId] = useState<string | null>(null);
  const [label, setLabel] = useState('');
  const [secret, setSecret] = useState('');
  const [passphrase, setPassphrase] = useState('');
  const [notes, setNotes] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const currentOpenRequestTokenRef = useRef<symbol | null>(null);

  const item = useMemo(
    () => items.find(i => i.id === itemId) ?? null,
    [items, itemId],
  );

  const open = async (id: string) => {
    const found = items.find(i => i.id === id);
    if (!found) return;
    const requestToken = Symbol('rotate-credential-open');
    setItemId(found.id);
    setLabel(found.label);
    setSecret('');
    setPassphrase('');
    setNotes('');
    currentOpenRequestTokenRef.current = requestToken;
    try {
      const full = await vaultIpc.itemGet(found.id);
      if (currentOpenRequestTokenRef.current !== requestToken) return;
      setNotes(full.notes || '');
    } catch (error: unknown) {
      if (currentOpenRequestTokenRef.current !== requestToken) return;
      console.warn('[Vault] Failed to load item for rotation:', error);
      const msg = extractErrorMessage(error);
      showToast('error', `Failed to load vault item notes: ${msg}`);
    } finally {
      if (currentOpenRequestTokenRef.current === requestToken) {
        currentOpenRequestTokenRef.current = null;
      }
    }
  };

  const close = () => {
    if (isLoading) return;
    currentOpenRequestTokenRef.current = null;
    setItemId(null);
    setLabel('');
    setSecret('');
    setPassphrase('');
    setNotes('');
  };

  const submit = async () => {
    if (isLoading) return;
    if (!item) return;

    const trimmedLabel = label.trim();
    const trimmedSecret = secret.trim();
    const trimmedPassphrase = passphrase.trim();

    if (!trimmedLabel) {
      showToast('error', 'Credential label is required.');
      return;
    }
    if (!trimmedSecret) {
      showToast('error', 'New credential secret is required.');
      return;
    }

    const secretValues: Record<string, string> =
      item.kind === 'ssh-private-key'
        ? {
            privateKey: secret,
            ...(trimmedPassphrase ? { passphrase } : {}),
          }
        : { password: secret };

    setIsLoading(true);
    try {
      const affectedConnectionIds = connections
        .filter(c =>
          c.authRef?.credentialId === item.logicalId ||
          c.authRef?.itemId === item.id
        )
        .map(c => c.id);

      await vaultIpc.itemUpdate(
        item.id,
        trimmedLabel,
        item.kind,
        secretValues,
        notes.trim() || undefined,
      );
      await onRotated();
      close();
      showToast('success', `Rotated "${trimmedLabel}". Hosts keep the same credential identity.`);
      await onPromptDisconnect(affectedConnectionIds, `Rotating "${trimmedLabel}"`);
    } catch (e: unknown) {
      const msg = extractErrorMessage(e);
      showToast('error', `Failed to rotate credential: ${msg}`);
    } finally {
      setIsLoading(false);
    }
  };

  return {
    isOpen: Boolean(itemId),
    item,
    label,
    secret,
    passphrase,
    notes,
    isLoading,
    open,
    close,
    setLabel,
    setSecret,
    setPassphrase,
    setNotes,
    submit,
  };
}