import type { ReactNode } from 'react';
import { KeyRound, ShieldCheck, ShieldEllipsis } from 'lucide-react';
import type { VaultItemDetail } from '../../../../vault/ipc';
import { getCredentialKindLabel, type CredentialField } from '../../../../vault/credentialTypes';
import type { Connection } from '../../../../features/connections/domain/types';
import { Button } from '../../../ui/Button';
import { Modal } from '../../../ui/Modal';

interface VaultCredentialDetailModalProps {
  isOpen: boolean;
  item: VaultItemDetail | null;
  assignedConnections: Connection[];
  isLoading: boolean;
  onClose: () => void;
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

function secretFieldSummary(fields: CredentialField[]): {
  primaryLabel: string;
  secretCount: number;
  hasPassphrase: boolean;
} {
  const secretFields = fields.filter(field => field.secret);
  return {
    primaryLabel: secretFields[0]?.label ?? 'Secret',
    secretCount: secretFields.length,
    hasPassphrase: secretFields.some(field => field.name === 'passphrase'),
  };
}

export function VaultCredentialDetailModal({
  isOpen,
  item,
  assignedConnections,
  isLoading,
  onClose,
}: VaultCredentialDetailModalProps) {
  const fields = item?.credential?.fields ?? [];
  const summary = secretFieldSummary(fields);

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      title={item ? `${item.label} Details` : 'Credential Details'}
      subtitle="Credential information and assigned hosts. Secret values stay inside the encrypted vault."
      width="max-w-2xl"
    >
      {isLoading ? (
        <div className="py-10 text-center text-sm text-app-muted">Loading credential details…</div>
      ) : !item ? (
        <div className="py-10 text-center text-sm text-app-muted">Credential details unavailable.</div>
      ) : (
        <div className="space-y-5">
          <div className="flex flex-wrap items-center gap-2">
            <span className="rounded-full border border-app-border/60 bg-app-surface/30 px-2.5 py-1 text-[11px] font-semibold text-app-text">
              {getCredentialKindLabel(item.kind)}
            </span>
            <span className="rounded-full border border-app-border/60 bg-app-surface/20 px-2.5 py-1 text-[11px] text-app-muted">
              Revision {item.revision}
            </span>
              {summary.hasPassphrase && (
                <span className="rounded-full border border-amber-500/25 bg-amber-500/10 px-2.5 py-1 text-[11px] text-amber-300">
                  Passphrase attached
              </span>
            )}
          </div>

          <div className="grid gap-3 sm:grid-cols-2">
            <InfoCard
              icon={<ShieldCheck size={14} />}
              title="Usage"
              lines={[
                `Assigned hosts: ${assignedConnections.length}`,
                `Primary secret: ${summary.primaryLabel}`,
                summary.hasPassphrase ? 'Passphrase protection: attached' : 'Passphrase protection: none',
              ]}
            />
            <InfoCard
              icon={<ShieldCheck size={14} />}
              title="Lifecycle"
              lines={[
                `Created: ${formatTimestamp(item.createdAt)}`,
                `Updated: ${formatTimestamp(item.updatedAt)}`,
                `Revision: ${item.revision}`,
              ]}
            />
          </div>

          <div className="rounded-xl border border-app-border/60 bg-app-surface/20 p-4">
            <p className="text-sm font-medium text-app-text">Assigned Hosts</p>
            <div className="mt-3 space-y-2">
              {assignedConnections.length === 0 ? (
                <p className="text-xs text-app-muted">No hosts currently reference this credential.</p>
              ) : (
                assignedConnections.map((connection) => (
                  <div
                    key={connection.id}
                    className="rounded-lg border border-app-border/40 bg-app-bg/30 px-3 py-2"
                  >
                    <p className="text-xs font-semibold text-app-text">{connection.name}</p>
                    <p className="mt-1 text-[11px] text-app-muted">
                      {connection.username}@{connection.host}:{connection.port}
                    </p>
                  </div>
                ))
              )}
            </div>
          </div>

          <div className="rounded-xl border border-app-border/60 bg-app-surface/20 p-4">
            <div className="flex items-center gap-2">
              <ShieldEllipsis size={14} className="text-app-muted" />
              <p className="text-sm font-medium text-app-text">Stored Fields</p>
            </div>
            <div className="mt-3 space-y-2">
              {fields.length === 0 ? (
                <p className="text-xs text-app-muted">No typed fields available.</p>
              ) : (
                fields.map((field) => (
                  <div
                    key={field.name}
                    className="rounded-lg border border-app-border/40 bg-app-bg/30 px-3 py-2"
                  >
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="text-xs font-semibold text-app-text">{field.label}</span>
                      <span className="rounded-full border border-app-border/50 bg-app-surface/20 px-2 py-0.5 text-[10px] text-app-muted">
                        {field.secret ? 'Encrypted secret field' : 'Plain metadata field'}
                      </span>
                      {field.required && (
                        <span className="rounded-full border border-app-border/50 bg-app-surface/20 px-2 py-0.5 text-[10px] text-app-muted">
                          Required
                        </span>
                      )}
                    </div>
                    <p className="mt-1 text-[11px] text-app-muted">
                      {field.valueRef
                        ? `Reference: ${field.valueRef}`
                        : !field.secret && field.value
                          ? `Value: ${field.value}`
                          : 'No inline value exposed'}
                    </p>
                  </div>
                ))
              )}
            </div>
          </div>

          {item.notes && (
            <div className="rounded-xl border border-app-border/60 bg-app-surface/20 p-4">
              <div className="flex items-center gap-2">
                <KeyRound size={14} className="text-app-muted" />
                <p className="text-sm font-medium text-app-text">Notes</p>
              </div>
              <p className="mt-2 text-xs leading-relaxed text-app-muted">{item.notes}</p>
            </div>
          )}

          <div className="rounded-xl border border-app-border/60 bg-app-bg/25 px-3 py-2">
            <p className="text-[11px] leading-relaxed text-app-muted">
              This view exposes only typed metadata, field references, revision state, and stable IDs.
              Secret bytes remain encrypted in the vault and are resolved only inside trusted Rust runtime paths.
            </p>
          </div>

          <div className="flex justify-end">
            <Button variant="ghost" size="sm" onClick={onClose}>
              Close
            </Button>
          </div>
        </div>
      )}
    </Modal>
  );
}

function InfoCard({
  icon,
  title,
  lines,
}: {
  icon: ReactNode;
  title: string;
  lines: string[];
}) {
  return (
    <div className="rounded-xl border border-app-border/60 bg-app-surface/20 p-4">
      <div className="flex items-center gap-2">
        <span className="text-app-muted">{icon}</span>
        <p className="text-sm font-medium text-app-text">{title}</p>
      </div>
      <div className="mt-3 space-y-1.5">
        {lines.map((line) => (
          <p key={line} className="text-[11px] text-app-muted break-all">
            {line}
          </p>
        ))}
      </div>
    </div>
  );
}
