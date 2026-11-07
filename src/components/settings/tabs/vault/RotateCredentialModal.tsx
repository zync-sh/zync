import { formatPrivacyAwareLabel } from '../../../../features/connections/domain/connectionDisplay';
import { useShowHostAddressesInLists } from '../../../../features/connections/presentation/useConnectionDisplayLabels';
import { isPasswordCredentialKind } from '../../../../vault/credentialTypes';
import type { VaultItem } from '../../../../vault/ipc';
import { Button } from '../../../ui/Button';
import { Input } from '../../../ui/Input';
import { Modal } from '../../../ui/Modal';
import { CredentialFileButton } from './CredentialFileButton';
import type { BeginCredentialFileImport } from './hooks/useCredentialFileImports';
import { SshCertificateField } from './SshCertificateField';

interface RotateCredentialModalProps {
    isOpen: boolean;
    item: VaultItem | null;
    label: string;
    secret: string;
    passphrase: string;
    certificate: string;
    notes: string;
    isLoading: boolean;
    isImporting: boolean;
    onImportStart: BeginCredentialFileImport;
    onClose: () => void;
    onLabelChange: (value: string) => void;
    onSecretChange: (value: string) => void;
    onPassphraseChange: (value: string) => void;
    onCertificateChange: (value: string) => void;
    onNotesChange: (value: string) => void;
    onSubmit: () => void;
}

/** Rotate an SSH key/certificate together; certificate-only renewal lives in credential details. */
export function RotateCredentialModal({
    isOpen,
    item,
    label,
    secret,
    passphrase,
    certificate,
    notes,
    isLoading,
    isImporting,
    onImportStart,
    onClose,
    onLabelChange,
    onSecretChange,
    onPassphraseChange,
    onCertificateChange,
    onNotesChange,
    onSubmit,
}: RotateCredentialModalProps) {
    const showHostAddressesInLists = useShowHostAddressesInLists();
    const displayTitle = item
        ? formatPrivacyAwareLabel(item.label, showHostAddressesInLists)
        : null;

    return (
        <Modal
            isOpen={isOpen}
            onClose={onClose}
            title={displayTitle ? `Rotate "${displayTitle}"` : 'Rotate Credential'}
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

                {item && (isPasswordCredentialKind(item.kind) || item.kind === 'api-token') ? (
                    <Input
                        label={item.kind === 'api-token' ? 'New API Token' : 'New Password'}
                        type="password"
                        value={secret}
                        onChange={(event) => onSecretChange(event.target.value)}
                        placeholder={
                            item.kind === 'api-token' ? 'Enter new API token' : 'Enter new password'
                        }
                        disabled={isLoading}
                    />
                ) : (
                    <div className="space-y-3">
                        <div className="space-y-1">
                            <div className="flex items-center justify-between gap-3">
                                <label
                                    htmlFor="vault-rotate-private-key"
                                    className="block px-1 text-[10px] font-bold uppercase tracking-[0.15em] text-app-muted/40"
                                >
                                    New Private Key
                                </label>
                                <CredentialFileButton
                                    kind="privateKey"
                                    value={secret}
                                    onChange={onSecretChange}
                                    onImportStart={onImportStart}
                                    disabled={isLoading || !isOpen}
                                />
                            </div>
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
                        {item?.kind === 'ssh-private-key' && (
                            <>
                                <SshCertificateField
                                    id="vault-rotate-ssh-certificate"
                                    value={certificate}
                                    onImportStart={onImportStart}
                                    onChange={onCertificateChange}
                                    disabled={isLoading || !isOpen}
                                />
                                {item.hasSshCertificateField && (
                                    <p className="text-xs text-app-muted">
                                        This replaces the key and its certificate. Leave the
                                        certificate blank for key-only login. To renew only the
                                        certificate, use credential details instead.
                                    </p>
                                )}
                            </>
                        )}
                        <Input
                            label="Private key passphrase (optional)"
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
                            Logical ID stays the same:{' '}
                            <span className="text-app-text">{item.logicalId.slice(0, 8)}</span>.
                            Connections assigned to this credential keep using the same reference.
                        </p>
                    </div>
                )}

                <div className="flex justify-end gap-2 pt-1">
                    <Button
                        variant="ghost"
                        size="sm"
                        onClick={onClose}
                        disabled={isLoading}
                    >
                        Cancel
                    </Button>
                    <Button
                        size="sm"
                        onClick={onSubmit}
                        disabled={isImporting}
                        isLoading={isLoading}
                    >
                        Rotate Credential
                    </Button>
                </div>
            </div>
        </Modal>
    );
}
