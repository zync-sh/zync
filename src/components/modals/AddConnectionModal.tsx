import { lazy, Suspense, useEffect, useMemo, useRef, useState } from 'react';
import { Modal } from '../ui/Modal';
import { Input } from '../ui/Input';
import { Button } from '../ui/Button';
import { IconButton } from '../ui/IconButton';
import { Toolbar } from '../ui/Toolbar';
import { Select } from '../ui/Select';
import { OSIcon } from '../icons/OSIcon';
import { useAppStore, Connection } from '../../store/useAppStore';
import { open } from '@tauri-apps/plugin-dialog';
import { cn } from '../../lib/utils';
import { ShieldCheck, CheckCircle2, AlertCircle, Loader2, FileText, Laptop, Files, ChevronDown, ChevronRight, Shield, KeyRound, Forward } from 'lucide-react';
import {
    deleteEphemeralKeyIpc,
    forgetKeyPassphraseIpc,
    readLocalKeyFileIpc,
    rememberKeyPassphraseIpc,
    testConnectionIpc,
    type ConnectionConfigPayload,
    writeEphemeralKeyIpc,
} from '../../features/connections/infrastructure/connectionIpc';
import {
    buildConnectionSavePayload,
    buildConnectionTestPayload,
    canSaveInspectedPrivateKey,
    connectionHasForwardableKey,
    SELF_AGENT_FORWARDING_KEY,
    shouldAutoConnectOnOpenTab,
} from '../../features/connections/domain';
import { Toggle } from '../settings/common/Toggle';
import {
    importConnectionsFromFileIpc,
    type ConnectionExchangeImportFormat,
} from '../../features/connections/infrastructure/connectionTransfer';
import { useConnectionForm } from './useConnectionForm';
import { useAutoVault } from './useAutoVault';
import { useVaultStore } from '../../vault/useVaultStore';
import { isVaultInUseError, VAULT_IN_USE_USER_MESSAGE } from '../../vault/vaultLoading';
import { isVaultAccessError } from '../../vault/vaultUnlockPrompt';
import {
    usePrivateKeyInspection,
    type PrivateKeyInspectionState,
} from './usePrivateKeyInspection';
import {
    stageKeyPassphraseForNextConnect,
} from '../../features/connections/application/keyPassphraseRuntime';
import {
    KeyPassphraseRetentionOptions,
} from '../connections/KeyPassphraseRetentionOptions';
import { KeyPassphraseInput } from '../connections/KeyPassphraseInput';
import type { KeyPassphraseRetention } from '../../features/connections/application/keyPassphrasePrompt';
import { connectWithHostKeyVerification } from '../../features/connections/application/hostKeyVerification';

const ImportSshModal = lazy(async () => {
    const module = await import('./ImportSshModal');
    return { default: module.ImportSshModal };
});

interface AddConnectionModalProps {
    isOpen: boolean;
    onClose: () => void;
    editingConnectionId: string | null;
}

const ICONS = [
    'Server', 'Database', 'Cloud', 'Terminal', 'Code', 'Box', 'Monitor', 'Globe', 'HardDrive',
    'Ubuntu', 'Debian', 'CentOS', 'Arch', 'Kali', 'macOS', 'Windows', 'Linux',
    'AWS', 'Jenkins', 'MongoDB', 'Nginx', 'PostgreSQL', "MySql"
];

const THEMES = [
    { id: '', label: 'Default', color: 'bg-app-surface border-app-border' },
    { id: 'red', label: 'Pro', color: 'bg-red-500/20 border-red-500' },
    { id: 'blue', label: 'Dev', color: 'bg-blue-500/20 border-blue-500' },
    { id: 'green', label: 'Test', color: 'bg-emerald-500/20 border-emerald-500' },
    { id: 'orange', label: 'Stg', color: 'bg-orange-500/20 border-orange-500' },
    { id: 'purple', label: 'App', color: 'bg-purple-500/20 border-purple-500' },
];

const PICK_AGENT_FORWARDING_KEY = '$pick-agent-forwarding-key';

function PastedKeyTextarea({
    value,
    error,
    onChange,
}: {
    value: string;
    error: string;
    onChange: (value: string) => void;
}) {
    return (
        <div className="space-y-2">
            <textarea
                value={value}
                className="w-full h-28 rounded-lg border border-app-border bg-app-bg px-3 py-2 text-xs font-mono text-app-text placeholder:text-app-muted/50 resize-none focus:outline-none focus:ring-1 focus:ring-app-accent/50"
                placeholder="-----BEGIN OPENSSH PRIVATE KEY-----&#10;...&#10;-----END OPENSSH PRIVATE KEY-----"
                onChange={(event) => onChange(event.target.value)}
                spellCheck={false}
            />
            {error && (
                <p className="text-[10px] text-red-400">{error}</p>
            )}
        </div>
    );
}

function PrivateKeyInspectionFeedback({
    inspection,
    allowDeferredPassphrase = false,
}: {
    inspection: PrivateKeyInspectionState;
    allowDeferredPassphrase?: boolean;
}) {
    if (inspection.status === 'idle') return null;
    if (inspection.status === 'checking') {
        return (
            <p className="flex items-center gap-1 text-[10px] text-app-muted">
                <Loader2 size={10} className="animate-spin" /> Checking private key...
            </p>
        );
    }
    if (inspection.status === 'valid') {
        return (
            <p className="flex items-center gap-1 text-[10px] text-emerald-400/80">
                <CheckCircle2 size={10} />
                {inspection.remembered
                    ? "Passphrase available from this device's credential store."
                    : inspection.encrypted
                        ? 'Passphrase verified locally.'
                        : 'Valid unencrypted private key.'}
            </p>
        );
    }
    if (inspection.status === 'passphraseRequired') {
        return (
            <p className="flex items-center gap-1 text-[10px] text-amber-400/90">
                <KeyRound size={10} />
                {allowDeferredPassphrase
                    ? 'This key is encrypted. Enter its passphrase now, or leave it blank to be asked when connecting.'
                    : 'This key is encrypted. Enter its passphrase to continue.'}
            </p>
        );
    }
    return (
        <p className="flex items-center gap-1 text-[10px] text-red-400">
            <AlertCircle size={10} />
            {inspection.status === 'invalidPassphrase'
                ? 'The passphrase could not unlock this key.'
                : inspection.status === 'unavailable'
                    ? 'This private key is missing or cannot be read.'
                : inspection.message || 'This file is not a supported private key.'}
        </p>
    );
}

export function AddConnectionModal({ isOpen, onClose, editingConnectionId }: AddConnectionModalProps) {
    const importConnections = useAppStore(state => state.importConnections);
    const saveTunnel = useAppStore(state => state.saveTunnel);
    const showToast = useAppStore(state => state.showToast);
    const showConfirmDialog = useAppStore(state => state.showConfirmDialog);
    const openTab = useAppStore(state => state.openTab);
    const requestVaultUnlock = useVaultStore(state => state.requestUnlock);
    const [keyPassphraseRetention, setKeyPassphraseRetention] = useState<KeyPassphraseRetention>('once');
    /** Password auth: keep on host record, or write ssh-password vault item on save. */
    const [passwordStorage, setPasswordStorage] = useState<'host' | 'vault'>('host');
    const [keyInspectionRevision, setKeyInspectionRevision] = useState(0);
    const [isForgettingKeyPassphrase, setIsForgettingKeyPassphrase] = useState(false);
    const [rememberedKeyPath, setRememberedKeyPath] = useState<string | null>(null);
    const retentionDefaultedKeyPathRef = useRef<string | null>(null);

    const {
        connections, folders, addConnection, editConnection,
        formData, setFormData,
        authMethod, setAuthMethod,
        keyInputMode, setKeyInputMode,
        vaultInputMode, setVaultInputMode,
        setTouched,
        submitAttempted: _submitAttempted, setSubmitAttempted,
        allowDuplicateEndpoint, setAllowDuplicateEndpoint,
        activeEditingConnectionId,
        validation,
        visibleHostError, visibleUsernameError, visiblePortError, visibleKeyPathError,
        duplicateConnection, credentialHealthChecks, jumpCycleWarning,
        saveForm,
    } = useConnectionForm(isOpen, editingConnectionId);

    const {
        vaultStatus, vaultItems, refreshItems,
        pastedKeyText,
        setPastedKeyText,
        pastedPassphrase, setPastedPassphrase,
        pastedKeyError, setPastedKeyError,
        localKeyVaultError,
        keyVaultLabel, setKeyVaultLabel,
        defaultKeyVaultLabel, keyVaultLabelConflict,
        buildVaultKeyConnection,
        buildVaultPasswordConnection,
        deleteCreatedVaultItemBestEffort,
        writePastedKeyAsManagedFile,
        loadKeyFileForVaultImport,
        finalizeVaultReplacement,
        defaultPasswordVaultLabel,
    } = useAutoVault({
        isOpen,
        formData,
        authMethod,
        keyInputMode,
        vaultInputMode,
        activeEditingConnectionId,
        validationOk: validation.ok,
        materializeLocalKeyToVault: authMethod === 'key' && keyPassphraseRetention === 'vault',
        materializePasswordToVault: authMethod === 'password' && passwordStorage === 'vault',
        showToast,
    });

    const [testStatus, setTestStatus] = useState<'idle' | 'testing' | 'success' | 'error'>('idle');
    const [testMessage, setTestMessage] = useState('');
    const [isAppearanceOpen, setIsAppearanceOpen] = useState(false);
    const [isAdvancedOpen, setIsAdvancedOpen] = useState(false);
    const [showAllIcons, setShowAllIcons] = useState(false);
    const [entryMode, setEntryMode] = useState<'chooser' | 'manual'>('manual');
    const [isImportModalOpen, setIsImportModalOpen] = useState(false);
    const [isSaving, setIsSaving] = useState(false);
    const lastImportPlaintextCountRef = useRef(0);
    const vaultNeedsMaterialize = authMethod === 'vault'
        && (vaultInputMode === 'paste' || vaultInputMode === 'import');
    const selfCanForwardKey = authMethod === 'key'
        || (authMethod === 'vault'
            && (vaultNeedsMaterialize || formData.authRef?.itemKind === 'ssh-private-key'));
    const forwardableConnections = useMemo(
        () => connections.filter(connection => (
            connection.id !== activeEditingConnectionId && connectionHasForwardableKey(connection)
        )),
        [activeEditingConnectionId, connections],
    );
    const needsForwardingKeyPick = formData.agentForwardingKeyConnectionId === PICK_AGENT_FORWARDING_KEY;
    const selectedForwardingKeyAvailable = !formData.agentForwardingKeyConnectionId
        || needsForwardingKeyPick
        || (formData.agentForwardingKeyConnectionId === SELF_AGENT_FORWARDING_KEY
            ? selfCanForwardKey
            : forwardableConnections.some(connection => connection.id === formData.agentForwardingKeyConnectionId));

    const localKeySource = authMethod === 'key'
        ? keyInputMode === 'file'
            ? (formData.privateKeyPath ? { path: formData.privateKeyPath } : null)
            : (pastedKeyText.trim() ? { content: pastedKeyText } : null)
        : null;
    const vaultKeySource = authMethod === 'vault' && vaultNeedsMaterialize && pastedKeyText.trim()
        ? { content: pastedKeyText }
        : null;
    const localKeyInspection = usePrivateKeyInspection(
        localKeySource,
        formData.password || '',
        keyInputMode === 'file',
        keyInspectionRevision,
    );
    const currentKeyPath = formData.privateKeyPath?.trim() || null;
    const keyRememberedOnDevice = Boolean(
        currentKeyPath && (localKeyInspection.remembered || rememberedKeyPath === currentKeyPath),
    );
    const vaultKeyInspection = usePrivateKeyInspection(vaultKeySource, pastedPassphrase);
    const activeKeyInspection = authMethod === 'key' ? localKeyInspection : vaultKeyInspection;
    const requiresKeyInspection = authMethod === 'key' || vaultNeedsMaterialize;
    const keyInspectionReady = !requiresKeyInspection || activeKeyInspection.status === 'valid';
    const keyInspectionSaveReady = authMethod === 'key'
        ? canSaveInspectedPrivateKey(localKeyInspection.status, formData.password || '')
        : keyInspectionReady;
    const willStoreLocalKeyInVault = authMethod === 'key' && keyPassphraseRetention === 'vault';
    const willStorePasswordInVault = authMethod === 'password' && passwordStorage === 'vault';
    const localVaultPassphraseReady = !willStoreLocalKeyInVault
        || !localKeyInspection.encrypted
        || (Boolean(formData.password) && localKeyInspection.status === 'valid');

    useEffect(() => {
        if (!isOpen) return;
        setTestStatus('idle');
        setTestMessage('');
        setPasswordStorage('host');
        setIsAppearanceOpen(false);
        setIsAdvancedOpen(!!activeEditingConnectionId);
        setShowAllIcons(false);
        setEntryMode(activeEditingConnectionId ? 'manual' : 'chooser');
        setIsSaving(false);
        setIsForgettingKeyPassphrase(false);
        setKeyInspectionRevision(0);
        setRememberedKeyPath(null);
        setKeyPassphraseRetention('once');
        retentionDefaultedKeyPathRef.current = null;
    }, [activeEditingConnectionId, isOpen]);

    const vaultAvailable = vaultStatus?.status === 'unlocked' || vaultStatus?.status === 'locked';

    useEffect(() => {
        const selected = formData.agentForwardingKeyConnectionId;
        if (!selected || needsForwardingKeyPick || selectedForwardingKeyAvailable) return;
        setFormData(previous => ({
            ...previous,
            agentForwardingKeyConnectionId: undefined,
        }));
    }, [
        formData.agentForwardingKeyConnectionId,
        forwardableConnections,
        needsForwardingKeyPick,
        selectedForwardingKeyAvailable,
        setFormData,
    ]);

    useEffect(() => {
        if (authMethod !== 'key' || localKeyInspection.status !== 'valid' || localKeyInspection.encrypted) return;
        if (!formData.password) return;
        setFormData(previous => ({ ...previous, password: undefined }));
    }, [authMethod, formData.password, localKeyInspection.encrypted, localKeyInspection.status, setFormData]);

    useEffect(() => {
        if (vaultAvailable) return;
        if (keyPassphraseRetention === 'vault') setKeyPassphraseRetention('once');
        if (passwordStorage === 'vault') setPasswordStorage('host');
    }, [keyPassphraseRetention, passwordStorage, vaultAvailable]);

    useEffect(() => {
        if (!vaultNeedsMaterialize || vaultKeyInspection.status !== 'valid' || vaultKeyInspection.encrypted) return;
        if (!pastedPassphrase) return;
        setPastedPassphrase('');
    }, [pastedPassphrase, setPastedPassphrase, vaultKeyInspection.encrypted, vaultKeyInspection.status, vaultNeedsMaterialize]);

    useEffect(() => {
        if (
            localKeyInspection.remembered
            && currentKeyPath
            && retentionDefaultedKeyPathRef.current !== currentKeyPath
        ) {
            setRememberedKeyPath(currentKeyPath);
            setKeyPassphraseRetention('device');
            retentionDefaultedKeyPathRef.current = currentKeyPath;
        }
        else if (localKeyInspection.status === 'valid' && !localKeyInspection.encrypted) {
            setKeyPassphraseRetention('once');
            retentionDefaultedKeyPathRef.current = null;
        }
    }, [currentKeyPath, localKeyInspection.encrypted, localKeyInspection.remembered, localKeyInspection.status]);

    const canSave = validation.ok
        && (!duplicateConnection || allowDuplicateEndpoint)
        && !keyVaultLabelConflict
        && !(authMethod === 'vault' && vaultInputMode === 'existing' && !formData.authRef?.itemId)
        && !(authMethod === 'vault' && vaultNeedsMaterialize && !pastedKeyText.trim())
        && !(authMethod === 'key' && keyInputMode === 'paste' && !pastedKeyText.trim())
        && keyInspectionSaveReady
        && localVaultPassphraseReady
        && selectedForwardingKeyAvailable
        && !needsForwardingKeyPick;
    const canTest = validation.ok
        && testStatus !== 'testing'
        && !(authMethod === 'key' && keyInputMode === 'paste' && !pastedKeyText.trim())
        && !(authMethod === 'vault' && vaultNeedsMaterialize && !pastedKeyText.trim())
        && !(authMethod === 'vault' && vaultInputMode === 'existing' && !formData.authRef?.itemId)
        && keyInspectionReady
        && selectedForwardingKeyAvailable
        && !needsForwardingKeyPick;
    const selectedIcon = formData.icon || 'Server';
    const compactIcons = ICONS.slice(0, 12);
    const visibleIcons = showAllIcons
        ? ICONS
        : compactIcons.includes(selectedIcon)
            ? compactIcons
            : [...compactIcons, selectedIcon];

    const needsVaultUnlock = authMethod === 'vault'
        || Boolean(formData.authRef?.itemId)
        || willStoreLocalKeyInVault
        || willStorePasswordInVault;

    const notifyVaultBlocked = () => {
        if (isVaultInUseError(useVaultStore.getState().error)) {
            showToast('error', VAULT_IN_USE_USER_MESSAGE, 8000);
        }
    };

    const forgetCurrentDevicePassphrase = async () => {
        const keyPath = formData.privateKeyPath?.trim();
        if (!keyPath || isForgettingKeyPassphrase) return;
        setIsForgettingKeyPassphrase(true);
        try {
            await forgetKeyPassphraseIpc(keyPath);
            setFormData(previous => ({ ...previous, password: undefined }));
            setKeyPassphraseRetention('once');
            setRememberedKeyPath(null);
            setKeyInspectionRevision(current => current + 1);
            showToast('success', 'Forgot this key passphrase on this device.');
        } catch (error: unknown) {
            const message = error instanceof Error ? error.message : String(error);
            showToast('error', `Could not forget this key passphrase: ${message}`);
        } finally {
            setIsForgettingKeyPassphrase(false);
        }
    };

    const performSave = async (retryAfterUnlock = false): Promise<Connection | null> => {
        if (isSaving && !retryAfterUnlock) return null;
        setIsSaving(true);
        setSubmitAttempted(true);
        try {
            if (!validation.ok || !canSave) return null;

            if (!retryAfterUnlock && (needsVaultUnlock || vaultNeedsMaterialize)) {
                const unlocked = await requestVaultUnlock();
                if (!unlocked) {
                    notifyVaultBlocked();
                    return null;
                }
            }

            if (willStoreLocalKeyInVault) {
                const keyText = keyInputMode === 'file'
                    ? await readLocalKeyFileIpc(formData.privateKeyPath || '')
                    : pastedKeyText;
                const result = await buildVaultKeyConnection({
                    keyText,
                    passphrase: formData.password || '',
                    source: keyInputMode === 'file' ? 'file' : 'paste',
                });
                if (!result) return null;
                try {
                    await (activeEditingConnectionId
                        ? editConnection(result.connection)
                        : addConnection(result.connection));
                } catch (persistError: unknown) {
                    await deleteCreatedVaultItemBestEffort(result.createdItemId, persistError);
                    throw persistError;
                }
                if (keyInputMode === 'file' && formData.privateKeyPath) {
                    try {
                        await forgetKeyPassphraseIpc(formData.privateKeyPath);
                        setRememberedKeyPath(null);
                        retentionDefaultedKeyPathRef.current = null;
                    } catch (forgetError: unknown) {
                        const message = forgetError instanceof Error ? forgetError.message : String(forgetError);
                        showToast('error', `Saved to Vault, but could not forget this key from the device: ${message}`);
                    }
                }
                try {
                    await finalizeVaultReplacement();
                    await refreshItems();
                } catch (refreshError: unknown) {
                    const message = refreshError instanceof Error ? refreshError.message : String(refreshError);
                    showToast('info', `Host saved to Vault, but the credential list could not refresh: ${message}`);
                }
                return result.connection;
            }

            if (willStorePasswordInVault) {
                const result = await buildVaultPasswordConnection();
                if (!result) return null;
                try {
                    await (activeEditingConnectionId
                        ? editConnection(result.connection)
                        : addConnection(result.connection));
                } catch (persistError: unknown) {
                    await deleteCreatedVaultItemBestEffort(result.createdItemId, persistError);
                    throw persistError;
                }
                try {
                    await finalizeVaultReplacement();
                    await refreshItems();
                } catch (refreshError: unknown) {
                    const message = refreshError instanceof Error ? refreshError.message : String(refreshError);
                    showToast('info', `Host saved to Vault, but the credential list could not refresh: ${message}`);
                }
                return result.connection;
            }

            if (authMethod === 'key') {
                const keyPath = keyInputMode === 'paste'
                    ? await writePastedKeyAsManagedFile()
                    : formData.privateKeyPath;
                if (!keyPath) return null;
                const passphrase = formData.password || '';
                const withPath = {
                    ...formData,
                    password: undefined,
                    privateKeyPath: keyPath,
                    authRef: undefined,
                };
                const connectionData = buildConnectionSavePayload({
                    formData: withPath,
                    authMethod: 'key',
                    editingConnectionId: activeEditingConnectionId,
                    connections,
                });
                await (activeEditingConnectionId ? editConnection(connectionData) : addConnection(connectionData));
                if (
                    localKeyInspection.encrypted
                    && keyPassphraseRetention === 'device'
                    && !keyRememberedOnDevice
                ) {
                    try {
                        await rememberKeyPassphraseIpc(keyPath, passphrase);
                    } catch (rememberError: unknown) {
                        const message = rememberError instanceof Error ? rememberError.message : String(rememberError);
                        showToast('error', `Host saved, but this key could not be remembered on this device: ${message}`);
                    }
                }
                setPastedKeyText('');
                return connectionData;
            }

            if (authMethod === 'vault' && vaultNeedsMaterialize) {
                const result = await buildVaultKeyConnection();
                if (!result) return null;
                try {
                    await (activeEditingConnectionId
                        ? editConnection(result.connection)
                        : addConnection(result.connection));
                } catch (persistError: unknown) {
                    await deleteCreatedVaultItemBestEffort(result.createdItemId, persistError);
                    throw persistError;
                }
                try {
                    await finalizeVaultReplacement();
                    await refreshItems();
                } catch (refreshError: unknown) {
                    const message = refreshError instanceof Error ? refreshError.message : String(refreshError);
                    showToast('info', `Host saved to Vault, but the credential list could not refresh: ${message}`);
                }
                return result.connection;
            }

            const saved = await saveForm(canSave);
            return saved;
        } catch (error: unknown) {
            const message = error instanceof Error ? error.message : String(error);
            if (!retryAfterUnlock && isVaultAccessError(message)) {
                const unlocked = await requestVaultUnlock();
                // Await so outer finally keeps isSaving true until the nested retry finishes.
                if (unlocked) return await performSave(true);
            }
            throw error;
        } finally {
            setIsSaving(false);
        }
    };

    const handleSave = async () => {
        const saved = await performSave();
        if (!saved) return;
        onClose();
    };

    const handleSaveAndConnect = async () => {
        const oneTimePassphrase = authMethod === 'key'
            && localKeyInspection.encrypted
            && keyPassphraseRetention === 'once'
            ? formData.password || ''
            : '';
        const saved = await performSave();
        if (!saved) return;
        if (
            oneTimePassphrase
            && saved.privateKeyPath
            && shouldAutoConnectOnOpenTab(connections, saved)
        ) {
            stageKeyPassphraseForNextConnect(saved.id, saved.privateKeyPath, oneTimePassphrase);
        }
        openTab(saved.id, 'terminal');
        onClose();
    };

    const testDisabledReason = !keyInspectionReady
        ? 'Select a valid private key and verify its passphrase before testing.'
        : needsForwardingKeyPick
            ? 'Select the one private key this connection may forward.'
        : '';

    const handleTestConnection = async (retryAfterUnlock = false) => {
        setSubmitAttempted(true);
        if (!validation.ok) {
            setTestStatus('error');
            setTestMessage(validation.errors[0] || 'Please fill required fields.');
            return;
        }
        if (authMethod === 'key' && keyInputMode === 'paste' && !pastedKeyText.trim()) {
            setTestStatus('error');
            setTestMessage('Please paste a private key first.');
            return;
        }
        if (authMethod === 'vault' && vaultNeedsMaterialize && !pastedKeyText.trim()) {
            setTestStatus('error');
            setTestMessage(vaultInputMode === 'import'
                ? 'Please import a private key file first.'
                : 'Please paste a private key first.');
            return;
        }
        if (!keyInspectionReady) {
            setTestStatus('error');
            setTestMessage('Select a valid private key and verify its passphrase first.');
            return;
        }
        setTestStatus('testing');
        setTestMessage('');
        let ephemeralTestPath: string | null = null;
        try {
            // Existing vault credential still needs unlock; paste/import test uses ephemeral file (no vault write).
            // Skip on retryAfterUnlock — requestUnlock already refreshed vault state.
            if (!retryAfterUnlock && authMethod === 'vault' && vaultInputMode === 'existing') {
                const unlocked = await requestVaultUnlock();
                if (!unlocked) {
                    notifyVaultBlocked();
                    setTestStatus('idle');
                    return;
                }
            }

            let testForm = formData;
            let testAuthMethod = authMethod;

            if (authMethod === 'key' && keyInputMode === 'paste') {
                // Ephemeral tmp-keys for Test only; deleted after. Managed file is written on Save.
                ephemeralTestPath = await writeEphemeralKeyIpc(pastedKeyText);
                testForm = {
                    ...formData,
                    privateKeyPath: ephemeralTestPath,
                    authRef: undefined,
                };
            } else if (authMethod === 'vault' && vaultNeedsMaterialize) {
                // Security: ephemeral tmp-keys file for Test only; deleted after. Vault write happens on Save.
                ephemeralTestPath = await writeEphemeralKeyIpc(pastedKeyText);
                testAuthMethod = 'key';
                testForm = {
                    ...formData,
                    privateKeyPath: ephemeralTestPath,
                    password: pastedPassphrase || undefined,
                    authRef: undefined,
                };
            }

            const config = buildConnectionTestPayload({
                formData: testForm,
                authMethod: testAuthMethod,
                connections,
            });
            await connectWithHostKeyVerification(
                config as ConnectionConfigPayload,
                testConnectionIpc,
                showConfirmDialog,
            );
            setTestStatus('success');
            setTestMessage('Connection successful!');
        } catch (error: unknown) {
            const message = error instanceof Error ? error.message : String(error);
            if (!retryAfterUnlock && isVaultAccessError(message)) {
                const unlocked = await requestVaultUnlock();
                if (unlocked) {
                    return await handleTestConnection(true);
                }
                setTestStatus('idle');
                return;
            }
            setTestStatus('error');
            setTestMessage(message.replace('Error: ', ''));
        } finally {
            if (ephemeralTestPath) {
                try {
                    await deleteEphemeralKeyIpc(ephemeralTestPath);
                } catch {
                    // Best-effort cleanup; tmp-keys is refused outside that dir by the backend.
                }
            }
        }
    };

    const handleBrowseKey = async () => {
        try {
            const selected = await open({ multiple: false, directory: false });
            if (!selected) return;
            const path = Array.isArray(selected) ? selected[0] : selected;
            if (!path) return;
            setTouched((prev) => ({ ...prev, keyPath: true }));
            setFormData((prev) => ({ ...prev, privateKeyPath: path, password: undefined }));
        } catch (error: unknown) {
            const message = error instanceof Error ? error.message : String(error);
            setTouched((prev) => ({ ...prev, keyPath: true }));
            setFormData((prev) => ({ ...prev, privateKeyPath: '' }));
            showToast('error', `Failed to select key: ${message}`);
        }
    };

    const handleBrowseVaultImportKey = async () => {
        try {
            const selected = await open({ multiple: false, directory: false });
            if (!selected) return;
            const path = Array.isArray(selected) ? selected[0] : selected;
            if (!path || typeof path !== 'string') return;
            await loadKeyFileForVaultImport(path);
        } catch (error: unknown) {
            const message = error instanceof Error ? error.message : String(error);
            showToast('error', `Failed to select key: ${message}`);
        }
    };

    const inferImportFormatFromPath = (path: string): ConnectionExchangeImportFormat => {
        const normalized = path.trim().toLowerCase();
        if (normalized.endsWith('.csv')) return 'csv';
        if (normalized.endsWith('.zync') || normalized.endsWith('.zync.json')) return 'zync';
        if (normalized.endsWith('.json')) return 'json';
        return 'auto';
    };

    const handleImportConnectionsFile = async () => {
        try {
            const selected = await open({ multiple: false, directory: false });
            if (!selected) return;
            const path = Array.isArray(selected) ? selected[0] : selected;
            if (!path || typeof path !== 'string') return;
            const imported = await importConnectionsFromFileIpc({
                path,
                format: inferImportFormatFromPath(path),
            });
            const mappedConnections: Connection[] = (imported.connections || []).map((connection) => ({
                ...connection,
                status: 'disconnected',
            }));
            importConnections(mappedConnections, imported.folders || []);
            const importedTunnels = imported.tunnels || [];
            let tunnelsSaved = 0;
            let tunnelsFailed = 0;
            for (const tunnel of importedTunnels) {
                try {
                    await saveTunnel({
                        ...tunnel,
                        status: tunnel.status === 'active' ? 'stopped' : (tunnel.status || 'stopped'),
                    });
                    tunnelsSaved += 1;
                } catch (tunnelError: unknown) {
                    tunnelsFailed += 1;
                    console.warn('[Import] Failed to save tunnel:', tunnel, tunnelError);
                }
            }
            const plaintextCount = mappedConnections.filter(c => !c.authRef && (c.password || c.privateKeyPath)).length;
            const tunnelNote = tunnelsSaved > 0
                ? ` and ${tunnelsSaved} tunnel(s)`
                : '';
            if (plaintextCount > 0 && vaultStatus?.status !== 'uninitialized') {
                showToast('success', `Imported ${mappedConnections.length} connection(s)${tunnelNote} — ${plaintextCount} have plaintext credentials. Open Vault tab to secure them to vault.`);
            } else {
                showToast('success', `Imported ${mappedConnections.length} connection(s)${tunnelNote} from file.`);
            }
            if (tunnelsFailed > 0) {
                showToast(
                    'warning',
                    `${tunnelsFailed} tunnel(s) could not be imported (connections were saved).`,
                );
            }
            onClose();
        } catch (error: unknown) {
            const message = error instanceof Error ? error.message : String(error);
            showToast('error', `Failed to import connection file: ${message}`);
        }
    };

    return (
        <Modal
            isOpen={isOpen}
            onClose={onClose}
            title={activeEditingConnectionId ? "Edit Connection" : "New Connection"}
            subtitle={entryMode === 'manual' ? 'Identity, authentication, appearance, then optional advanced settings.' : undefined}
            className="w-full max-w-2xl"
            headerClassName="p-2.5"
            contentClassName="p-0 overflow-hidden"
            titleClassName="text-sm"
        >
            <div className="flex flex-col h-[520px]">
                {entryMode === 'chooser' && !activeEditingConnectionId ? (
                    <div className="flex-1 flex items-center justify-center p-8">
                        <div className="w-full max-w-lg space-y-4">
                            <h4 className="text-base font-semibold text-app-text text-center tracking-tight">Choose how to create this connection</h4>
                            <p className="text-xs text-app-muted text-center leading-relaxed">Create a host yourself, or import from SSH config or a file.</p>
                            <div className="flex flex-col gap-2.5">
                                <button
                                    type="button"
                                    onClick={() => setEntryMode('manual')}
                                    className="group rounded-xl border border-[var(--color-app-border)]/60 bg-[var(--color-app-surface)]/35 p-3.5 text-left transition-all hover:border-[var(--color-app-accent)]/35 hover:bg-[var(--color-app-surface)]"
                                >
                                    <div className="flex items-start gap-3">
                                        <div className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-[var(--color-app-border)] bg-[var(--color-app-bg)] text-[var(--color-app-accent)]">
                                            <Laptop className="w-4 h-4" />
                                        </div>
                                        <div className="flex min-w-0 flex-1 flex-col">
                                            <span className="text-sm font-semibold text-app-text">New host</span>
                                            <span className="mt-0.5 text-xs text-app-muted leading-relaxed">Enter identity, auth, and optional jump settings</span>
                                            <span className="mt-2 text-[11px] font-medium text-app-accent/90">Best for one-off quick entries</span>
                                        </div>
                                    </div>
                                </button>
                                <button
                                    type="button"
                                    onClick={() => setIsImportModalOpen(true)}
                                    className="group rounded-xl border border-[var(--color-app-border)]/60 bg-[var(--color-app-surface)]/35 p-3.5 text-left transition-all hover:border-[var(--color-app-accent)]/35 hover:bg-[var(--color-app-surface)]"
                                >
                                    <div className="flex items-start gap-3">
                                        <div className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-[var(--color-app-border)] bg-[var(--color-app-bg)] text-[var(--color-app-accent)]">
                                            <FileText className="w-4 h-4" />
                                        </div>
                                        <div className="flex min-w-0 flex-1 flex-col">
                                            <span className="text-sm font-semibold text-app-text">Import Config</span>
                                            <span className="mt-0.5 text-xs text-app-muted leading-relaxed">Load hosts from your SSH config file</span>
                                            <span className="mt-2 text-[11px] font-medium text-app-accent/90">Recommended if config already exists</span>
                                        </div>
                                    </div>
                                </button>
                                <button
                                    type="button"
                                    onClick={handleImportConnectionsFile}
                                    className="group rounded-xl border border-[var(--color-app-border)]/60 bg-[var(--color-app-surface)]/35 p-3.5 text-left transition-all hover:border-[var(--color-app-accent)]/35 hover:bg-[var(--color-app-surface)]"
                                >
                                    <div className="flex items-start gap-3">
                                        <div className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-[var(--color-app-border)] bg-[var(--color-app-bg)] text-[var(--color-app-accent)]">
                                            <Files className="w-4 h-4" />
                                        </div>
                                        <div className="flex min-w-0 flex-1 flex-col">
                                            <span className="text-sm font-semibold text-app-text">Import File</span>
                                            <span className="mt-0.5 text-xs text-app-muted leading-relaxed">Load connections from Zync, JSON, or CSV export files</span>
                                            <span className="mt-2 text-[11px] font-medium text-app-accent/90">Best for bulk secure-to-vault cleanup</span>
                                        </div>
                                    </div>
                                </button>
                            </div>
                        </div>
                    </div>
                ) : (
                    <>
                        <div className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden p-4 space-y-4">
                            <section className="rounded-xl border border-app-border/60 bg-app-surface/25 p-4 space-y-4">
                                <h4 className="text-xs font-semibold uppercase tracking-wider text-app-muted">Identity</h4>
                                <Input
                                    label="Name"
                                    placeholder="Production DB"
                                    value={formData.name}
                                    onChange={e => setFormData({ ...formData, name: e.target.value })}
                                    autoFocus
                                />
                                <div className="grid grid-cols-[1fr_7rem] gap-4">
                                    <Input
                                        label="Host"
                                        placeholder="192.168.1.1"
                                        value={formData.host}
                                        onChange={e => {
                                            setTouched((prev) => ({ ...prev, host: true }));
                                            setFormData({ ...formData, host: e.target.value });
                                        }}
                                        error={visibleHostError}
                                    />
                                    <Input
                                        label="Port"
                                        type="number"
                                        placeholder="22"
                                        value={formData.port ?? ''}
                                        onChange={e => {
                                            setTouched((prev) => ({ ...prev, port: true }));
                                            if (e.target.value === '') {
                                                setFormData({ ...formData, port: undefined });
                                                return;
                                            }
                                            const p = parseInt(e.target.value, 10);
                                            if (!isNaN(p)) setFormData({ ...formData, port: p });
                                        }}
                                        error={visiblePortError}
                                    />
                                </div>
                                <Input
                                    label="Username"
                                    placeholder="root"
                                    value={formData.username}
                                    onChange={e => {
                                        setTouched((prev) => ({ ...prev, username: true }));
                                        setFormData({ ...formData, username: e.target.value });
                                    }}
                                    error={visibleUsernameError}
                                />
                            </section>

                            <section className="rounded-xl border border-app-border/60 bg-app-surface/25 p-4 space-y-4">
                                <h4 className="text-xs font-semibold uppercase tracking-wider text-app-muted">Authentication</h4>
                                <div>
                                    <label className="text-xs font-semibold text-app-muted uppercase tracking-wider block mb-3">Method</label>
                                    <div className="flex gap-4 p-1 bg-app-surface/50 rounded-lg w-fit border border-app-border">
                                        <button
                                            onClick={() => setAuthMethod('password')}
                                            className={cn(
                                                "px-4 py-1.5 rounded-md text-sm font-medium transition-all",
                                                authMethod === 'password' ? "bg-app-accent text-white shadow-sm" : "text-app-muted hover:text-app-text"
                                            )}
                                        >
                                            Password
                                        </button>
                                        <button
                                            onClick={() => setAuthMethod('key')}
                                            className={cn(
                                                "px-4 py-1.5 rounded-md text-sm font-medium transition-all",
                                                authMethod === 'key' ? "bg-app-accent text-white shadow-sm" : "text-app-muted hover:text-app-text"
                                            )}
                                        >
                                            Private Key
                                        </button>
                                        {vaultAvailable && (
                                            <button
                                                type="button"
                                                onClick={() => setAuthMethod('vault')}
                                                className={cn(
                                                    "px-4 py-1.5 rounded-md text-sm font-medium transition-all flex items-center gap-1.5",
                                                    authMethod === 'vault' ? "bg-app-accent text-white shadow-sm" : "text-app-muted hover:text-app-text"
                                                )}
                                            >
                                                <Shield size={13} />
                                                Vault
                                            </button>
                                        )}
                                    </div>
                                </div>

                                {authMethod === 'password' ? (
                                    <div className="space-y-3">
                                        {vaultAvailable ? (
                                            <div className="space-y-2">
                                                <div
                                                    className="flex w-fit flex-wrap gap-1 rounded-lg border border-app-border bg-app-surface/50 p-0.5"
                                                    role="radiogroup"
                                                    aria-label="Password storage"
                                                >
                                                    <button
                                                        type="button"
                                                        role="radio"
                                                        aria-checked={passwordStorage === 'host'}
                                                        onClick={() => setPasswordStorage('host')}
                                                        className={cn(
                                                            'inline-flex items-center gap-1.5 rounded-md px-3 py-1 text-xs font-medium transition-all',
                                                            passwordStorage === 'host'
                                                                ? 'bg-app-accent text-white shadow-sm'
                                                                : 'text-app-muted hover:text-app-text',
                                                        )}
                                                    >
                                                        <Laptop size={11} />
                                                        On this host
                                                    </button>
                                                    <button
                                                        type="button"
                                                        role="radio"
                                                        aria-checked={passwordStorage === 'vault'}
                                                        onClick={() => setPasswordStorage('vault')}
                                                        className={cn(
                                                            'inline-flex items-center gap-1.5 rounded-md px-3 py-1 text-xs font-medium transition-all',
                                                            passwordStorage === 'vault'
                                                                ? 'bg-app-accent text-white shadow-sm'
                                                                : 'text-app-muted hover:text-app-text',
                                                        )}
                                                    >
                                                        <Shield size={11} />
                                                        Save to Vault
                                                    </button>
                                                </div>
                                                <p className="text-[10px] leading-4 text-app-muted/70">
                                                    {passwordStorage === 'vault'
                                                        ? 'Creates an SSH password credential in Vault and links this host (no plaintext on the host).'
                                                        : 'Saved with the host record. You can move it to Vault later.'}
                                                </p>
                                                {passwordStorage === 'vault' && (
                                                    <div className="space-y-1">
                                                        <Input
                                                            label="Name in Vault"
                                                            value={keyVaultLabel}
                                                            placeholder="e.g. Production login"
                                                            error={keyVaultLabelConflict ? 'A Vault item with this name already exists.' : undefined}
                                                            onChange={event => setKeyVaultLabel(event.target.value)}
                                                        />
                                                        {!keyVaultLabel.trim() && (
                                                            <p className="text-[10px] text-app-muted/60">
                                                                Leave blank to use “{defaultPasswordVaultLabel}”.
                                                            </p>
                                                        )}
                                                    </div>
                                                )}
                                            </div>
                                        ) : null}
                                        <Input
                                            label="Password"
                                            type="password"
                                            value={formData.password}
                                            onChange={e => setFormData({ ...formData, password: e.target.value })}
                                        />
                                        {!vaultAvailable && formData.password && vaultStatus?.status !== 'uninitialized' ? (
                                            <p className="text-[10px] text-app-muted/70">
                                                Password is saved locally. Open Vault tab to secure it later.
                                            </p>
                                        ) : null}
                                    </div>
                                ) : authMethod === 'key' ? (
                                    <div className="space-y-3">
                                        <div className="flex gap-1 p-0.5 bg-app-surface/50 rounded-lg w-fit border border-app-border">
                                            <button
                                                type="button"
                                                onClick={() => setKeyInputMode('file')}
                                                className={cn(
                                                    "px-3 py-1 rounded-md text-xs font-medium transition-all flex items-center gap-1.5",
                                                    keyInputMode === 'file' ? "bg-app-accent text-white shadow-sm" : "text-app-muted hover:text-app-text"
                                                )}
                                            >
                                                <FileText size={11} /> File
                                            </button>
                                            <button
                                                type="button"
                                                onClick={() => setKeyInputMode('paste')}
                                                className={cn(
                                                    "px-3 py-1 rounded-md text-xs font-medium transition-all flex items-center gap-1.5",
                                                    keyInputMode === 'paste' ? "bg-app-accent text-white shadow-sm" : "text-app-muted hover:text-app-text"
                                                )}
                                            >
                                                <KeyRound size={11} /> Paste
                                            </button>
                                        </div>
                                        {keyInputMode === 'file' ? (
                                            <div className="space-y-2">
                                                <div className="flex gap-2">
                                                    <Input
                                                        className="flex-1"
                                                        readOnly
                                                        placeholder="No key selected"
                                                        value={formData.privateKeyPath ? formData.privateKeyPath.split(/[/\\]/).pop() : ''}
                                                        error={visibleKeyPathError}
                                                    />
                                                    <Button variant="secondary" onClick={handleBrowseKey}>Browse</Button>
                                                </div>
                                                {formData.privateKeyPath && (
                                                    <p className="text-[10px] text-app-muted/70">
                                                        Key file path is stored and read at connect time.
                                                        {vaultStatus?.status !== 'uninitialized' ? ' Open Vault tab to secure it later.' : ''}
                                                    </p>
                                                )}
                                            </div>
                                        ) : (
                                            <div className="space-y-2">
                                                <PastedKeyTextarea
                                                    value={pastedKeyText}
                                                    error={pastedKeyError}
                                                    onChange={(next) => {
                                                        setPastedKeyText(next);
                                                        if (pastedKeyError) setPastedKeyError('');
                                                    }}
                                                />
                                                <p className="text-[10px] text-app-muted/70">
                                                    On save, Zync writes this key into a managed local file and stores only the path on the host (not in vault).
                                                </p>
                                            </div>
                                        )}
                                        <PrivateKeyInspectionFeedback
                                            inspection={localKeyInspection}
                                            allowDeferredPassphrase
                                        />
                                        {localKeyVaultError && (
                                            <p className="text-[10px] text-red-400">{localKeyVaultError}</p>
                                        )}
                                        {localKeyInspection.encrypted
                                            && (!keyRememberedOnDevice || keyPassphraseRetention === 'vault')
                                            && (
                                            <KeyPassphraseInput
                                                placeholder={keyPassphraseRetention === 'vault'
                                                    ? 'Required to save this key in Vault'
                                                    : 'Enter the passphrase'}
                                                value={formData.password || ''}
                                                onChange={password => setFormData({ ...formData, password })}
                                            />
                                        )}
                                        {localKeyInspection.encrypted && ((formData.password || '').length > 0 || localKeyInspection.remembered) && (
                                            <div className="space-y-2">
                                                <KeyPassphraseRetentionOptions
                                                    value={keyPassphraseRetention}
                                                    onChange={setKeyPassphraseRetention}
                                                    vaultAvailable={vaultAvailable}
                                                    rememberedOnDevice={keyRememberedOnDevice}
                                                    isForgetting={isForgettingKeyPassphrase}
                                                    onForgetFromDevice={() => { void forgetCurrentDevicePassphrase(); }}
                                                />
                                                {keyPassphraseRetention === 'vault' && (
                                                    <Input
                                                        label="Vault credential name"
                                                        value={keyVaultLabel}
                                                        placeholder={defaultKeyVaultLabel}
                                                        error={keyVaultLabelConflict ? 'A Vault item with this name already exists.' : undefined}
                                                        onChange={event => setKeyVaultLabel(event.target.value)}
                                                    />
                                                )}
                                            </div>
                                        )}
                                    </div>
                                ) : (
                                    <div className="space-y-3">
                                        <div className="flex flex-wrap gap-1 p-0.5 bg-app-surface/50 rounded-lg w-fit border border-app-border">
                                            <button
                                                type="button"
                                                onClick={() => setVaultInputMode('existing')}
                                                className={cn(
                                                    "px-3 py-1 rounded-md text-xs font-medium transition-all",
                                                    vaultInputMode === 'existing' ? "bg-app-accent text-white shadow-sm" : "text-app-muted hover:text-app-text"
                                                )}
                                            >
                                                Existing
                                            </button>
                                            <button
                                                type="button"
                                                onClick={() => setVaultInputMode('paste')}
                                                className={cn(
                                                    "px-3 py-1 rounded-md text-xs font-medium transition-all flex items-center gap-1.5",
                                                    vaultInputMode === 'paste' ? "bg-app-accent text-white shadow-sm" : "text-app-muted hover:text-app-text"
                                                )}
                                            >
                                                <KeyRound size={11} /> Paste
                                            </button>
                                            <button
                                                type="button"
                                                onClick={() => setVaultInputMode('import')}
                                                className={cn(
                                                    "px-3 py-1 rounded-md text-xs font-medium transition-all flex items-center gap-1.5",
                                                    vaultInputMode === 'import' ? "bg-app-accent text-white shadow-sm" : "text-app-muted hover:text-app-text"
                                                )}
                                            >
                                                <FileText size={11} /> Import file
                                            </button>
                                        </div>

                                        {vaultInputMode === 'existing' ? (
                                            <div className="space-y-2">
                                                <label className="text-xs font-semibold text-app-muted uppercase tracking-wider block">Vault Credential</label>
                                                {vaultItems.length === 0 ? (
                                                    vaultStatus?.status === 'locked' ? (
                                                        <div className="space-y-2 rounded-lg border border-app-border bg-app-bg/50 px-3 py-2.5">
                                                            <p className="text-xs text-app-muted">
                                                                Unlock the vault to choose an existing credential.
                                                            </p>
                                                            <Button
                                                                type="button"
                                                                size="sm"
                                                                variant="secondary"
                                                                onClick={() => { void requestVaultUnlock(); }}
                                                            >
                                                                Unlock vault
                                                            </Button>
                                                        </div>
                                                    ) : (
                                                        <p className="text-xs text-app-muted rounded-lg border border-app-border bg-app-bg/50 px-3 py-2.5">
                                                            No items in vault yet. Use Paste or Import file, or add credentials in the Vault tab.
                                                        </p>
                                                    )
                                                ) : (
                                                    <Select
                                                        value={formData.authRef?.itemId || ''}
                                                        onChange={(val) => {
                                                            const item = vaultItems.find(i => i.id === val);
                                                            if (!item) return;
                                                            if (vaultStatus?.status !== 'unlocked') return;
                                                            const vaultId = vaultStatus.vaultId;
                                                            setFormData({
                                                                ...formData,
                                                                password: undefined,
                                                                privateKeyPath: undefined,
                                                                authRef: {
                                                                    vaultId,
                                                                    credentialId: item.logicalId,
                                                                    itemId: item.id,
                                                                    itemKind: item.kind as NonNullable<Connection['authRef']>['itemKind'],
                                                                    purpose: 'ssh-auth',
                                                                },
                                                            });
                                                        }}
                                                        options={vaultItems.map(item => ({
                                                            value: item.id,
                                                            label: item.label,
                                                            description: item.kind,
                                                            icon: <div className="flex h-6 w-6 items-center justify-center rounded-md bg-app-surface border border-app-border text-app-muted"><Shield className="w-3 h-3" /></div>,
                                                        }))}
                                                        placeholder="Select a vault credential…"
                                                        portal
                                                    />
                                                )}
                                                {formData.authRef && (
                                                    <p className="text-[10px] text-emerald-400/80">
                                                        Using vault item · {formData.authRef.itemId.slice(0, 8)}
                                                    </p>
                                                )}
                                            </div>
                                        ) : (
                                            <div className="space-y-2">
                                                {vaultStatus?.status === 'unlocked' && (
                                                    <div className="space-y-1.5">
                                                        <div className="flex items-center gap-2">
                                                            <label className="text-[10px] text-app-muted shrink-0">Vault label</label>
                                                            <input
                                                                type="text"
                                                                value={keyVaultLabel}
                                                                onChange={e => setKeyVaultLabel(e.target.value)}
                                                                placeholder={defaultKeyVaultLabel}
                                                                className="flex-1 rounded-md border border-app-border/60 bg-app-bg px-2 py-1 text-[11px] text-app-text placeholder:text-app-muted/40 focus:outline-none focus:ring-1 focus:ring-app-accent/50"
                                                            />
                                                        </div>
                                                        {keyVaultLabelConflict && (
                                                            <p className="text-[10px] text-amber-400/90 flex items-center gap-1">
                                                                <Shield size={10} /> A vault item with this label already exists — rename to avoid a duplicate.
                                                            </p>
                                                        )}
                                                    </div>
                                                )}
                                                {vaultInputMode === 'import' && (
                                                    <div className="flex gap-2">
                                                        <Button variant="secondary" onClick={handleBrowseVaultImportKey}>
                                                            Choose key file
                                                        </Button>
                                                        {pastedKeyText.trim() && (
                                                            <p className="text-[10px] text-app-muted self-center truncate">
                                                                Key loaded · ready to store in vault
                                                            </p>
                                                        )}
                                                    </div>
                                                )}
                                                {vaultInputMode === 'paste' && (
                                                    <PastedKeyTextarea
                                                        value={pastedKeyText}
                                                        error={pastedKeyError}
                                                        onChange={(next) => {
                                                            setPastedKeyText(next);
                                                            if (pastedKeyError) setPastedKeyError('');
                                                        }}
                                                    />
                                                )}
                                                {vaultInputMode === 'import' && pastedKeyText.trim() && (
                                                    <textarea
                                                        value={pastedKeyText}
                                                        readOnly
                                                        className="w-full h-20 rounded-lg border border-app-border bg-app-bg/70 px-3 py-2 text-xs font-mono text-app-muted resize-none"
                                                    />
                                                )}
                                                {vaultInputMode === 'import' && pastedKeyError && (
                                                    <p className="text-[10px] text-red-400">{pastedKeyError}</p>
                                                )}
                                                <PrivateKeyInspectionFeedback inspection={vaultKeyInspection} />
                                                {vaultKeyInspection.encrypted && (
                                                    <Input
                                                        label="Key passphrase"
                                                        type="password"
                                                        placeholder="Enter the passphrase"
                                                        value={pastedPassphrase}
                                                        onChange={e => setPastedPassphrase(e.target.value)}
                                                    />
                                                )}
                                                {vaultStatus?.status !== 'unlocked' && (
                                                    <p className="text-[10px] text-amber-400/80 flex items-center gap-1">
                                                        <Shield size={10} /> Vault must be unlocked to store this key.
                                                    </p>
                                                )}
                                                {vaultStatus?.status === 'unlocked' && (
                                                    <p className="text-[10px] text-emerald-400/70 flex items-center gap-1">
                                                        <Shield size={10} /> Key will be encrypted in vault on save.
                                                    </p>
                                                )}
                                            </div>
                                        )}
                                    </div>
                                )}

                                {credentialHealthChecks.length > 0 && (
                                    <div className="rounded-md border border-app-border bg-app-bg/50 px-3 py-2 text-[11px] space-y-1">
                                        {credentialHealthChecks.map((check, index) => (
                                            <p
                                                key={`${check.message}-${index}`}
                                                className={cn(
                                                    check.severity === 'warning' ? 'text-amber-300' : 'text-app-muted'
                                                )}
                                            >
                                                {check.message}
                                            </p>
                                        ))}
                                    </div>
                                )}

                                {duplicateConnection && (
                                    <div className={cn(
                                        "w-full rounded-md border px-3 py-2 text-xs",
                                        allowDuplicateEndpoint
                                            ? "border-green-500/40 bg-green-500/10 text-green-300"
                                            : "border-amber-500/40 bg-amber-500/10 text-amber-300"
                                    )}>
                                        <p className="font-semibold mb-1">Duplicate endpoint detected</p>
                                        <p>
                                            <span className="font-medium">{duplicateConnection.name || duplicateConnection.host}</span>
                                            {' '}already uses {duplicateConnection.username}@{duplicateConnection.host}:{duplicateConnection.port}.
                                        </p>
                                        <label className={cn(
                                            "mt-2 flex items-center gap-2 text-[11px]",
                                            allowDuplicateEndpoint ? "text-green-200" : "text-amber-200"
                                        )}>
                                            <input
                                                type="checkbox"
                                                checked={allowDuplicateEndpoint}
                                                onChange={(event) => setAllowDuplicateEndpoint(event.target.checked)}
                                                className="h-3.5 w-3.5 rounded border-app-border bg-app-bg"
                                            />
                                            Allow duplicate endpoint anyway
                                        </label>
                                    </div>
                                )}
                            </section>

                            <section className="rounded-xl border border-app-border/60 bg-app-surface/25">
                                <button
                                    type="button"
                                    className="w-full flex items-center justify-between px-4 py-3 text-left"
                                    onClick={() => setIsAppearanceOpen((prev) => !prev)}
                                >
                                    <div>
                                        <h4 className="text-xs font-semibold uppercase tracking-wider text-app-muted">Appearance (Optional)</h4>
                                        <p className="mt-1 text-[11px] text-app-muted">Folder, color label, and icon.</p>
                                    </div>
                                    {isAppearanceOpen ? <ChevronDown size={14} className="text-app-muted" /> : <ChevronRight size={14} className="text-app-muted" />}
                                </button>
                                {isAppearanceOpen && (
                                    <div className="space-y-4 px-4 pb-4">
                                        <div className="grid grid-cols-2 gap-4">
                                            <div>
                                                <Input
                                                    label="Folder (Optional)"
                                                    placeholder="e.g. Production"
                                                    value={formData.folder || ''}
                                                    onChange={e => setFormData({ ...formData, folder: e.target.value })}
                                                    list="folder-suggestions"
                                                />
                                                <datalist id="folder-suggestions">
                                                    {folders.map(f => <option key={f.name} value={f.name} />)}
                                                </datalist>
                                            </div>
                                            <div>
                                                <label className="text-xs font-semibold text-app-muted uppercase tracking-wider block mb-2">Color Label</label>
                                                <div className="flex gap-2">
                                                    {THEMES.map(theme => (
                                                        <button
                                                            key={theme.id}
                                                            onClick={() => setFormData({ ...formData, theme: theme.id })}
                                                            className={cn(
                                                                "h-9 w-9 rounded-full border-2 transition-all flex items-center justify-center",
                                                                theme.color,
                                                                formData.theme === theme.id ? "ring-2 ring-white scale-110" : "opacity-70 hover:opacity-100 hover:scale-105"
                                                            )}
                                                            title={theme.label}
                                                        >
                                                            {formData.theme === theme.id && <div className="w-2.5 h-2.5 rounded-full bg-white/80" />}
                                                        </button>
                                                    ))}
                                                </div>
                                            </div>
                                        </div>
                                        <div>
                                            <div className="flex items-center justify-between mb-2">
                                                <label className="text-xs font-semibold text-app-muted uppercase tracking-wider block">Icon</label>
                                                <Button variant="ghost" size="sm"
                                                    type="button"
                                                    className="text-app-accent"
                                                    onClick={() => setShowAllIcons((prev) => !prev)}
                                                >
                                                    {showAllIcons ? 'Show less' : 'Show more'}
                                                </Button>
                                            </div>
                                            <div className="grid grid-cols-[repeat(auto-fill,minmax(2.25rem,1fr))] gap-2">
                                                {visibleIcons.map(iconName => (
                                                    <IconButton
                                                        key={iconName}
                                                        label={iconName}
                                                        icon={<OSIcon icon={iconName} className="w-5 h-5" />}
                                                        size="md"
                                                        aria-pressed={(formData.icon || 'Server').toLowerCase() === iconName.toLowerCase()}
                                                        onClick={() => setFormData({ ...formData, icon: iconName })}
                                                        className={cn(
                                                            "w-full border",
                                                            (formData.icon || 'Server').toLowerCase() === iconName.toLowerCase()
                                                                ? "bg-app-accent/20 border-app-accent text-app-accent"
                                                                : "bg-app-bg border-app-border text-app-muted"
                                                        )}
                                                        title={iconName}
                                                    />
                                                ))}
                                            </div>
                                        </div>
                                    </div>
                                )}
                            </section>

                            <section className="rounded-xl border border-app-border/60 bg-app-surface/25">
                                <button
                                    type="button"
                                    className="w-full flex items-center justify-between px-4 py-3 text-left"
                                    onClick={() => setIsAdvancedOpen((prev) => !prev)}
                                >
                                    <div>
                                        <h4 className="text-xs font-semibold uppercase tracking-wider text-app-muted">Advanced (Optional)</h4>
                                        <p className="mt-1 text-[11px] text-app-muted">Jump host and agent forwarding.</p>
                                    </div>
                                    {isAdvancedOpen ? <ChevronDown size={14} className="text-app-muted" /> : <ChevronRight size={14} className="text-app-muted" />}
                                </button>
                                {isAdvancedOpen && (
                                    <div className="space-y-4 px-4 pb-4">
                                        <div>
                                            <Select
                                            label="Jump Server (Bastion)"
                                            value={formData.jumpServerId || ''}
                                            onChange={(val) => setFormData({ ...formData, jumpServerId: val === '' ? undefined : val })}
                                            portal
                                            options={[
                                                {
                                                    value: '',
                                                    label: 'None (Direct Connection)',
                                                    icon: (
                                                        <div className="flex h-6 w-6 items-center justify-center rounded-md bg-app-surface border border-app-border opacity-60">
                                                            <Laptop className="w-3.5 h-3.5" />
                                                        </div>
                                                    )
                                                },
                                                ...connections.filter(c => c.id !== activeEditingConnectionId).map(c => ({
                                                    value: c.id,
                                                    label: c.name || c.host,
                                                    description: `${c.username}@${c.host}`,
                                                    icon: (
                                                        <div className="flex h-6 w-6 items-center justify-center rounded-md bg-app-surface border border-app-border">
                                                            <OSIcon icon={c.icon || 'Server'} className="w-3.5 h-3.5" />
                                                        </div>
                                                    )
                                                }))
                                            ]}
                                            placeholder="Select a Jump Server..."
                                            />
                                            <p className="text-[10px] text-app-muted/70 mt-1 pl-1">Route this connection through another SSH server.</p>
                                            {jumpCycleWarning && (
                                                <p className="text-[10px] text-amber-400/90 flex items-center gap-1 mt-1 pl-1">
                                                    <AlertCircle size={10} /> Jump chain creates a loop — this connection will not be reachable.
                                                </p>
                                            )}
                                        </div>

                                        <div className="border-t border-app-border/70 pt-2">
                                            <Toggle
                                                label="Forward an SSH key"
                                                description="Let this host request authentication with one selected key. Every signature asks first."
                                                checked={Boolean(formData.agentForwardingKeyConnectionId)}
                                                disabled={!selfCanForwardKey && forwardableConnections.length === 0}
                                                onChange={enabled => setFormData(previous => ({
                                                    ...previous,
                                                    agentForwardingKeyConnectionId: enabled
                                                        ? (selfCanForwardKey
                                                            ? SELF_AGENT_FORWARDING_KEY
                                                            : PICK_AGENT_FORWARDING_KEY)
                                                        : undefined,
                                                }))}
                                            />
                                            {formData.agentForwardingKeyConnectionId && (
                                                <div className="mt-2 space-y-2 px-1">
                                                    <Select
                                                        label="Key to Forward"
                                                        value={needsForwardingKeyPick ? '' : formData.agentForwardingKeyConnectionId}
                                                        onChange={value => setFormData(previous => ({
                                                            ...previous,
                                                            agentForwardingKeyConnectionId: value,
                                                        }))}
                                                        portal
                                                        options={[
                                                            ...(selfCanForwardKey ? [{
                                                                value: SELF_AGENT_FORWARDING_KEY,
                                                                label: "This connection's authentication key",
                                                                description: 'Use the private key selected above.',
                                                                icon: (
                                                                    <div className="flex h-6 w-6 items-center justify-center rounded-md border border-app-border bg-app-surface">
                                                                        <KeyRound className="h-3.5 w-3.5" />
                                                                    </div>
                                                                ),
                                                            }] : []),
                                                            ...forwardableConnections.map(connection => ({
                                                                value: connection.id,
                                                                label: connection.name || connection.host,
                                                                description: `${connection.username}@${connection.host}`,
                                                                icon: (
                                                                    <div className="flex h-6 w-6 items-center justify-center rounded-md border border-app-border bg-app-surface">
                                                                        <Forward className="h-3.5 w-3.5" />
                                                                    </div>
                                                                ),
                                                            })),
                                                        ]}
                                                        placeholder="Select one private key..."
                                                    />
                                                    <p className="flex items-start gap-1.5 text-[10px] leading-relaxed text-amber-400/90">
                                                        <Shield size={11} className="mt-0.5 shrink-0" />
                                                        The remote host can see this public key. Signing still requires your approval.
                                                    </p>
                                                </div>
                                            )}
                                            {!selfCanForwardKey && forwardableConnections.length === 0 && (
                                                <p className="px-4 pb-2 text-[10px] leading-relaxed text-app-muted">
                                                    Save a private-key connection first, or choose private-key authentication above.
                                                </p>
                                            )}
                                        </div>
                                    </div>
                                )}
                            </section>
                        </div>

                        <div className="shrink-0 border-t border-app-border bg-app-bg/95 backdrop-blur-sm">
                            {testMessage && (
                                <div className="px-4 pt-2.5 pb-0 space-y-1">
                                    <p className={cn(
                                        "text-xs",
                                        testStatus === 'success' ? 'text-green-400' :
                                            testStatus === 'error' ? 'text-red-400' : 'text-app-muted'
                                    )}>
                                        {testMessage}
                                    </p>
                                </div>
                            )}
                            {!testMessage && testDisabledReason && (
                                <div className="px-4 pt-2.5 pb-0">
                                    <p className="text-xs text-amber-400/90">{testDisabledReason}</p>
                                </div>
                            )}
                            <div className="flex flex-wrap items-center justify-between gap-3 px-4 py-2.5">
                                <Toolbar label="Connection test actions" className="gap-2">
                                    {!activeEditingConnectionId && (
                                        <Button type="button" variant="ghost" size="sm" onClick={() => setEntryMode('chooser')}>
                                            Change Mode
                                        </Button>
                                    )}
                                    <Button
                                        type="button"
                                        variant="ghost"
                                        size="sm"
                                        onClick={() => { void handleTestConnection(); }}
                                        disabled={!canTest}
                                        className={cn(
                                            "gap-2 min-w-fit",
                                            testStatus === 'success' && "text-green-500 hover:text-green-600 hover:bg-green-500/10",
                                            testStatus === 'error' && "text-red-500 hover:text-red-600 hover:bg-red-500/10"
                                        )}
                                    >
                                        {testStatus === 'testing' ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> :
                                            testStatus === 'success' ? <CheckCircle2 className="w-3.5 h-3.5" /> :
                                                testStatus === 'error' ? <AlertCircle className="w-3.5 h-3.5" /> :
                                                    <ShieldCheck className="w-3.5 h-3.5" />}
                                        <span>{testStatus === 'testing' ? 'Testing...' : 'Test'}</span>
                                    </Button>
                                </Toolbar>
                                <Toolbar label="Save connection actions" className="ml-auto gap-2">
                                    <Button
                                        type="button"
                                        variant="secondary"
                                        size="sm"
                                        disabled={!canSave || isSaving}
                                        onClick={handleSave}
                                    >
                                        {activeEditingConnectionId ? 'Save' : 'Create'}
                                    </Button>
                                    <Button
                                        type="button"
                                        variant="primary"
                                        size="sm"
                                        disabled={!canSave || isSaving}
                                        onClick={handleSaveAndConnect}
                                    >
                                        {activeEditingConnectionId ? 'Save & Open' : 'Save & Connect'}
                                    </Button>
                                </Toolbar>
                            </div>
                        </div>
                    </>
                )}
            </div>

            {isImportModalOpen && (
                <Suspense fallback={null}>
                    <ImportSshModal
                        isOpen={isImportModalOpen}
                        onClose={() => setIsImportModalOpen(false)}
                        onImport={(configs) => {
                            importConnections(configs);
                            lastImportPlaintextCountRef.current = configs.filter(
                                c => !c.connection.authRef && (c.connection.password || c.connection.privateKeyPath)
                            ).length;
                        }}
                        onImportReport={(report) => {
                            const renamedSuffix = report.renamed.length > 0
                                ? `, renamed ${report.renamed.length}`
                                : '';
                            const conflictSuffix = report.conflicted > 0
                                ? `, ${report.conflicted} conflicts`
                                : '';
                            const count = lastImportPlaintextCountRef.current;
                            const migrationSuffix = count > 0 && vaultStatus?.status !== 'uninitialized'
                                ? ` — ${count} have plaintext credentials. Open Vault tab to secure them to vault.`
                                : '.';
                            showToast(
                                'success',
                                `Imported ${report.selected}: ${report.created} new, ${report.updated} updated, ${report.skipped} skipped${conflictSuffix}${renamedSuffix}${migrationSuffix}`
                            );
                            lastImportPlaintextCountRef.current = 0;
                            setIsImportModalOpen(false);
                            onClose();
                        }}
                    />
                </Suspense>
            )}
        </Modal>
    );
}

import { registerModal } from '../../lib/modalRegistry';
registerModal('addConnection', AddConnectionModal);
