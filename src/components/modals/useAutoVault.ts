import { useEffect, useState } from 'react';

import {
    buildConnectionSavePayload,
    buildDefaultKeyVaultLabel,
    buildDefaultPasswordVaultLabel,
} from '../../features/connections/domain';
import {
    readLocalKeyFileIpc,
    writeManagedKeyIpc,
} from '../../features/connections/infrastructure/connectionIpc';
import { ToastType } from '../../store/toastSlice';
import { Connection, useAppStore } from '../../store/useAppStore';
import { isPasswordCredentialKind, PASSWORD_CREDENTIAL_KIND } from '../../vault/credentialTypes';
import { vaultIpc } from '../../vault/ipc';
import { useVaultStore } from '../../vault/useVaultStore';

interface UseAutoVaultOptions {
    isOpen: boolean;
    formData: Partial<Connection>;
    authMethod: 'password' | 'key' | 'vault';
    keyInputMode: 'file' | 'paste';
    vaultInputMode: 'existing' | 'paste' | 'import';
    activeEditingConnectionId: string | null;
    validationOk: boolean;
    materializeLocalKeyToVault?: boolean;
    materializePasswordToVault?: boolean;
    showToast: (type: ToastType, message: string) => void;
}

interface VaultKeyMaterialOverride {
    keyText: string;
    passphrase: string;
    source?: 'paste' | 'file';
}

export interface VaultKeyConnectionResult {
    connection: Connection;
    /** Newly created vault item — delete if host persist fails. */
    createdItemId: string;
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
    vaultInputMode,
    activeEditingConnectionId,
    validationOk,
    materializeLocalKeyToVault = false,
    materializePasswordToVault = false,
    showToast,
}: UseAutoVaultOptions) {
    const { status: vaultStatus, items: vaultItems, refreshItems } = useVaultStore();

    const [pastedKeyText, setPastedKeyText] = useState('');
    const [pastedPassphrase, setPastedPassphrase] = useState('');
    const [pastedKeyError, setPastedKeyError] = useState('');
    const [localKeyVaultError, setLocalKeyVaultError] = useState('');
    const [keyVaultLabel, setKeyVaultLabel] = useState('');

    useEffect(() => {
        if (!isOpen) {
            return;
        }
        setPastedKeyText('');
        setPastedPassphrase('');
        setPastedKeyError('');
        setLocalKeyVaultError('');
        setKeyVaultLabel('');
    }, [isOpen]);

    const defaultKeyVaultLabel = buildDefaultKeyVaultLabel({
        name: formData.name,
        host: formData.host,
        username: formData.username,
    });
    const defaultPasswordVaultLabel = buildDefaultPasswordVaultLabel({
        name: formData.name,
        host: formData.host,
        username: formData.username,
    });
    const effectiveKeyVaultLabel =
        keyVaultLabel.trim() ||
        (materializePasswordToVault ? defaultPasswordVaultLabel : defaultKeyVaultLabel);
    const keyVaultLabelConflict =
        vaultStatus?.status === 'unlocked' &&
        ((authMethod === 'vault' &&
            (vaultInputMode === 'paste' || vaultInputMode === 'import') &&
            !!pastedKeyText.trim()) ||
            materializeLocalKeyToVault ||
            materializePasswordToVault) &&
        vaultItems.some((i) => i.label === effectiveKeyVaultLabel);

    const replacedAuthRef = activeEditingConnectionId
        ? useAppStore.getState().connections.find((c) => c.id === activeEditingConnectionId)
              ?.authRef
        : undefined;

    const resolveVaultId = async (): Promise<string> => {
        // Always re-read store + IPC so we don't use a stale render closure after unlock.
        const fromStore = useVaultStore.getState().status;
        if (fromStore?.status === 'unlocked' && fromStore.vaultId) {
            return fromStore.vaultId;
        }
        const status = await vaultIpc.status();
        if (status.status === 'unlocked' && status.vaultId) {
            useVaultStore.setState({ status });
            return status.vaultId;
        }
        throw new Error(
            status.status === 'unlocked'
                ? 'Vault is unlocked but vault id is missing. Try locking and unlocking the vault, then save again.'
                : 'Vault must be unlocked to store credentials.',
        );
    };

    /** Keep replaced passwords reusable by saved profiles, including profiles on other devices. */
    const finalizeVaultReplacement = async () => {
        setPastedKeyText('');
        setPastedPassphrase('');
        if (!replacedAuthRef) {
            return;
        }

        const { itemId, credentialId, itemKind } = replacedAuthRef;
        if (isPasswordCredentialKind(itemKind)) {
            return;
        }

        const shared = useAppStore
            .getState()
            .connections.some(
                (connection) =>
                    connection.id !== activeEditingConnectionId &&
                    (connection.authRef?.itemId === itemId ||
                        (credentialId && connection.authRef?.credentialId === credentialId)),
            );
        if (shared) {
            showToast(
                'info',
                'Previous vault credential was left in place because other hosts still use it.',
            );
            return;
        }

        try {
            await vaultIpc.itemDelete(itemId);
        } catch {
            showToast(
                'error',
                'Old vault credential could not be deleted — remove it manually in Vault tab.',
            );
        }
    };

    const setKeyValidationError = (source: 'paste' | 'file', message: string) => {
        if (source === 'file') {
            setLocalKeyVaultError(message);
            setPastedKeyError('');
        } else {
            setPastedKeyError(message);
            setLocalKeyVaultError('');
        }
        showToast('error', message);
    };

    const validateKeyText = (
        candidate = pastedKeyText,
        source: 'paste' | 'file' = 'paste',
    ): string | null => {
        const keyText = candidate;
        if (!keyText.trim()) {
            const message =
                source === 'file' ? 'Selected key file is empty.' : 'Please paste a private key.';
            setKeyValidationError(source, message);
            return null;
        }
        if (!isValidPrivateKeyFormat(keyText)) {
            const message =
                source === 'file'
                    ? 'Selected key file must include valid BEGIN/END private key markers.'
                    : 'Pasted key must include valid BEGIN/END private key markers.';
            setKeyValidationError(source, message);
            return null;
        }
        setPastedKeyError('');
        setLocalKeyVaultError('');
        return keyText;
    };

    const deleteCreatedVaultItemBestEffort = async (itemId: string, _originalError?: unknown) => {
        try {
            await vaultIpc.itemDelete(itemId);
        } catch (cleanupError: unknown) {
            console.warn(
                '[Vault] Failed to delete orphaned vault item after save failure:',
                cleanupError,
            );
            showToast(
                'error',
                'Host save failed and the new vault credential could not be removed automatically — delete it in the Vault tab.',
            );
        }
    };

    const savePastedKeyToVault = async (
        material?: VaultKeyMaterialOverride,
    ): Promise<{ formPatch: Partial<Connection>; createdItemId: string } | null> => {
        const keyText = validateKeyText(material?.keyText, material?.source ?? 'paste');
        if (!keyText) {
            return null;
        }

        const vaultId = await resolveVaultId();
        const currentItems = await vaultIpc.itemList();
        if (currentItems.some((item) => item.label === effectiveKeyVaultLabel)) {
            throw new Error(`A Vault item named "${effectiveKeyVaultLabel}" already exists.`);
        }
        const item = await vaultIpc.itemCreate(effectiveKeyVaultLabel, 'ssh-private-key', {
            privateKey: keyText,
            ...((material?.passphrase ?? pastedPassphrase).length > 0
                ? { passphrase: material?.passphrase ?? pastedPassphrase }
                : {}),
        });
        return {
            createdItemId: item.id,
            formPatch: {
                ...formData,
                password: undefined,
                privateKeyPath: undefined,
                authRef: {
                    vaultId,
                    credentialId: item.logicalId,
                    itemId: item.id,
                    itemKind: 'ssh-private-key',
                    purpose: 'ssh-auth',
                },
            },
        };
    };

    const buildVaultKeyConnection = async (
        material?: VaultKeyMaterialOverride,
    ): Promise<VaultKeyConnectionResult | null> => {
        if (!validationOk) {
            return null;
        }
        let createdItemId: string | null = null;
        try {
            const saved = await savePastedKeyToVault(material);
            if (!saved) {
                return null;
            }
            createdItemId = saved.createdItemId;
            const { connections } = useAppStore.getState();
            const connection = buildConnectionSavePayload({
                formData: saved.formPatch,
                authMethod: 'vault',
                editingConnectionId: activeEditingConnectionId,
                connections,
            });
            return { connection, createdItemId: saved.createdItemId };
        } catch (e: unknown) {
            if (createdItemId) {
                await deleteCreatedVaultItemBestEffort(createdItemId, e);
            }
            showToast(
                'error',
                `Failed to store key: ${e instanceof Error ? e.message : String(e)}`,
            );
            return null;
        }
    };

    const savePasswordToVault = async (): Promise<{
        formPatch: Partial<Connection>;
        createdItemId: string;
    } | null> => {
        const password = formData.password ?? '';
        if (!password) {
            showToast('error', 'Password is required to store in Vault.');
            return null;
        }

        const vaultId = await resolveVaultId();
        const currentItems = await vaultIpc.itemList();
        if (currentItems.some((item) => item.label === effectiveKeyVaultLabel)) {
            throw new Error(`A Vault item named "${effectiveKeyVaultLabel}" already exists.`);
        }
        const item = await vaultIpc.itemCreate(effectiveKeyVaultLabel, PASSWORD_CREDENTIAL_KIND, {
            password,
        });
        return {
            createdItemId: item.id,
            formPatch: {
                ...formData,
                password: undefined,
                privateKeyPath: undefined,
                authRef: {
                    vaultId,
                    credentialId: item.logicalId,
                    itemId: item.id,
                    itemKind: PASSWORD_CREDENTIAL_KIND,
                    purpose: 'ssh-auth',
                },
            },
        };
    };

    const buildVaultPasswordConnection = async (): Promise<VaultKeyConnectionResult | null> => {
        if (!validationOk) {
            return null;
        }
        let createdItemId: string | null = null;
        try {
            const saved = await savePasswordToVault();
            if (!saved) {
                return null;
            }
            createdItemId = saved.createdItemId;
            const { connections } = useAppStore.getState();
            const connection = buildConnectionSavePayload({
                formData: saved.formPatch,
                authMethod: 'vault',
                editingConnectionId: activeEditingConnectionId,
                connections,
            });
            return { connection, createdItemId: saved.createdItemId };
        } catch (e: unknown) {
            if (createdItemId) {
                await deleteCreatedVaultItemBestEffort(createdItemId, e);
            }
            showToast(
                'error',
                `Failed to store password: ${e instanceof Error ? e.message : String(e)}`,
            );
            return null;
        }
    };

    /** Non-vault paste: write PEM to managed keys dir and return path. */
    const writePastedKeyAsManagedFile = async (): Promise<string | null> => {
        const keyText = validateKeyText();
        if (!keyText) {
            return null;
        }
        try {
            const suggestedName = (formData.name || formData.host || 'pasted_key').trim();
            return await writeManagedKeyIpc({
                content: keyText,
                suggestedName,
            });
        } catch (e: unknown) {
            const message = e instanceof Error ? e.message : String(e);
            setPastedKeyError(message);
            showToast('error', `Failed to save key file: ${message}`);
            return null;
        }
    };

    const loadKeyFileForVaultImport = async (path: string): Promise<boolean> => {
        try {
            const content = await readLocalKeyFileIpc(path);
            setPastedKeyText(content);
            setPastedKeyError('');
            setLocalKeyVaultError('');
            if (!keyVaultLabel.trim()) {
                const base = path.split(/[/\\]/).pop() || 'imported-key';
                // Strip a single trailing extension (id_ed25519 stays as-is; key.pem → key).
                const withoutExt = base.replace(/\.[^.]+$/, '');
                setKeyVaultLabel((withoutExt.trim() || base).trim());
            }
            return true;
        } catch (e: unknown) {
            const message = e instanceof Error ? e.message : String(e);
            setPastedKeyError(message);
            showToast('error', `Failed to read key file: ${message}`);
            return false;
        }
    };

    return {
        vaultStatus,
        vaultItems,
        refreshItems,
        pastedKeyText,
        setPastedKeyText,
        pastedPassphrase,
        setPastedPassphrase,
        pastedKeyError,
        setPastedKeyError,
        localKeyVaultError,
        keyVaultLabel,
        setKeyVaultLabel,
        defaultKeyVaultLabel,
        defaultPasswordVaultLabel,
        keyVaultLabelConflict,
        buildVaultKeyConnection,
        buildVaultPasswordConnection,
        deleteCreatedVaultItemBestEffort,
        writePastedKeyAsManagedFile,
        loadKeyFileForVaultImport,
        finalizeVaultReplacement,
        keyInputMode,
        vaultInputMode,
    };
}
