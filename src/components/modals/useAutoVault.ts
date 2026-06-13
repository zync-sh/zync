import { useEffect, useState } from 'react';
import { useAppStore, Connection } from '../../store/useAppStore';
import { useVaultStore } from '../../vault/useVaultStore';
import { vaultIpc } from '../../vault/ipc';
import { buildConnectionSavePayload } from '../../features/connections/domain';
import { ToastType } from '../../store/toastSlice';

interface UseAutoVaultOptions {
    isOpen: boolean;
    formData: Partial<Connection>;
    authMethod: 'password' | 'key' | 'vault';
    keyInputMode: 'file' | 'paste';
    activeEditingConnectionId: string | null;
    validationOk: boolean;
    showToast: (type: ToastType, message: string) => void;
}

const PRIVATE_KEY_BEGIN_PATTERN = /-----BEGIN [A-Z ]*PRIVATE KEY-----/;
const PRIVATE_KEY_END_PATTERN = /-----END [A-Z ]*PRIVATE KEY-----/;
const isValidPrivateKeyFormat = (keyContent: string): boolean =>
    PRIVATE_KEY_BEGIN_PATTERN.test(keyContent) && PRIVATE_KEY_END_PATTERN.test(keyContent);

export function useAutoVault({
    isOpen,
    formData,
    authMethod,
    keyInputMode,
    activeEditingConnectionId,
    validationOk,
    showToast,
}: UseAutoVaultOptions) {
    const { status: vaultStatus, items: vaultItems, refreshItems } = useVaultStore();

    const [pastedKeyText, setPastedKeyText] = useState('');
    const [pastedPassphrase, setPastedPassphrase] = useState('');
    const [pastedKeyError, setPastedKeyError] = useState('');
    const [keyVaultLabel, setKeyVaultLabel] = useState('');

    useEffect(() => {
        if (!isOpen) return;
        setPastedKeyText('');
        setPastedPassphrase('');
        setPastedKeyError('');
        setKeyVaultLabel('');
    }, [isOpen]);

    const defaultKeyVaultLabel = `${formData.name || formData.host || 'credential'} key (${formData.username || 'user'}@${formData.host || 'host'})`;
    const effectiveKeyVaultLabel = keyVaultLabel.trim() || defaultKeyVaultLabel;
    const keyVaultLabelConflict = vaultStatus?.status === 'unlocked'
        && authMethod === 'key'
        && keyInputMode === 'paste'
        && !!pastedKeyText.trim()
        && vaultItems.some(i => i.label === effectiveKeyVaultLabel);

    const replacedAuthItemId = activeEditingConnectionId
        ? useAppStore.getState().connections.find(c => c.id === activeEditingConnectionId)?.authRef?.itemId
        : undefined;

    const resolveVaultId = async (): Promise<string> => {
        if (vaultStatus?.status === 'unlocked' && vaultStatus.vaultId) {
            return vaultStatus.vaultId;
        }
        const status = await vaultIpc.status();
        if (status.status !== 'unlocked' || !status.vaultId) {
            throw new Error('Vault must be unlocked to store credentials.');
        }
        return status.vaultId;
    };

    const finalizeVaultReplacement = async () => {
        setPastedKeyText('');
        setPastedPassphrase('');
        if (!replacedAuthItemId) return;

        const { connections } = useAppStore.getState();
        const sharedReferenceCount = connections.filter(connection =>
            connection.id !== activeEditingConnectionId
            && connection.authRef?.itemId === replacedAuthItemId,
        ).length;
        if (sharedReferenceCount > 0) {
            showToast(
                'info',
                'Previous vault credential was left in place because other hosts still use it.',
            );
            return;
        }

        try {
            await vaultIpc.itemDelete(replacedAuthItemId);
        } catch {
            showToast('error', 'Old vault credential could not be deleted — remove it manually in Vault tab.');
        }
    };

    const savePastedKey = async (): Promise<Partial<Connection> | null> => {
        const keyText = pastedKeyText;
        if (!keyText.trim()) {
            showToast('error', 'Please paste a private key.');
            setPastedKeyError('Please paste a private key.');
            return null;
        }
        if (!isValidPrivateKeyFormat(keyText)) {
            const message = 'Pasted key must include valid BEGIN/END private key markers.';
            setPastedKeyError(message);
            showToast('error', message);
            return null;
        }
        const unlockedVault = vaultStatus?.status === 'unlocked' ? vaultStatus : null;
        if (!unlockedVault) {
            showToast('error', 'Vault must be unlocked to store a pasted key.');
            return null;
        }
        setPastedKeyError('');
        const vaultId = await resolveVaultId();
        const item = await vaultIpc.itemCreate(effectiveKeyVaultLabel, 'ssh-private-key', {
            privateKey: keyText,
            ...(pastedPassphrase.length > 0 ? { passphrase: pastedPassphrase } : {}),
        });
        return {
            ...formData,
            authRef: {
                vaultId,
                credentialId: item.logicalId,
                itemId: item.id,
                itemKind: 'ssh-private-key',
                purpose: 'ssh-auth',
            },
        };
    };

    const buildPastedKeyConnection = async (): Promise<Connection | null> => {
        if (!validationOk) return null;
        try {
            const updatedData = await savePastedKey();
            if (!updatedData) return null;
            const { connections } = useAppStore.getState();
            return buildConnectionSavePayload({
                formData: updatedData,
                authMethod: 'vault',
                editingConnectionId: activeEditingConnectionId,
                connections,
            });
        } catch (e: unknown) {
            showToast('error', `Failed to store key: ${e instanceof Error ? e.message : String(e)}`);
            return null;
        }
    };

    return {
        vaultStatus, vaultItems, refreshItems,
        pastedKeyText, setPastedKeyText,
        pastedPassphrase, setPastedPassphrase,
        pastedKeyError, setPastedKeyError,
        keyVaultLabel, setKeyVaultLabel,
        defaultKeyVaultLabel, keyVaultLabelConflict,
        buildPastedKeyConnection,
        finalizeVaultReplacement,
    };
}