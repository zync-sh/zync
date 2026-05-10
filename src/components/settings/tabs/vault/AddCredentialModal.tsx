import { Input } from '../../../ui/Input';
import { Modal } from '../../../ui/Modal';
import { Button } from '../../../ui/Button';
import { cn } from '../../../../lib/utils';

interface AddCredentialModalProps {
  isOpen: boolean;
  kind: 'ssh-private-key' | 'ssh-password';
  label: string;
  secret: string;
  passphrase: string;
  notes: string;
  isCreating: boolean;
  onClose: () => void;
  onKindChange: (kind: 'ssh-private-key' | 'ssh-password') => void;
  onLabelChange: (value: string) => void;
  onSecretChange: (value: string) => void;
  onPassphraseChange: (value: string) => void;
  onNotesChange: (value: string) => void;
  onSubmit: () => void;
}

export function AddCredentialModal({
  isOpen,
  kind,
  label,
  secret,
  passphrase,
  notes,
  isCreating,
  onClose,
  onKindChange,
  onLabelChange,
  onSecretChange,
  onPassphraseChange,
  onNotesChange,
  onSubmit,
}: AddCredentialModalProps) {
  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      title="Add Vault Credential"
      subtitle="Create a credential first, then assign it to one or more hosts from the connection editor."
      width="max-w-lg"
    >
      <div className="space-y-4">
        <div className="grid grid-cols-2 gap-2 rounded-lg border border-app-border/60 bg-app-surface/25 p-1">
          {(['ssh-private-key', 'ssh-password'] as const).map((candidate) => (
            <button
              key={candidate}
              type="button"
              onClick={() => {
                if (!isCreating) onKindChange(candidate);
              }}
              disabled={isCreating}
              aria-disabled={isCreating}
              className={cn(
                'rounded-md px-3 py-2 text-xs font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-50',
                kind === candidate
                  ? 'bg-app-accent text-white shadow-sm'
                  : 'text-app-muted hover:bg-app-surface hover:text-app-text'
              )}
            >
              {candidate === 'ssh-private-key' ? 'SSH Private Key' : 'Password'}
            </button>
          ))}
        </div>

        <Input
          label="Label"
          value={label}
          onChange={(event) => onLabelChange(event.target.value)}
          placeholder="Production deploy key"
          disabled={isCreating}
        />

        {kind === 'ssh-password' ? (
          <Input
            label="Password"
            type="password"
            value={secret}
            onChange={(event) => onSecretChange(event.target.value)}
            placeholder="Enter password"
            disabled={isCreating}
          />
        ) : (
          <div className="space-y-3">
            <div className="space-y-1">
              <label
                htmlFor="vault-add-private-key"
                className="text-[10px] font-bold text-app-muted uppercase tracking-[0.15em] opacity-40 mb-2 block px-1"
              >
                Private Key
              </label>
              <textarea
                id="vault-add-private-key"
                value={secret}
                onChange={(event) => onSecretChange(event.target.value)}
                placeholder="-----BEGIN OPENSSH PRIVATE KEY-----"
                disabled={isCreating}
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
              disabled={isCreating}
            />
          </div>
        )}

        <Input
          label="Notes (optional)"
          value={notes}
          onChange={(event) => onNotesChange(event.target.value)}
          placeholder="Where this credential is used"
          disabled={isCreating}
        />

        <div className="rounded-lg border border-app-border/50 bg-app-bg/35 px-3 py-2">
          <p className="text-xs text-app-muted leading-relaxed">
            Zync will create a stable credential identity for this item. Hosts assigned later
            reference that identity, so future restores can relink even if the physical vault
            item id changes.
          </p>
        </div>

        <div className="flex justify-end gap-2 pt-1">
          <Button variant="ghost" size="sm" onClick={onClose} disabled={isCreating}>
            Cancel
          </Button>
          <Button size="sm" onClick={onSubmit} isLoading={isCreating}>
            Add Credential
          </Button>
        </div>
      </div>
    </Modal>
  );
}
