import { History, RotateCcw } from 'lucide-react';
import { useMemo } from 'react';
import type { RevisionMeta, VaultItem } from '../../../../vault/ipc';
import { Button } from '../../../ui/Button';
import { Modal } from '../../../ui/Modal';

interface CredentialHistoryModalProps {
  isOpen: boolean;
  item: VaultItem | null;
  history: RevisionMeta[];
  isLoading: boolean;
  isRestoring: boolean;
  onClose: () => void;
  onRestore: (revision: number) => void;
}

function formatTimestamp(unixSecs: number): string {
  if (!Number.isFinite(unixSecs) || unixSecs <= 0) return '—';
  return new Date(unixSecs * 1000).toLocaleString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function kindLabel(kind: string): string {
  switch (kind) {
    case 'ssh-private-key': return 'SSH Key';
    case 'ssh-password': return 'Password';
    case 'ssh-agent-key': return 'Agent Key';
    default: return kind;
  }
}

export function CredentialHistoryModal({
  isOpen,
  item,
  history,
  isLoading,
  isRestoring,
  onClose,
  onRestore,
}: CredentialHistoryModalProps) {
  // Memoize the reversed array so we don't allocate on every render.
  const sortedHistory = useMemo(() => [...history].reverse(), [history]);
  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      title={item ? `History — "${item.label}"` : 'Credential History'}
      subtitle="Previous revisions of this credential. Restoring a revision re-encrypts it as the new current value."
      width="max-w-lg"
    >
      <div className="space-y-4">
        {/* Current revision */}
        {item && (
          <div className="rounded-lg border border-app-accent/30 bg-app-accent/5 px-3 py-2.5">
            <div className="flex items-center justify-between gap-2">
              <div className="min-w-0">
                <p className="text-xs font-semibold text-app-text">
                  Current — revision {item.revision}
                </p>
                <p className="text-[11px] text-app-muted mt-0.5">
                  {kindLabel(item.kind)} · updated {formatTimestamp(item.updatedAt)}
                </p>
              </div>
              <span className="shrink-0 text-[10px] font-medium text-app-accent bg-app-accent/10 px-2 py-0.5 rounded-full">
                Active
              </span>
            </div>
          </div>
        )}

        {/* History list */}
        {isLoading ? (
          <div className="py-8 text-center">
            <p className="text-sm text-app-muted">Loading history…</p>
          </div>
        ) : history.length === 0 ? (
          <div className="rounded-xl border border-app-border/40 bg-app-surface/15 py-8 text-center">
            <History size={20} className="mx-auto mb-2 text-app-muted/40" />
            <p className="text-sm text-app-muted">No previous revisions</p>
            <p className="text-xs text-app-muted/60 mt-1">
              Revision history is recorded from the next rotation onwards.
            </p>
          </div>
        ) : (
          <div className="space-y-1">
            <p className="text-[10px] font-bold text-app-muted uppercase tracking-[0.15em] opacity-40 px-1 mb-2">
              Previous revisions — newest first
            </p>
            <div className="rounded-xl border border-app-border/60 bg-app-surface/25 divide-y divide-app-border/30 max-h-72 overflow-y-auto">
              {sortedHistory.map((rev) => (
                <div
                  key={`${rev.itemId}-${rev.revision}`}
                  className="flex items-center justify-between px-4 py-3 gap-3 group"
                >
                  <div className="min-w-0">
                    <p className="text-sm text-app-text font-medium truncate">
                      {rev.label}
                      <span className="ml-2 text-xs font-normal text-app-muted">
                        rev {rev.revision}
                      </span>
                    </p>
                    <p className="text-[11px] text-app-muted mt-0.5">
                      {kindLabel(rev.kind)} · rotated {formatTimestamp(rev.rotatedAt)}
                    </p>
                  </div>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => onRestore(rev.revision)}
                    disabled={isRestoring}
                    className="shrink-0 h-7 gap-1 px-2 text-[11px] md:opacity-0 md:group-hover:opacity-100 focus:opacity-100 transition-opacity"
                    title={`Restore revision ${rev.revision}`}
                    aria-label={`Restore revision ${rev.revision} of ${rev.label}`}
                  >
                    <RotateCcw size={11} />
                    Restore
                  </Button>
                </div>
              ))}
            </div>
          </div>
        )}

        <div className="flex justify-end pt-1">
          <Button variant="ghost" size="sm" onClick={onClose} disabled={isRestoring}>
            Close
          </Button>
        </div>
      </div>
    </Modal>
  );
}
