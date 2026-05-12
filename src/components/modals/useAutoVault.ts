import { useEffect, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
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
    const [vaultLabel, setVaultLabel] = useState('');
    const [keyVaultLabel, setKeyVaultLabel] = useState('');

    useEffect(() => {
        if (!isOpen) return;
        setPastedKeyText('');
        setPastedPassphrase('');
        setPastedKeyError('');
        setVaultLabel('');
        setKeyVaultLabel('');
    }, [isOpen]);

    const defaultVaultLabel = `${formData.name || formData.host || 'credential'} (${formData.username || 'user'}@${formData.host || 'host'})`;
    const effectiveVaultLabel = vaultLabel.trim() || defaultVaultLabel;
    const vaultLabelConflict = vaultStatus?.status === 'unlocked' && authMethod === 'password' && !!formData.password
        && vaultItems.some(i => i.label === effectiveVaultLabel);

    const defaultKeyVaultLabel = `${formData.name || formData.host || 'credential'} key (${formData.username || 'user'}@${formData.host || 'host'})`;
    const effectiveKeyVaultLabel = keyVaultLabel.trim() || defaultKeyVaultLabel;
    const hasKeyInput = authMethod === 'key' && (
        keyInputMode === 'file'
            ? !!formData.privateKeyPath?.trim()
            : !!pastedKeyText.trim()
    );
    const keyVaultLabelConflict = vaultStatus?.status === 'unlocked' && hasKeyInput
        && vaultItems.some(i => i.label === effectiveKeyVaultLabel);

    const deleteOldAuthItem = () => {
        if (!activeEditingConnectionId) return;
        const { connections } = useAppStore.getState();
        const existing = connections.find(c => c.id === activeEditingConnectionId);
        if (!existing?.authRef?.itemId) return;
        vaultIpc.itemDelete(existing.authRef.itemId).catch(() => {
            showToast('error', 'Old vault credential could not be deleted — remove it manually in Vault tab.');
        });
    };

    const savePastedKey = async (): Promise<Partial<Connection> | null> => {
        const keyText = pastedKeyText.trim();
        if (!keyText) {
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
        const secret = pastedPassphrase.trim()
            ? JSON.stringify({ key: keyText, passphrase: pastedPassphrase })
            : keyText;
        const item = await vaultIpc.itemCreate(effectiveKeyVaultLabel, 'ssh-private-key', secret);
        deleteOldAuthItem();
        setPastedKeyText('');
        setPastedPassphrase('');
        return {
            ...formData,
            authRef: {
                vaultId: unlockedVault.vaultId,
                credentialId: item.logicalId,
                itemId: item.id,
                itemKind: 'ssh-private-key',
                purpose: 'ssh-auth',
            },
        };
    };

    const autoVaultPassword = async (): Promise<Partial<Connection> | null> => {
        if (vaultStatus?.status !== 'unlocked' || authMethod !== 'password') return null;
        const password = (formData.password || '').trim();
        if (!password) return null;
        const item = await vaultIpc.itemCreate(effectiveVaultLabel, 'ssh-password', password);
        deleteOldAuthItem();
        return {
            ...formData,
            password: '',
            authRef: {
                vaultId: vaultStatus.vaultId,
                credentialId: item.logicalId,
                itemId: item.id,
                itemKind: 'ssh-password',
                purpose: 'ssh-auth',
            },
        };
    };

    const autoVaultKeyFile = async (): Promise<Partial<Connection> | null> => {
        if (vaultStatus?.status !== 'unlocked' || authMethod !== 'key' || keyInputMode !== 'file') return null;
        const keyPath = (formData.privateKeyPath || '').trim();
        if (!keyPath) return null;
        let keyContent: string;
        try {
            keyContent = await invoke<string>('plugin_fs_read', { path: keyPath });
        } catch (e) {
            throw new Error(`Could not read key file: ${e instanceof Error ? e.message : String(e)}`);
        }
        if (!isValidPrivateKeyFormat(keyContent)) {
            throw new Error('Selected file does not appear to be a valid private key.');
        }
        const item = await vaultIpc.itemCreate(effectiveKeyVaultLabel, 'ssh-private-key', keyContent);
        deleteOldAuthItem();
        return {
            ...formData,
            privateKeyPath: '',
            authRef: {
                vaultId: vaultStatus.vaultId,
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
            // Re-read connections fresh after the await to avoid stale closure.
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
        vaultLabel, setVaultLabel,
        keyVaultLabel, setKeyVaultLabel,
        defaultVaultLabel, effectiveVaultLabel, vaultLabelConflict,
        defaultKeyVaultLabel, effectiveKeyVaultLabel, keyVaultLabelConflict,
        savePastedKey, autoVaultPassword, autoVaultKeyFile, buildPastedKeyConnection,
    };
}
    const PRIVATE_KEY_BEGIN_PATTERN = /-----BEGIN [A-Z ]*PRIVATE KEY-----/;
    const PRIVATE_KEY_END_PATTERN = /-----END [A-Z ]*PRIVATE KEY-----/;
    const isValidPrivateKeyFormat = (keyContent: string): boolean =>
        PRIVATE_KEY_BEGIN_PATTERN.test(keyContent) && PRIVATE_KEY_END_PATTERN.test(keyContent);
