import { AlertTriangle } from 'lucide-react';
import type { SyncRestoreConflictItem } from '../../../../vault/syncIpc';
import { Button } from '../../../ui/Button';
import { Modal } from '../../../ui/Modal';

interface RestoreConflictModalProps {
  isOpen: boolean;
  isSubmitting: boolean;
  conflicts: SyncRestoreConflictItem[];
  selectedLogicalIds: string[];
  onClose: () => void;
  onToggleLogicalId: (logicalId: string) => void;
  onSelectAll: () => void;
  onClearAll: () => void;
  onConfirmRestore: () => void;
}

function formatTimestamp(unixSecs: number): string {
  if (!Number.isFinite(unixSecs) || unixSecs < 0) return '—';
  return new Date(unixSecs * 1000).toLocaleString();
}

export function RestoreConflictModal({
  isOpen,
  isSubmitting,
  conflicts,
  selectedLogicalIds,
  onClose,
  onToggleLogicalId,
  onSelectAll,
  onClearAll,
  onConfirmRestore,
}: RestoreConflictModalProps) {
  const selectedSet = new Set(selectedLogicalIds);

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      title="Restore Conflicts Detected"
      subtitle="These credentials have the same revision/timestamp locally and remotely but different payloads. Choose which ones should use remote data."
      width="max-w-3xl"
    >
      <div className="space-y-4">
        <div className="rounded-lg border border-amber-400/35 bg-amber-500/10 px-3 py-2.5">
          <div className="flex items-start gap-2">
            <AlertTriangle size={14} className="text-amber-300 mt-0.5 shrink-0" />
            <p className="text-xs text-amber-200/90 leading-relaxed">
              Unchecked items will keep local values. Checked items will apply remote values during restore.
            </p>
          </div>
        </div>

        <div className="flex items-center justify-between gap-2">
          <p className="text-xs text-app-muted">
            {conflicts.length} conflict item{conflicts.length === 1 ? '' : 's'} · {selectedLogicalIds.length} selected for remote apply
          </p>
          <div className="flex items-center gap-2">
            <Button variant="ghost" size="sm" onClick={onSelectAll} disabled={isSubmitting}>
              Select all
            </Button>
            <Button variant="ghost" size="sm" onClick={onClearAll} disabled={isSubmitting}>
              Clear
            </Button>
          </div>
        </div>

        <div className="rounded-xl border border-app-border/60 bg-app-surface/25 divide-y divide-app-border/30 max-h-[420px] overflow-y-auto">
          {conflicts.map(conflict => {
            const checked = selectedSet.has(conflict.logicalId);
            return (
              <label
                key={conflict.logicalId}
                className="flex items-start gap-3 px-4 py-3 cursor-pointer hover:bg-app-surface/35"
              >
                <input
                  type="checkbox"
                  checked={checked}
                  disabled={isSubmitting}
                  onChange={() => onToggleLogicalId(conflict.logicalId)}
                  className="mt-0.5 h-4 w-4 rounded border-app-border bg-app-surface text-app-accent focus:ring-app-accent"
                />
                <div className="min-w-0">
                  <p className="text-sm text-app-text font-medium truncate">
                    {conflict.label}
                    <span className="ml-2 text-xs text-app-muted">{conflict.kind}</span>
                  </p>
                  <p className="text-[11px] text-app-muted mt-0.5 break-all">
                    {conflict.logicalId}
                  </p>
                  <p className="text-[11px] text-app-muted/80 mt-1">
                    Local rev {conflict.localRevision} ({formatTimestamp(conflict.localUpdatedAt)})
                    {' '}vs Remote rev {conflict.remoteRevision} ({formatTimestamp(conflict.remoteUpdatedAt)})
                  </p>
                </div>
              </label>
            );
          })}
        </div>

        <div className="flex items-center justify-end gap-2 pt-1">
          <Button variant="ghost" size="sm" onClick={onClose} disabled={isSubmitting}>
            Cancel
          </Button>
          <Button size="sm" onClick={onConfirmRestore} disabled={isSubmitting}>
            {isSubmitting ? 'Restoring…' : 'Restore with selection'}
          </Button>
        </div>
      </div>
    </Modal>
  );
}
