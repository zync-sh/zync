import { History, Plus, Search, Trash2, Upload } from 'lucide-react';
import type { VaultItem } from '../../../../vault/ipc';
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
  onAssign: (itemId: string) => void;
  onRotate: (itemId: string) => void;
  onHistory: (itemId: string) => void;
  onDelete: (itemId: string, label: string) => void;
  onSyncItem: (itemId: string, label: string) => void;
  canSyncItems: boolean;
  syncingItemId?: string | null;
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
  onAssign,
  onRotate,
  onHistory,
  onDelete,
  onSyncItem,
  canSyncItems,
  syncingItemId,
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
                <div key={item.id} className="flex items-center justify-between px-4 py-3 group">
                  <div className="min-w-0">
                    <p className="text-sm text-app-text font-medium truncate">{item.label}</p>
                    <p className="text-xs text-app-muted">
                      {item.kind} · {item.logicalId.slice(0, 8)} · {item.id.slice(0, 8)}
                    </p>
                  </div>
                  <div className="flex items-center gap-1 md:opacity-0 md:group-hover:opacity-100 focus-within:opacity-100 transition-opacity">
                    {(item.kind === 'ssh-private-key' || item.kind === 'ssh-password' || item.kind === 'ssh-agent-key') && (
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
                            : 'Connect provider + set up sync collection first'
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
