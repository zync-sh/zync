import { History, Plus, Search, Trash2, Upload } from 'lucide-react';
import type { VaultItem } from '../../../../vault/ipc';
import {
  getCredentialKindLabel,
  isHostAssignableCredentialKind,
} from '../../../../vault/credentialTypes';
import { Button } from '../../../ui/Button';

interface VaultItemsPanelProps {
  items: VaultItem[];
  filteredItems: VaultItem[];
  itemSearch: string;
  duplicateCount: number;
  isDeduplicating: boolean;
  onItemSearchChange: (value: string) => void;
  onDeduplicate: () => void;
  onAddCredential: () => void;
  onInspect: (itemId: string) => void;
  onAssign: (itemId: string) => void;
  onRotate: (itemId: string) => void;
  onHistory: (itemId: string) => void;
  onDelete: (itemId: string, label: string) => void;
  onSyncItem: (itemId: string, label: string) => void;
  canSyncItems: boolean;
  syncingItemId?: string | null;
  assignedHostCounts: Record<string, number>;
}

export function VaultItemsPanel({
  items,
  filteredItems,
  itemSearch,
  duplicateCount,
  isDeduplicating,
  onItemSearchChange,
  onDeduplicate,
  onAddCredential,
  onInspect,
  onAssign,
  onRotate,
  onHistory,
  onDelete,
  onSyncItem,
  canSyncItems,
  syncingItemId,
  assignedHostCounts,
}: VaultItemsPanelProps) {
  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between px-1">
        <h4 className="text-xs font-semibold uppercase tracking-wider text-app-muted">
          Stored Items
          <span className="ml-2 normal-case font-normal text-app-muted/60">
            {itemSearch ? `${filteredItems.length} of ${items.length}` : items.length}
          </span>
        </h4>
        <div className="flex items-center gap-2">
          {duplicateCount > 0 && (
            <button
              type="button"
              onClick={onDeduplicate}
              disabled={isDeduplicating}
              className="flex items-center gap-1 text-[11px] text-amber-400/80 hover:text-amber-300 transition-colors disabled:opacity-50"
            >
              {duplicateCount} duplicate{duplicateCount > 1 ? 's' : ''} — clean up
            </button>
          )}
          <Button
            variant="secondary"
            size="sm"
            onClick={onAddCredential}
            className="h-7 gap-1.5 text-[11px]"
          >
            <Plus size={12} />
            Add Credential
          </Button>
        </div>
      </div>
      {items.length === 0 ? (
        <div className="rounded-xl border border-[var(--color-app-border)]/40 bg-[var(--color-app-surface)]/15 py-8 text-center">
          <p className="text-sm text-[var(--color-app-muted)]">No items in vault</p>
          <p className="text-xs text-[var(--color-app-muted)]/60 mt-1">
            Add a credential here first, or secure existing connection credentials to vault.
          </p>
        </div>
      ) : (
        <>
          <div className="relative">
            <Search size={13} className="absolute left-3 top-1/2 -translate-y-1/2 text-app-muted/50 pointer-events-none" />
            <input
              aria-label="Search vault items"
              type="text"
              placeholder="Search items…"
              value={itemSearch}
              onChange={(event) => onItemSearchChange(event.target.value)}
              className="w-full rounded-lg border border-app-border/60 bg-app-surface/25 pl-8 pr-3 py-2 text-xs text-app-text placeholder:text-app-muted/50 focus:outline-none focus:ring-1 focus:ring-app-accent/50"
            />
          </div>
          <div className="rounded-xl border border-app-border/60 bg-app-surface/25 divide-y divide-app-border/30">
            {filteredItems.length === 0 ? (
              <div className="py-6 text-center">
                <p className="text-xs text-app-muted">No items match &quot;{itemSearch}&quot;</p>
              </div>
            ) : (
              filteredItems.map((item) => (
                <div
                  key={item.id}
                  className="flex items-center justify-between px-4 py-3 group transition-colors hover:bg-app-surface/20"
                >
                  <div className="min-w-0">
                    <button
                      type="button"
                      onClick={() => onInspect(item.id)}
                      aria-label={`Inspect ${item.label}`}
                      title={`Inspect ${item.label}`}
                      className="block min-w-0 rounded-sm text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-app-accent/40 focus-visible:ring-offset-2 focus-visible:ring-offset-app-panel"
                    >
                      <p className="text-sm text-app-text font-medium truncate hover:text-app-accent transition-colors">
                        {item.label}
                      </p>
                    </button>
                    <div className="mt-1 flex flex-wrap items-center gap-1.5">
                      <span className="text-xs text-app-muted">
                        {getCredentialKindLabel(item.kind)}
                      </span>
                      {item.hasPassphraseField && (
                        <span className="rounded-full border border-amber-500/25 bg-amber-500/10 px-1.5 py-0.5 text-[10px] text-amber-300">
                          Passphrase attached
                        </span>
                      )}
                      {item.secretFieldCount > 1 && (
                        <span className="rounded-full border border-sky-500/25 bg-sky-500/10 px-1.5 py-0.5 text-[10px] text-sky-300">
                          {item.secretFieldCount} secret fields
                        </span>
                      )}
                      <span className="rounded-full border border-app-border/50 bg-app-surface/20 px-1.5 py-0.5 text-[10px] text-app-muted">
                        {assignedHostCounts[item.logicalId] ?? 0} host{(assignedHostCounts[item.logicalId] ?? 0) === 1 ? '' : 's'}
                      </span>
                      <span className="rounded-full border border-app-border/50 bg-app-surface/20 px-1.5 py-0.5 text-[10px] text-app-muted">
                        rev {item.revision}
                      </span>
                    </div>
                  </div>
                  <div className="flex flex-wrap items-center justify-end gap-1">
                    {isHostAssignableCredentialKind(item.kind) && (
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => onAssign(item.id)}
                        className="h-7 gap-1 px-2 text-[11px]"
                      >
                        Assign
                      </Button>
                    )}
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => onSyncItem(item.id, item.label)}
                      disabled={!canSyncItems || syncingItemId != null}
                      className="h-7 gap-1 px-2 text-[11px]"
                      title={
                        syncingItemId === item.id
                          ? 'Syncing to cloud provider'
                          : canSyncItems
                            ? 'Sync credential to cloud provider'
                            : 'Connect provider + set up Google encryption first'
                      }
                      aria-label={syncingItemId === item.id ? `Syncing ${item.label}` : `Sync ${item.label}`}
                    >
                      <Upload size={12} />
                      {syncingItemId === item.id ? 'Syncing…' : 'Sync'}
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => onRotate(item.id)}
                      className="h-7 gap-1 px-2 text-[11px]"
                    >
                      Rotate
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => onHistory(item.id)}
                      className="h-7 gap-1 px-2 text-[11px]"
                      title="View revision history"
                      aria-label={`View history for ${item.label}`}
                    >
                      <History size={12} />
                      History
                    </Button>
                    <button
                      type="button"
                      onClick={() => onDelete(item.id, item.label)}
                      className="focus:opacity-100 focus-visible:opacity-100 focus:outline-none focus:ring-2 focus:ring-red-400/40 p-1.5 rounded-md text-[var(--color-app-muted)] hover:text-red-400 hover:bg-red-400/10 transition-all"
                      title="Delete item"
                      aria-label={`Delete ${item.label}`}
                    >
                      <Trash2 size={14} />
                    </button>
                  </div>
                </div>
              ))
            )}
          </div>
        </>
      )}
    </div>
  );
}
