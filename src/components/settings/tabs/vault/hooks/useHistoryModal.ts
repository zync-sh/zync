import { useMemo, useState } from 'react';
import { vaultIpc, type RevisionMeta, type VaultItem } from '../../../../../vault/ipc';
import type { ToastType } from '../../../../../store/toastSlice';
import type { Connection } from '../../../../../features/connections/domain/types';

interface UseHistoryModalOptions {
  items: VaultItem[];
  connections: Connection[];
  showToast: (type: ToastType, message: string) => void;
  showConfirmDialog: (opts: {
    title: string;
    message: string;
    confirmText: string;
  }) => Promise<boolean>;
  onRestored: () => Promise<void>;
  onPromptDisconnect: (affectedIds: string[], actionLabel: string) => Promise<void>;
}

const getErrorMessage = (e: unknown): string =>
  e && typeof e === 'object' && 'message' in e
    ? String((e as { message: unknown }).message)
    : String(e);

export function useHistoryModal({
  items,
  connections,
  showToast,
  showConfirmDialog,
  onRestored,
  onPromptDisconnect,
}: UseHistoryModalOptions) {
  const [itemId, setItemId] = useState<string | null>(null);
  const [revisions, setRevisions] = useState<RevisionMeta[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [isRestoring, setIsRestoring] = useState(false);

  const item = useMemo(
    () => items.find(i => i.id === itemId) ?? null,
    [items, itemId],
  );

  const open = async (id: string) => {
    setItemId(id);
    setRevisions([]);
    setIsLoading(true);
    try {
      const result = await vaultIpc.itemRevisionHistory(id);
      setRevisions(result);
    } catch (e: unknown) {
      showToast('error', `Failed to load history: ${getErrorMessage(e)}`);
    } finally {
      setIsLoading(false);
    }
  };

  const close = () => {
    if (isRestoring) return;
    setItemId(null);
    setRevisions([]);
  };

  const restore = async (revision: number) => {
    if (isRestoring) return;
    if (!item) return;

    const confirmed = await showConfirmDialog({
      title: 'Restore Previous Revision',
      message: `Restore revision ${revision} of "${item.label}"? The current secret will be saved to history first.`,
      confirmText: 'Restore',
    });
    if (!confirmed) return;

    setIsRestoring(true);
    try {
      const affectedConnectionIds = connections
        .filter(c => {
          const hasCredentialIdMatch =
            c.authRef?.credentialId != null &&
            item.logicalId != null &&
            c.authRef.credentialId === item.logicalId;
          const hasItemIdMatch =
            c.authRef?.itemId != null &&
            item.id != null &&
            c.authRef.itemId === item.id;
          return hasCredentialIdMatch || hasItemIdMatch;
        })
        .map(c => c.id);

      try {
        await vaultIpc.itemRestoreRevision(item.id, revision);
      } catch (e: unknown) {
        showToast('error', `Failed to restore revision: ${getErrorMessage(e)}`);
        return;
      }

      showToast(
        'success',
        `Restored revision ${revision} of "${item.label}". Hosts keep the same credential identity.`,
      );
      try {
        await onRestored();
        // Reload history so the modal reflects the new state.
        const updated = await vaultIpc.itemRevisionHistory(item.id);
        setRevisions(updated);
        await onPromptDisconnect(affectedConnectionIds, `Restoring "${item.label}"`);
      } catch (e: unknown) {
        showToast('error', `Restored revision, but post-restore refresh failed: ${getErrorMessage(e)}`);
      }
    } finally {
      setIsRestoring(false);
    }
  };

  return {
    isOpen: Boolean(itemId),
    item,
    revisions,
    isLoading,
    isRestoring,
    open,
    close,
    restore,
  };
}
