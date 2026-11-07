import { useEffect, useId, useMemo, useRef, useState } from 'react';

import { Button } from '../../../components/ui/Button';
import { Select } from '../../../components/ui/Select';
import { isPasswordCredentialKind } from '../../../vault/credentialTypes';
import { useVaultStore } from '../../../vault/useVaultStore';
import { normalizeVncCredentialId } from '../domain/profile';

interface VncCredentialPickerProps {
    credentialId?: string;
    endpointReady: boolean;
    needsConfirmation: boolean;
    disabled: boolean;
    error?: string;
    onSelect: (credentialId: string) => void;
}

/** List password metadata while retaining an existing link when Vault is unavailable. */
export function VncCredentialPicker({
    credentialId,
    endpointReady,
    needsConfirmation,
    disabled,
    error,
    onSelect,
}: VncCredentialPickerProps) {
    const status = useVaultStore((state) => state.status);
    const items = useVaultStore((state) => state.items);
    const loading = useVaultStore((state) => state.isLoading);
    const vaultError = useVaultStore((state) => state.error);
    const refresh = useVaultStore((state) => state.refresh);
    const requestUnlock = useVaultStore((state) => state.requestUnlock);
    const descriptionId = useId();
    const pendingUnlock = useRef(false);
    const [unlocking, setUnlocking] = useState(false);
    const unlocked = status?.status === 'unlocked';

    useEffect(() => {
        void refresh().catch(() => {});
    }, [refresh]);

    const options = useMemo(() => {
        const choices = unlocked
            ? items.flatMap(({ logicalId, kind, label }) =>
                  isPasswordCredentialKind(kind) &&
                  normalizeVncCredentialId(logicalId) === logicalId
                      ? [{ value: logicalId, label }]
                      : [],
              )
            : [];
        if (credentialId && !choices.some(({ value }) => value === credentialId)) {
            choices.unshift({
                value: credentialId,
                label: unlocked ? 'Unavailable saved credential' : 'Saved Vault credential',
            });
        }
        return choices;
    }, [credentialId, items, unlocked]);

    /** Join the shared Vault prompt once and let the store publish refreshed metadata. */
    async function unlockVault() {
        if (pendingUnlock.current) {
            return;
        }
        pendingUnlock.current = true;
        setUnlocking(true);
        try {
            await requestUnlock();
        } finally {
            pendingUnlock.current = false;
            setUnlocking(false);
        }
    }

    const hint = !endpointReady
        ? 'Enter a valid host and port before choosing a credential.'
        : needsConfirmation
          ? 'Choose a credential again for the new address.'
          : 'The password stays in Vault. This profile stores only its reference.';
    return (
        <div className="space-y-1.5">
            <Select
                label="Vault credential"
                ariaDescribedBy={descriptionId}
                placeholder="Select a saved password"
                value={credentialId}
                options={options}
                onChange={onSelect}
                disabled={disabled || !endpointReady || !unlocked || options.length === 0}
                portal
            />
            <p
                id={descriptionId}
                className="text-xs text-app-muted"
            >
                {hint}
            </p>
            {error && (
                <p
                    role="alert"
                    className="text-xs text-control-danger"
                >
                    {error}
                </p>
            )}
            {unlocked ? (
                <p className="text-xs text-app-muted">
                    {vaultError && items.length === 0
                        ? 'Vault credentials could not be loaded. '
                        : ''}
                    To add a password, open Vault, choose Add Credential, then choose Password.
                </p>
            ) : (
                <Button
                    type="button"
                    variant="secondary"
                    size="sm"
                    disabled={disabled || loading}
                    isLoading={unlocking}
                    onClick={unlockVault}
                >
                    {status?.status === 'uninitialized' ? 'Set up Vault' : 'Unlock Vault'}
                </Button>
            )}
        </div>
    );
}
