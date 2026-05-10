import type { VaultItem } from '../../../../vault/ipc';
import { Button } from '../../../ui/Button';
import { Input } from '../../../ui/Input';
import { Modal } from '../../../ui/Modal';

interface RotateCredentialModalProps {
  isOpen: boolean;
  item: VaultItem | null;
  label: string;
  secret: string;
  passphrase: string;
  notes: string;
  isLoading: boolean;
  onClose: () => void;
  onLabelChange: (value: string) => void;
  onSecretChange: (value: string) => void;
  onPassphraseChange: (value: string) => void;
  onNotesChange: (value: string) => void;
  onSubmit: () => void;
}

export function RotateCredentialModal({
  isOpen,
  item,
  label,
  secret,
  passphrase,
  notes,
  isLoading,
  onClose,
  onLabelChange,
  onSecretChange,
  onPassphraseChange,
  onNotesChange,
  onSubmit,
}: RotateCredentialModalProps) {
  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      title={item ? `Rotate "${item.label}"` : 'Rotate Credential'}
      subtitle="Replace the encrypted secret while keeping the same stable credential identity."
      width="max-w-lg"
    >
      <div className="space-y-4">
        <Input
          label="Label"
          value={label}
          onChange={(event) => onLabelChange(event.target.value)}
          placeholder="Credential label"
          disabled={isLoading}
        />

        {item?.kind === 'ssh-password' ? (
          <Input
            label="New Password"
            type="password"
            value={secret}
            onChange={(event) => onSecretChange(event.target.value)}
            placeholder="Enter new password"
            disabled={isLoading}
          />
        ) : (
          <div className="space-y-3">
            <div className="space-y-1">
              <label
                htmlFor="vault-rotate-private-key"
                className="text-[10px] font-bold text-app-muted uppercase tracking-[0.15em] opacity-40 mb-2 block px-1"
              >
                New Private Key
              </label>
              <textarea
                id="vault-rotate-private-key"
                value={secret}
                onChange={(event) => onSecretChange(event.target.value)}
                placeholder="-----BEGIN OPENSSH PRIVATE KEY-----"
                disabled={isLoading}
                rows={8}
                className="w-full rounded-xl border border-app-border bg-app-surface/50 px-3.5 py-2 text-[13px] text-app-text shadow-sm transition-all duration-300 placeholder:text-app-muted/50 focus-visible:outline-none focus-visible:border-app-accent/40 focus-visible:bg-app-surface/80 focus-visible:ring-1 focus-visible:ring-app-accent/20 disabled:cursor-not-allowed disabled:opacity-40"
              />
            </div>
            <Input
              label="Passphrase (optional)"
              type="password"
              value={passphrase}
              onChange={(event) => onPassphraseChange(event.target.value)}
              placeholder="Private key passphrase"
              disabled={isLoading}
            />
          </div>
        )}

        <Input
          label="Notes (optional)"
          value={notes}
          onChange={(event) => onNotesChange(event.target.value)}
          placeholder="Where this credential is used"
          disabled={isLoading}
        />

        {item && (
          <div className="rounded-lg border border-app-border/50 bg-app-bg/35 px-3 py-2">
            <p className="text-xs text-app-muted leading-relaxed">
              Logical ID stays the same: <span className="text-app-text">{item.logicalId.slice(0, 8)}</span>.
              Hosts already assigned to this credential keep working with the same reference.
            </p>
          </div>
        )}

        <div className="flex justify-end gap-2 pt-1">
          <Button variant="ghost" size="sm" onClick={onClose} disabled={isLoading}>
            Cancel
          </Button>
          <Button size="sm" onClick={onSubmit} isLoading={isLoading}>
            Rotate Credential
          </Button>
        </div>
      </div>
    </Modal>
  );
}
