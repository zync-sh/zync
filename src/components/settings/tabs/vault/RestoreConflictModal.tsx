import { AlertTriangle, CheckCircle2 } from 'lucide-react';
import type { SyncRestoreConflictItem, SyncRestorePreviewResult } from '../../../../vault/syncIpc';
import { Button } from '../../../ui/Button';
import { Modal } from '../../../ui/Modal';

interface RestoreConflictModalProps {
  isOpen: boolean;
  isSubmitting: boolean;
  preview: SyncRestorePreviewResult | null;
  conflicts: SyncRestoreConflictItem[];
  selectedLogicalIds: string[];
  onClose: () => void;
  onToggleLogicalId: (logicalId: string) => void;
  onSelectAll: () => void;
  onClearAll: () => void;
  onConfirmRestore: () => void;
}

const PREVIEW_METRICS: Array<{ key: keyof SyncRestorePreviewResult; label: string }> = [
  { key: 'scanned', label: 'Scanned' },
  { key: 'restorable', label: 'New' },
  { key: 'updatable', label: 'Updates' },
  { key: 'tombstoned', label: 'Deletes' },
  { key: 'stale', label: 'Unchanged' },
  { key: 'failed', label: 'Failed' },
];

function formatTimestamp(unixSecs: number): string {
  if (!Number.isFinite(unixSecs) || unixSecs < 0) return '-';
  return new Date(unixSecs * 1000).toLocaleString();
}

export function RestoreConflictModal({
  isOpen,
  isSubmitting,
  preview,
  conflicts,
  selectedLogicalIds,
  onClose,
  onToggleLogicalId,
  onSelectAll,
  onClearAll,
  onConfirmRestore,
}: RestoreConflictModalProps) {
  const selectedSet = new Set(selectedLogicalIds);
  const hasConflicts = conflicts.length > 0;

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      title="Review Credential Restore"
      subtitle="Preview encrypted credential records before applying Google Drive changes to the local vault."
      width="max-w-3xl"
    >
      <div className="space-y-4">
        {preview && (
          <div className="grid grid-cols-3 gap-2 sm:grid-cols-6">
            {PREVIEW_METRICS.map(metric => (
              <div
                key={metric.key}
                className="rounded-lg border border-app-border/50 bg-app-surface/25 px-3 py-2"
              >
                <p className="text-[10px] uppercase tracking-[0.12em] text-app-muted">
                  {metric.label}
                </p>
                <p className="mt-1 text-sm font-semibold text-app-text">
                  {Number(preview[metric.key] ?? 0)}
                </p>
              </div>
            ))}
          </div>
        )}

        <div
          className={hasConflicts
            ? 'rounded-lg border border-amber-400/35 bg-amber-500/10 px-3 py-2.5'
            : 'rounded-lg border border-emerald-400/30 bg-emerald-500/10 px-3 py-2.5'}
        >
          <div className="flex items-start gap-2">
            {hasConflicts ? (
              <AlertTriangle size={14} className="text-amber-300 mt-0.5 shrink-0" />
            ) : (
              <CheckCircle2 size={14} className="text-emerald-300 mt-0.5 shrink-0" />
            )}
            <p
              className={hasConflicts
                ? 'text-xs text-amber-200/90 leading-relaxed'
                : 'text-xs text-emerald-200/90 leading-relaxed'}
            >
              {hasConflicts
                ? 'Unchecked conflicts keep local values. Checked conflicts apply remote values during restore.'
                : 'No credential conflicts detected. Restore will apply new, newer, and tombstone records only.'}
            </p>
          </div>
        </div>

        {hasConflicts && (
          <>
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
                        Local rev {conflict.localRevision} ({formatTimestamp(conflict.localUpdatedAt)}){' '}
                        vs Remote rev {conflict.remoteRevision} ({formatTimestamp(conflict.remoteUpdatedAt)})
                      </p>
                    </div>
                  </label>
                );
              })}
            </div>
          </>
        )}

        <div className="flex items-center justify-end gap-2 pt-1">
          <Button variant="ghost" size="sm" onClick={onClose} disabled={isSubmitting}>
            Cancel
          </Button>
          <Button size="sm" onClick={onConfirmRestore} disabled={isSubmitting}>
            {isSubmitting ? 'Restoring...' : hasConflicts ? 'Restore + Apply Selected' : 'Restore Credentials'}
          </Button>
        </div>
      </div>
    </Modal>
  );
}
