import { useMemo, useState } from 'react';
import { syncCredentialAssignments } from '../../../../../features/connections/domain';
import { saveConnectionsIpc } from '../../../../../features/connections/infrastructure/connectionPersistence';
import type { VaultItem } from '../../../../../vault/ipc';
import type { ToastType } from '../../../../../store/toastSlice';
import type { Connection, Folder } from '../../../../../features/connections/domain/types';

interface UseAssignCredentialModalOptions {
  items: VaultItem[];
  connections: Connection[];
  folders: Folder[];
  vaultId: string | null;
  showToast: (type: ToastType, message: string) => void;
  onAssigned: () => Promise<void>;
  onPromptDisconnect: (affectedIds: string[], actionLabel: string) => Promise<void>;
}

export function useAssignCredentialModal({
  items,
  connections,
  folders,
  vaultId,
  showToast,
  onAssigned,
  onPromptDisconnect,
}: UseAssignCredentialModalOptions) {
  const isValidItemKind = (
    value: unknown,
  ): value is NonNullable<Connection['authRef']>['itemKind'] =>
    value === 'ssh-private-key' || value === 'ssh-password';

  const [itemId, setItemId] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [selectedConnectionIds, setSelectedConnectionIds] = useState<string[]>([]);
  const [isAssigning, setIsAssigning] = useState(false);

  const item = useMemo(
    () => items.find(i => i.id === itemId) ?? null,
    [items, itemId],
  );

  const filteredConnections = useMemo(() => {
    const q = search.trim().toLowerCase();
    const assignable = connections.filter(c => c.id !== 'local');
    if (!q) return assignable;
    return assignable.filter(
      c =>
        c.name.toLowerCase().includes(q) ||
        c.host.toLowerCase().includes(q) ||
        c.username.toLowerCase().includes(q),
    );
  }, [connections, search]);

  const getConnectionIdsForCredential = (target: { id: string; logicalId: string }) =>
    connections
      .filter(
        c =>
          c.id !== 'local' &&
          (c.authRef?.credentialId === target.logicalId || c.authRef?.itemId === target.id),
      )
      .map(c => c.id);

  const open = (id: string) => {
    const found = items.find(i => i.id === id);
    if (!found) return;
    setItemId(found.id);
    setSearch('');
    setSelectedConnectionIds(getConnectionIdsForCredential(found));
  };

  const close = () => {
    if (isAssigning) return;
    setItemId(null);
    setSearch('');
    setSelectedConnectionIds([]);
  };

  const toggleConnection = (connectionId: string) => {
    setSelectedConnectionIds(current =>
      current.includes(connectionId)
        ? current.filter(id => id !== connectionId)
        : [...current, connectionId],
    );
  };

  const selectAll = () =>
    setSelectedConnectionIds(filteredConnections.map(c => c.id));

  const clearAll = () => setSelectedConnectionIds([]);

  const submit = async () => {
    if (!item || !vaultId) {
      showToast('error', 'Unlock the vault before assigning credentials.');
      return;
    }

    setIsAssigning(true);
    try {
      if (!isValidItemKind(item.kind)) {
        showToast('error', `Unsupported credential kind: ${String(item.kind)}`);
        return;
      }

      const previouslyAssignedIds = getConnectionIdsForCredential(item);

      const affectedConnectionIds = [
        ...new Set([...previouslyAssignedIds, ...selectedConnectionIds]),
      ];

      const nextConnections = syncCredentialAssignments(
        connections,
        selectedConnectionIds,
        {
          vaultId,
          credentialId: item.logicalId,
          itemId: item.id,
          itemKind: item.kind,
          purpose: 'ssh-auth',
        },
      );

      await saveConnectionsIpc(nextConnections, folders);
      await onAssigned();
      close();
      showToast(
        'success',
        `Updated assignments for "${item.label}" across ${affectedConnectionIds.length} host${affectedConnectionIds.length === 1 ? '' : 's'}.`,
      );
      await onPromptDisconnect(
        affectedConnectionIds,
        `Updating assignments for "${item.label}"`,
      );
    } catch (e: unknown) {
      const msg = String((e as { message?: unknown } | null | undefined)?.message ?? e);
      showToast('error', `Failed to assign credential: ${msg}`);
    } finally {
      setIsAssigning(false);
    }
  };

  return {
    isOpen: Boolean(itemId),
    item,
    search,
    selectedConnectionIds,
    filteredConnections,
    isAssigning,
    open,
    close,
    setSearch,
    toggleConnection,
    selectAll,
    clearAll,
    submit,
  };
}
