import { useMemo, useRef, useState } from 'react';

import type { Connection } from '../../../../../features/connections/domain/types';
import type { ToastType } from '../../../../../store/toastSlice';
import {
    sshPrivateKeySecretValues,
    vaultItemSecretReferenceField,
} from '../../../../../vault/credentialTypes';
import { type VaultItem, vaultIpc } from '../../../../../vault/ipc';
import { useCredentialFileImports } from './useCredentialFileImports';

interface UseRotateCredentialModalOptions {
    items: VaultItem[];
    connections: Connection[];
    showToast: (type: ToastType, message: string) => void;
    onRotated: () => Promise<void>;
    onPromptDisconnect: (affectedIds: string[], actionLabel: string) => Promise<void>;
}

const extractErrorMessage = (error: unknown): string =>
    error instanceof Error ? error.message : String(error);

/** Replace a credential's secret fields, including optional key attachments, and retain its identity. */
export function useRotateCredentialModal({
    items,
    connections,
    showToast,
    onRotated,
    onPromptDisconnect,
}: UseRotateCredentialModalOptions) {
    const [itemId, setItemId] = useState<string | null>(null);
    const [label, setLabel] = useState('');
    const [secret, setSecret] = useState('');
    const [passphrase, setPassphrase] = useState('');
    const [certificate, setCertificate] = useState('');
    const [notes, setNotes] = useState('');
    const [isLoading, setIsLoading] = useState(false);
    const currentOpenRequestTokenRef = useRef<symbol | null>(null);
    const fileImports = useCredentialFileImports();

    const item = useMemo(() => items.find((i) => i.id === itemId) ?? null, [items, itemId]);

    /** Load only metadata; existing private keys and certificates never cross detail IPC. */
    const open = async (id: string) => {
        const found = items.find((i) => i.id === id);
        if (!found) {
            return;
        }
        const requestToken = Symbol('rotate-credential-open');
        setItemId(found.id);
        setLabel(found.label);
        setSecret('');
        setPassphrase('');
        setCertificate('');
        setNotes('');
        currentOpenRequestTokenRef.current = requestToken;
        try {
            const full = await vaultIpc.itemGet(found.id);
            if (currentOpenRequestTokenRef.current !== requestToken) {
                return;
            }
            setNotes(full.notes || '');
        } catch (error: unknown) {
            if (currentOpenRequestTokenRef.current !== requestToken) {
                return;
            }
            console.warn('[Vault] Failed to load item for rotation:', error);
            const msg = extractErrorMessage(error);
            showToast('error', `Failed to load vault item notes: ${msg}`);
        } finally {
            if (currentOpenRequestTokenRef.current === requestToken) {
                currentOpenRequestTokenRef.current = null;
            }
        }
    };

    /** Clear sensitive editor state after a completed rotation or explicit close. */
    const reset = () => {
        currentOpenRequestTokenRef.current = null;
        setItemId(null);
        setLabel('');
        setSecret('');
        setPassphrase('');
        setCertificate('');
        setNotes('');
    };

    /** Prevent dismissing the editor while its native credential mutation is pending. */
    const close = () => {
        if (isLoading) {
            return;
        }
        reset();
    };

    /** Replace the complete key payload; native storage validates any matching certificate. */
    const submit = async () => {
        if (isLoading || fileImports.hasPendingImports()) {
            return;
        }
        if (!item) {
            return;
        }

        const trimmedLabel = label.trim();
        const trimmedSecret = secret.trim();

        if (!trimmedLabel) {
            showToast('error', 'Credential label is required.');
            return;
        }
        if (!trimmedSecret) {
            showToast('error', 'New credential secret is required.');
            return;
        }

        const secretValues: Record<string, string> =
            item.kind === 'ssh-private-key'
                ? sshPrivateKeySecretValues(secret, passphrase, certificate)
                : { [vaultItemSecretReferenceField(item).name]: secret };

        setIsLoading(true);
        try {
            const affectedConnectionIds = connections
                .filter(
                    (c) =>
                        c.authRef?.credentialId === item.logicalId || c.authRef?.itemId === item.id,
                )
                .map((c) => c.id);

            await vaultIpc.itemUpdate(
                item.id,
                trimmedLabel,
                item.kind,
                secretValues,
                notes.trim() || undefined,
            );
            await onRotated();
            reset();
            showToast(
                'success',
                `Rotated "${trimmedLabel}". Connections keep the same credential identity.`,
            );
            await onPromptDisconnect(affectedConnectionIds, `Rotating "${trimmedLabel}"`);
        } catch (e: unknown) {
            const msg = extractErrorMessage(e);
            showToast('error', `Failed to rotate credential: ${msg}`);
        } finally {
            setIsLoading(false);
        }
    };

    return {
        isOpen: Boolean(itemId),
        item,
        label,
        secret,
        passphrase,
        certificate,
        notes,
        isLoading,
        isImporting: fileImports.isImporting,
        beginImport: fileImports.beginImport,
        open,
        close,
        setLabel,
        setSecret,
        setPassphrase,
        setCertificate,
        setNotes,
        submit,
    };
}
