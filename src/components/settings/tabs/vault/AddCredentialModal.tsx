import { cn } from '../../../../lib/utils';
import {
    CREDENTIAL_KIND_OPTIONS,
    isSupportedCreateCredentialKind,
    type SupportedCreateCredentialKind,
} from '../../../../vault/credentialTypes';
import { Button } from '../../../ui/Button';
import { Input } from '../../../ui/Input';
import { Modal } from '../../../ui/Modal';
import { CredentialFileButton } from './CredentialFileButton';
import type { BeginCredentialFileImport } from './hooks/useCredentialFileImports';
import { SshCertificateField } from './SshCertificateField';

interface AddCredentialModalProps {
    isOpen: boolean;
    kind: SupportedCreateCredentialKind;
    label: string;
    secret: string;
    passphrase: string;
    certificate: string;
    notes: string;
    isCreating: boolean;
    isImporting: boolean;
    onImportStart: BeginCredentialFileImport;
    onClose: () => void;
    onKindChange: (kind: SupportedCreateCredentialKind) => void;
    onLabelChange: (value: string) => void;
    onSecretChange: (value: string) => void;
    onPassphraseChange: (value: string) => void;
    onCertificateChange: (value: string) => void;
    onNotesChange: (value: string) => void;
    onSubmit: () => void;
}

/** Add a supported credential without changing the stable vault identity model. */
export function AddCredentialModal({
    isOpen,
    kind,
    label,
    secret,
    passphrase,
    certificate,
    notes,
    isCreating,
    isImporting,
    onImportStart,
    onClose,
    onKindChange,
    onLabelChange,
    onSecretChange,
    onPassphraseChange,
    onCertificateChange,
    onNotesChange,
    onSubmit,
}: AddCredentialModalProps) {
    const selectedKind = CREDENTIAL_KIND_OPTIONS.find((option) => option.kind === kind);

    return (
        <Modal
            isOpen={isOpen}
            onClose={onClose}
            title="Add Credential"
            subtitle="Choose a credential type. SSH credentials are available now; more typed credentials will use the same vault model."
            width="max-w-2xl"
        >
            <div className="space-y-4">
                <div className="space-y-2">
                    <div>
                        <p className="text-[10px] font-bold uppercase tracking-[0.15em] text-app-muted/60">
                            Credential Type
                        </p>
                        <p className="mt-1 text-xs text-app-muted">
                            The vault stores typed credentials. Unsupported types are shown now so
                            the direction stays clear without pretending they are ready.
                        </p>
                    </div>

                    <div className="grid gap-2 sm:grid-cols-2">
                        {CREDENTIAL_KIND_OPTIONS.map((option) => {
                            const isSelected = kind === option.kind;
                            const selectableKind = isSupportedCreateCredentialKind(option.kind)
                                ? option.kind
                                : null;
                            const isSelectable = option.enabled && selectableKind !== null;
                            return (
                                <button
                                    key={option.kind}
                                    type="button"
                                    onClick={() => {
                                        if (!isCreating && isSelectable && selectableKind) {
                                            onKindChange(selectableKind);
                                        }
                                    }}
                                    disabled={isCreating || !isSelectable}
                                    aria-disabled={isCreating || !isSelectable}
                                    aria-pressed={isSelected}
                                    className={cn(
                                        'rounded-xl border p-3 text-left transition-colors',
                                        'disabled:cursor-not-allowed disabled:opacity-55',
                                        isSelected
                                            ? 'border-app-accent/45 bg-app-accent/12 text-app-text'
                                            : 'border-app-border/50 bg-app-surface/20 text-app-muted hover:border-app-border hover:bg-app-surface/40 hover:text-app-text',
                                        !option.enabled &&
                                            'hover:border-app-border/50 hover:bg-app-surface/20 hover:text-app-muted',
                                    )}
                                >
                                    <div className="flex items-start justify-between gap-2">
                                        <span className="text-xs font-semibold">
                                            {option.label}
                                        </span>
                                        {option.badge && (
                                            <span className="rounded-md border border-app-border/50 bg-app-bg/35 px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wide text-app-muted">
                                                {option.badge}
                                            </span>
                                        )}
                                    </div>
                                    <p className="mt-1 text-[11px] leading-relaxed text-app-muted">
                                        {option.description}
                                    </p>
                                </button>
                            );
                        })}
                    </div>
                </div>

                <Input
                    label="Label"
                    value={label}
                    onChange={(event) => onLabelChange(event.target.value)}
                    placeholder="Credential label"
                    disabled={isCreating}
                />

                {kind !== 'ssh-private-key' ? (
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
                            <div className="flex items-center justify-between gap-3">
                                <label
                                    htmlFor="vault-add-private-key"
                                    className="block px-1 text-[10px] font-bold uppercase tracking-[0.15em] text-app-muted/40"
                                >
                                    Private Key
                                </label>
                                <CredentialFileButton
                                    kind="privateKey"
                                    value={secret}
                                    onChange={onSecretChange}
                                    onImportStart={onImportStart}
                                    disabled={isCreating || !isOpen}
                                />
                            </div>
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
                        <SshCertificateField
                            id="vault-add-ssh-certificate"
                            value={certificate}
                            onImportStart={onImportStart}
                            onChange={onCertificateChange}
                            disabled={isCreating || !isOpen}
                        />
                        <Input
                            label="Private key passphrase (optional)"
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
                    <p className="text-xs leading-relaxed text-app-muted">
                        {selectedKind?.label ?? 'Credential'} will receive a stable credential
                        identity. Hosts assigned later reference that identity, so future restores
                        can relink even if the physical vault item id changes.
                    </p>
                </div>

                <div className="flex justify-end gap-2 pt-1">
                    <Button
                        variant="ghost"
                        size="sm"
                        onClick={onClose}
                        disabled={isCreating}
                    >
                        Cancel
                    </Button>
                    <Button
                        size="sm"
                        onClick={onSubmit}
                        disabled={isImporting}
                        isLoading={isCreating}
                    >
                        Add Credential
                    </Button>
                </div>
            </div>
        </Modal>
    );
}
