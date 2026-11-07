import { open } from '@tauri-apps/plugin-dialog';
import {
    AlertCircle,
    ArrowLeft,
    CheckCircle2,
    ChevronDown,
    ChevronRight,
    FileText,
    Forward,
    KeyRound,
    Laptop,
    Loader2,
    Shield,
    ShieldCheck,
} from 'lucide-react';
import { lazy, Suspense, useEffect, useMemo, useRef, useState } from 'react';

import { connectWithHostKeyVerification } from '../../features/connections/application/hostKeyVerification';
import type { KeyPassphraseRetention } from '../../features/connections/application/keyPassphrasePrompt';
import { stageKeyPassphraseForNextConnect } from '../../features/connections/application/keyPassphraseRuntime';
import {
    cancelNetworkPrompts,
    NetworkSelectionCancelledError,
    persistHostWithNetwork,
    prepareNetworkInterface,
} from '../../features/connections/application/networkInterface';
import {
    buildConnectionSavePayload,
    buildConnectionTestPayload,
    canSaveInspectedPrivateKey,
    connectionHasForwardableKey,
    getCredentialHealthChecks,
    SELF_AGENT_FORWARDING_KEY,
    shouldAutoConnectOnOpenTab,
} from '../../features/connections/domain';
import { connectionFailureSummary } from '../../features/connections/domain/formPresentation';
import { connectionTestDependencies } from '../../features/connections/domain/formTransforms';
import {
    type ConnectionConfigPayload,
    deleteEphemeralKeyIpc,
    forgetKeyPassphraseIpc,
    readLocalKeyFileIpc,
    rememberKeyPassphraseIpc,
    testConnectionIpc,
    writeEphemeralKeyIpc,
} from '../../features/connections/infrastructure/connectionIpc';
import {
    type ConnectionExchangeImportFormat,
    importConnectionsFromFileIpc,
} from '../../features/connections/infrastructure/connectionTransfer';
import { SshVerificationCancelledError } from '../../features/connections/infrastructure/sshVerificationIpc';
import { openSerialProfileEditor } from '../../features/serial/ui/SerialProfileManager';
import { openVncProfileEditor } from '../../features/vnc/ui/VncProfileManager';
import { cn } from '../../lib/utils';
import { Connection, useAppStore } from '../../store/useAppStore';
import { getSshVaultItemKind, PASSWORD_CREDENTIAL_KIND } from '../../vault/credentialTypes';
import { useVaultStore } from '../../vault/useVaultStore';
import { isVaultInUseError, VAULT_IN_USE_USER_MESSAGE } from '../../vault/vaultLoading';
import { isVaultAccessError } from '../../vault/vaultUnlockPrompt';
import { ConnectionTypeChooser } from '../connections/ConnectionTypeChooser';
import { KeyPassphraseInput } from '../connections/KeyPassphraseInput';
import { KeyPassphraseRetentionOptions } from '../connections/KeyPassphraseRetentionOptions';
import { NetworkInterfaceControl } from '../connections/NetworkInterfaceControl';
import { useHostNetworkPreference } from '../connections/useHostNetworkPreference';
import { OSIcon } from '../icons/OSIcon';
import { Toggle } from '../settings/common/Toggle';
import { Button } from '../ui/Button';
import { IconButton } from '../ui/IconButton';
import { Input } from '../ui/Input';
import { Modal } from '../ui/Modal';
import { Select } from '../ui/Select';
import { Toolbar } from '../ui/Toolbar';
import { useAutoVault } from './useAutoVault';
import { useConnectionForm } from './useConnectionForm';
import { type PrivateKeyInspectionState, usePrivateKeyInspection } from './usePrivateKeyInspection';

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
    'Server',
    'Database',
    'Cloud',
    'Terminal',
    'Code',
    'Box',
    'Monitor',
    'Globe',
    'HardDrive',
    'Ubuntu',
    'Debian',
    'CentOS',
    'Arch',
    'Kali',
    'macOS',
    'Windows',
    'Linux',
    'AWS',
    'Jenkins',
    'MongoDB',
    'Nginx',
    'PostgreSQL',
    'MySql',
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
            {error && <p className="text-[10px] text-red-400">{error}</p>}
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
    if (inspection.status === 'idle') {
        return null;
    }
    if (inspection.status === 'checking') {
        return (
            <p className="flex items-center gap-1 text-[10px] text-app-muted">
                <Loader2
                    size={10}
                    className="animate-spin"
                />{' '}
                Checking private key...
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

/** Edit one host using shared auth transforms, secret retention and device routing boundaries. */
export function AddConnectionModal({
    isOpen,
    onClose,
    editingConnectionId,
}: AddConnectionModalProps) {
    const importConnections = useAppStore((state) => state.importConnections);
    const saveTunnel = useAppStore((state) => state.saveTunnel);
    const showToast = useAppStore((state) => state.showToast);
    const showConfirmDialog = useAppStore((state) => state.showConfirmDialog);
    const openTab = useAppStore((state) => state.openTab);
    const requestVaultUnlock = useVaultStore((state) => state.requestUnlock);
    const [keyPassphraseRetention, setKeyPassphraseRetention] =
        useState<KeyPassphraseRetention>('once');
    /** Password auth: keep on host record, or write ssh-password vault item on save. */
    const [passwordStorage, setPasswordStorage] = useState<'host' | 'vault'>('host');
    const [keyInspectionRevision, setKeyInspectionRevision] = useState(0);
    const [isForgettingKeyPassphrase, setIsForgettingKeyPassphrase] = useState(false);
    const [rememberedKeyPath, setRememberedKeyPath] = useState<string | null>(null);
    const retentionDefaultedKeyPathRef = useRef<string | null>(null);

    const {
        connections,
        folders,
        addConnection,
        editConnection,
        formData,
        setFormData,
        authMethod,
        setAuthMethod,
        keyInputMode,
        setKeyInputMode,
        vaultInputMode,
        setVaultInputMode,
        setTouched,
        setSubmitAttempted,
        allowDuplicateEndpoint,
        setAllowDuplicateEndpoint,
        activeEditingConnectionId,
        validation,
        visibleHostError,
        visibleUsernameError,
        visiblePortError,
        visibleKeyPathError,
        duplicateConnection,
        jumpCycleWarning,
        saveForm,
    } = useConnectionForm(isOpen, editingConnectionId);

    const {
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
        keyVaultLabelConflict,
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
    const sshVaultItems = useMemo(
        () =>
            vaultItems.flatMap((item) => {
                const kind = getSshVaultItemKind(item.kind);
                return kind ? [{ ...item, kind }] : [];
            }),
        [vaultItems],
    );

    const [testStatus, setTestStatus] = useState<'idle' | 'testing' | 'success' | 'error'>('idle');
    const [testMessage, setTestMessage] = useState('');
    const [pendingTestOwner, setPendingTestOwner] = useState<string | null>(null);
    const isTestPending = pendingTestOwner !== null;
    const testAttempt = useRef({
        generation: 0,
        ownerId: '',
        controller: null as AbortController | null,
    });
    const testScope = useRef({ isOpen, connectionId: activeEditingConnectionId });
    testScope.current = { isOpen, connectionId: activeEditingConnectionId };
    useEffect(() => {
        setPendingTestOwner(null);
        return () => {
            testAttempt.current.generation++;
            if (testAttempt.current.ownerId) {
                cancelNetworkPrompts(testAttempt.current.ownerId);
            }
            testAttempt.current.controller?.abort();
        };
    }, [isOpen, activeEditingConnectionId]);
    const [isAppearanceOpen, setIsAppearanceOpen] = useState(false);
    const network = useHostNetworkPreference(isOpen, activeEditingConnectionId);
    const [isAdvancedOpen, setIsAdvancedOpen] = useState(false);
    const [showAllIcons, setShowAllIcons] = useState(false);
    const [isCertificateOpen, setIsCertificateOpen] = useState(false);
    const [entryMode, setEntryMode] = useState<'chooser' | 'manual'>('chooser');
    const [isImportModalOpen, setIsImportModalOpen] = useState(false);
    const [isSaving, setIsSaving] = useState(false);
    const lastImportPlaintextCountRef = useRef(0);
    const vaultNeedsMaterialize =
        authMethod === 'vault' && (vaultInputMode === 'paste' || vaultInputMode === 'import');
    const testedConnectionsRef = useRef<ReturnType<typeof connectionTestDependencies>>([]);
    const testedConnections = useMemo(() => {
        const snapshot = connectionTestDependencies(
            connections,
            formData,
            testedConnectionsRef.current,
        );
        testedConnectionsRef.current = snapshot;
        return snapshot;
    }, [connections, formData.jumpServerId, formData.agentForwardingKeyConnectionId]);
    // An opaque identity avoids serializing or retaining a second copy of any secret.
    const testInputs = useMemo(
        () => ({}),
        [
            formData,
            authMethod,
            keyInputMode,
            vaultInputMode,
            pastedKeyText,
            pastedPassphrase,
            network.value,
            testedConnections,
            entryMode,
        ],
    );
    const currentTestInputs = useRef(testInputs);
    currentTestInputs.current = testInputs;
    useEffect(() => {
        testAttempt.current.generation++;
        if (testAttempt.current.ownerId) {
            cancelNetworkPrompts(testAttempt.current.ownerId);
        }
        testAttempt.current.controller?.abort();
        setTestStatus('idle');
        setTestMessage('');
    }, [testInputs]);
    const selfCanForwardKey =
        authMethod === 'key' ||
        (authMethod === 'vault' &&
            (vaultNeedsMaterialize || formData.authRef?.itemKind === 'ssh-private-key'));
    const forwardableConnections = useMemo(
        () =>
            connections.filter(
                (connection) =>
                    connection.id !== activeEditingConnectionId &&
                    connectionHasForwardableKey(connection),
            ),
        [activeEditingConnectionId, connections],
    );
    const needsForwardingKeyPick =
        formData.agentForwardingKeyConnectionId === PICK_AGENT_FORWARDING_KEY;
    const selectedForwardingKeyAvailable =
        !formData.agentForwardingKeyConnectionId ||
        needsForwardingKeyPick ||
        (formData.agentForwardingKeyConnectionId === SELF_AGENT_FORWARDING_KEY
            ? selfCanForwardKey
            : forwardableConnections.some(
                  (connection) => connection.id === formData.agentForwardingKeyConnectionId,
              ));

    const localKeySource =
        authMethod === 'key'
            ? keyInputMode === 'file'
                ? formData.privateKeyPath
                    ? { path: formData.privateKeyPath }
                    : null
                : pastedKeyText.trim()
                  ? { content: pastedKeyText }
                  : null
            : null;
    const vaultKeySource =
        authMethod === 'vault' && vaultNeedsMaterialize && pastedKeyText.trim()
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
    const credentialHealthChecks = useMemo(
        () =>
            getCredentialHealthChecks(formData, authMethod, {
                keyInspected: localKeyInspection.status === 'valid' || localKeyInspection.encrypted,
            }),
        [formData, authMethod, localKeyInspection.status, localKeyInspection.encrypted],
    );
    const keyInspectionSaveReady =
        authMethod === 'key'
            ? canSaveInspectedPrivateKey(localKeyInspection.status, formData.password || '')
            : keyInspectionReady;
    const willStoreLocalKeyInVault = authMethod === 'key' && keyPassphraseRetention === 'vault';
    const willStorePasswordInVault = authMethod === 'password' && passwordStorage === 'vault';
    const localVaultPassphraseReady =
        !willStoreLocalKeyInVault ||
        !localKeyInspection.encrypted ||
        (Boolean(formData.password) && localKeyInspection.status === 'valid');

    useEffect(() => {
        if (!isOpen) {
            return;
        }
        setTestStatus('idle');
        setTestMessage('');
        setPasswordStorage('host');
        setIsAppearanceOpen(false);
        setIsAdvancedOpen(false);
        setIsCertificateOpen(false);
        setEntryMode(activeEditingConnectionId ? 'manual' : 'chooser');
        setShowAllIcons(false);
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
        if (!selected || needsForwardingKeyPick || selectedForwardingKeyAvailable) {
            return;
        }
        setFormData((previous) => ({
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
        if (
            authMethod !== 'key' ||
            localKeyInspection.status !== 'valid' ||
            localKeyInspection.encrypted
        ) {
            return;
        }
        if (!formData.password) {
            return;
        }
        setFormData((previous) => ({ ...previous, password: undefined }));
    }, [
        authMethod,
        formData.password,
        localKeyInspection.encrypted,
        localKeyInspection.status,
        setFormData,
    ]);

    useEffect(() => {
        if (vaultAvailable) {
            return;
        }
        if (keyPassphraseRetention === 'vault') {
            setKeyPassphraseRetention('once');
        }
        if (passwordStorage === 'vault') {
            setPasswordStorage('host');
        }
    }, [keyPassphraseRetention, passwordStorage, vaultAvailable]);

    useEffect(() => {
        if (
            !vaultNeedsMaterialize ||
            vaultKeyInspection.status !== 'valid' ||
            vaultKeyInspection.encrypted
        ) {
            return;
        }
        if (!pastedPassphrase) {
            return;
        }
        setPastedPassphrase('');
    }, [
        pastedPassphrase,
        setPastedPassphrase,
        vaultKeyInspection.encrypted,
        vaultKeyInspection.status,
        vaultNeedsMaterialize,
    ]);

    useEffect(() => {
        if (
            localKeyInspection.remembered &&
            currentKeyPath &&
            retentionDefaultedKeyPathRef.current !== currentKeyPath
        ) {
            setRememberedKeyPath(currentKeyPath);
            setKeyPassphraseRetention('device');
            retentionDefaultedKeyPathRef.current = currentKeyPath;
        } else if (localKeyInspection.status === 'valid' && !localKeyInspection.encrypted) {
            setKeyPassphraseRetention('once');
            retentionDefaultedKeyPathRef.current = null;
        }
    }, [
        currentKeyPath,
        localKeyInspection.encrypted,
        localKeyInspection.remembered,
        localKeyInspection.status,
    ]);

    const canSave =
        validation.ok &&
        (!duplicateConnection || allowDuplicateEndpoint) &&
        !keyVaultLabelConflict &&
        !(authMethod === 'vault' && vaultInputMode === 'existing' && !formData.authRef?.itemId) &&
        !(authMethod === 'vault' && vaultNeedsMaterialize && !pastedKeyText.trim()) &&
        !(authMethod === 'key' && keyInputMode === 'paste' && !pastedKeyText.trim()) &&
        keyInspectionSaveReady &&
        localVaultPassphraseReady &&
        selectedForwardingKeyAvailable &&
        !needsForwardingKeyPick;
    const canTest =
        validation.ok &&
        !isTestPending &&
        (authMethod !== 'password' || Boolean(formData.password?.trim())) &&
        !(authMethod === 'key' && keyInputMode === 'paste' && !pastedKeyText.trim()) &&
        !(authMethod === 'vault' && vaultNeedsMaterialize && !pastedKeyText.trim()) &&
        !(authMethod === 'vault' && vaultInputMode === 'existing' && !formData.authRef?.itemId) &&
        keyInspectionReady &&
        selectedForwardingKeyAvailable &&
        !needsForwardingKeyPick;
    const selectedIcon = formData.icon || 'Server';
    const compactIcons = ICONS.slice(0, 12);
    const visibleIcons = showAllIcons
        ? ICONS
        : compactIcons.includes(selectedIcon)
          ? compactIcons
          : [...compactIcons, selectedIcon];

    const needsVaultUnlock =
        authMethod === 'vault' ||
        Boolean(formData.authRef?.itemId) ||
        willStoreLocalKeyInVault ||
        willStorePasswordInVault;

    const notifyVaultBlocked = () => {
        if (isVaultInUseError(useVaultStore.getState().error)) {
            showToast('error', VAULT_IN_USE_USER_MESSAGE, 8000);
        }
    };

    const forgetCurrentDevicePassphrase = async () => {
        const keyPath = formData.privateKeyPath?.trim();
        if (!keyPath || isForgettingKeyPassphrase) {
            return;
        }
        setIsForgettingKeyPassphrase(true);
        try {
            await forgetKeyPassphraseIpc(keyPath);
            setFormData((previous) => ({ ...previous, password: undefined }));
            setKeyPassphraseRetention('once');
            setRememberedKeyPath(null);
            setKeyInspectionRevision((current) => current + 1);
            showToast('success', 'Forgot this key passphrase on this device.');
        } catch (error: unknown) {
            const message = error instanceof Error ? error.message : String(error);
            showToast('error', `Could not forget this key passphrase: ${message}`);
        } finally {
            setIsForgettingKeyPassphrase(false);
        }
    };

    /** All auth modes share one ordering: device routing first, host persistence second. */
    const persistPreparedConnection = async (connection: Connection): Promise<void> => {
        const persist = () =>
            activeEditingConnectionId ? editConnection(connection) : addConnection(connection);
        await persistHostWithNetwork(connection.id, network.value, persist);
    };

    /** Prepare credentials, then persist routing and the host through one ordered save boundary. */
    const performSave = async (retryAfterUnlock = false): Promise<Connection | null> => {
        if (!network.ready) {
            return null;
        }
        if (isSaving && !retryAfterUnlock) {
            return null;
        }
        setIsSaving(true);
        setSubmitAttempted(true);
        try {
            if (!validation.ok || !canSave) {
                return null;
            }

            if (!retryAfterUnlock && (needsVaultUnlock || vaultNeedsMaterialize)) {
                const unlocked = await requestVaultUnlock();
                if (!unlocked) {
                    notifyVaultBlocked();
                    return null;
                }
            }

            if (willStoreLocalKeyInVault) {
                const keyText =
                    keyInputMode === 'file'
                        ? await readLocalKeyFileIpc(formData.privateKeyPath || '')
                        : pastedKeyText;
                const result = await buildVaultKeyConnection({
                    keyText,
                    passphrase: formData.password || '',
                    source: keyInputMode === 'file' ? 'file' : 'paste',
                });
                if (!result) {
                    return null;
                }
                try {
                    await persistPreparedConnection(result.connection);
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
                        const message =
                            forgetError instanceof Error
                                ? forgetError.message
                                : String(forgetError);
                        showToast(
                            'error',
                            `Saved to Vault, but could not forget this key from the device: ${message}`,
                        );
                    }
                }
                try {
                    await finalizeVaultReplacement();
                    await refreshItems();
                } catch (refreshError: unknown) {
                    const message =
                        refreshError instanceof Error ? refreshError.message : String(refreshError);
                    showToast(
                        'info',
                        `Host saved to Vault, but the credential list could not refresh: ${message}`,
                    );
                }
                return result.connection;
            }

            if (willStorePasswordInVault) {
                const result = await buildVaultPasswordConnection();
                if (!result) {
                    return null;
                }
                try {
                    await persistPreparedConnection(result.connection);
                } catch (persistError: unknown) {
                    await deleteCreatedVaultItemBestEffort(result.createdItemId, persistError);
                    throw persistError;
                }
                try {
                    await finalizeVaultReplacement();
                    await refreshItems();
                } catch (refreshError: unknown) {
                    const message =
                        refreshError instanceof Error ? refreshError.message : String(refreshError);
                    showToast(
                        'info',
                        `Host saved to Vault, but the credential list could not refresh: ${message}`,
                    );
                }
                return result.connection;
            }

            if (authMethod === 'key') {
                const keyPath =
                    keyInputMode === 'paste'
                        ? await writePastedKeyAsManagedFile()
                        : formData.privateKeyPath;
                if (!keyPath) {
                    return null;
                }
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
                await persistPreparedConnection(connectionData);
                if (
                    localKeyInspection.encrypted &&
                    keyPassphraseRetention === 'device' &&
                    !keyRememberedOnDevice
                ) {
                    try {
                        await rememberKeyPassphraseIpc(keyPath, passphrase);
                    } catch (rememberError: unknown) {
                        const message =
                            rememberError instanceof Error
                                ? rememberError.message
                                : String(rememberError);
                        showToast(
                            'error',
                            `Host saved, but this key could not be remembered on this device: ${message}`,
                        );
                    }
                }
                setPastedKeyText('');
                return connectionData;
            }

            if (authMethod === 'vault' && vaultNeedsMaterialize) {
                const result = await buildVaultKeyConnection();
                if (!result) {
                    return null;
                }
                try {
                    await persistPreparedConnection(result.connection);
                } catch (persistError: unknown) {
                    await deleteCreatedVaultItemBestEffort(result.createdItemId, persistError);
                    throw persistError;
                }
                try {
                    await finalizeVaultReplacement();
                    await refreshItems();
                } catch (refreshError: unknown) {
                    const message =
                        refreshError instanceof Error ? refreshError.message : String(refreshError);
                    showToast(
                        'info',
                        `Host saved to Vault, but the credential list could not refresh: ${message}`,
                    );
                }
                return result.connection;
            }

            const saved = await saveForm(canSave, persistPreparedConnection);
            return saved;
        } catch (error: unknown) {
            const message = error instanceof Error ? error.message : String(error);
            if (!retryAfterUnlock && isVaultAccessError(message)) {
                const unlocked = await requestVaultUnlock();
                // Await so outer finally keeps isSaving true until the nested retry finishes.
                if (unlocked) {
                    return await performSave(true);
                }
            }
            showToast('error', `Could not save host: ${message}`);
            return null;
        } finally {
            setIsSaving(false);
        }
    };

    /** Close only after all host and device-preference writes succeed. */
    const handleSave = async () => {
        const saved = await performSave();
        if (!saved) {
            return;
        }
        onClose();
    };

    /** Publish a saved host before opening it; keep an ask-once passphrase in memory only. */
    const handleSaveAndConnect = async () => {
        const oneTimePassphrase =
            authMethod === 'key' &&
            localKeyInspection.encrypted &&
            keyPassphraseRetention === 'once'
                ? formData.password || ''
                : '';
        const saved = await performSave();
        if (!saved) {
            return;
        }
        if (
            oneTimePassphrase &&
            saved.privateKeyPath &&
            shouldAutoConnectOnOpenTab(connections, saved)
        ) {
            stageKeyPassphraseForNextConnect(saved.id, saved.privateKeyPath, oneTimePassphrase);
        }
        openTab(saved.id, 'terminal');
        onClose();
    };

    const testDisabledReason =
        authMethod === 'password' && !formData.password?.trim()
            ? 'Enter a password to test this connection.'
            : !keyInspectionReady
              ? 'Select a valid private key and verify its passphrase before testing.'
              : needsForwardingKeyPick
                ? 'Select the one private key this connection may forward.'
                : '';
    const saveDisabledReason = !validation.ok
        ? validation.errors[0]
        : duplicateConnection && !allowDuplicateEndpoint
          ? 'Allow the duplicate endpoint above, or change the connection details.'
          : keyVaultLabelConflict
            ? 'Choose a different Vault credential name.'
            : authMethod === 'vault' && vaultInputMode === 'existing' && !formData.authRef?.itemId
              ? 'Choose a saved credential.'
              : ((authMethod === 'key' && keyInputMode === 'paste') || vaultNeedsMaterialize) &&
                  !pastedKeyText.trim()
                ? 'Choose or paste a private key.'
                : !keyInspectionSaveReady || !localVaultPassphraseReady
                  ? 'Select a valid key and check its passphrase.'
                  : needsForwardingKeyPick || !selectedForwardingKeyAvailable
                    ? 'Choose an available key to forward.'
                    : !network.ready
                      ? 'Network preferences must finish loading before saving.'
                      : '';

    /** Test an editor snapshot without persisting credentials; stale tests cannot open pickers or update UI. */
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
            setTestMessage(
                vaultInputMode === 'import'
                    ? 'Please import a private key file first.'
                    : 'Please paste a private key first.',
            );
            return;
        }
        if (!keyInspectionReady) {
            setTestStatus('error');
            setTestMessage('Select a valid private key and verify its passphrase first.');
            return;
        }
        setTestStatus('testing');
        setTestMessage('');
        if (testAttempt.current.ownerId) {
            cancelNetworkPrompts(testAttempt.current.ownerId);
        }
        testAttempt.current.controller?.abort();
        const generation = ++testAttempt.current.generation;
        const ownerId = `connection-test:${crypto.randomUUID()}`;
        const controller = new AbortController();
        setPendingTestOwner(ownerId);
        testAttempt.current.ownerId = ownerId;
        testAttempt.current.controller = controller;
        /** Closing/reopening the form invalidates both dialogs and subsequent native work. */
        const isCurrent = () =>
            generation === testAttempt.current.generation &&
            testScope.current.isOpen &&
            testScope.current.connectionId === activeEditingConnectionId &&
            currentTestInputs.current === testInputs;
        let ephemeralTestPath: string | null = null;
        try {
            // Existing vault credential still needs unlock; paste/import test uses ephemeral file (no vault write).
            // Skip on retryAfterUnlock — requestUnlock already refreshed vault state.
            if (!retryAfterUnlock && authMethod === 'vault' && vaultInputMode === 'existing') {
                const unlocked = await requestVaultUnlock();
                if (!isCurrent()) {
                    return;
                }
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
            await prepareNetworkInterface(config, {
                preference: network.value,
                ownerId,
                cancelled: () => !isCurrent(),
            });
            if (!isCurrent()) {
                return;
            }
            await connectWithHostKeyVerification(
                config as ConnectionConfigPayload,
                (candidate) => {
                    if (!isCurrent()) {
                        throw new NetworkSelectionCancelledError();
                    }
                    return testConnectionIpc(candidate, controller.signal);
                },
                async (options) => isCurrent() && (await showConfirmDialog(options)),
            );
            if (!isCurrent()) {
                return;
            }
            setTestStatus('success');
            setTestMessage('Connection successful!');
        } catch (error: unknown) {
            if (!isCurrent()) {
                return;
            }
            const message = error instanceof Error ? error.message : String(error);
            if (!retryAfterUnlock && isVaultAccessError(message)) {
                const unlocked = await requestVaultUnlock();
                if (!isCurrent()) {
                    return;
                }
                if (unlocked) {
                    return await handleTestConnection(true);
                }
                setTestStatus('idle');
                return;
            }
            if (
                error instanceof NetworkSelectionCancelledError ||
                error instanceof SshVerificationCancelledError
            ) {
                setTestStatus('idle');
                return;
            }
            setTestStatus('error');
            setTestMessage(message.replace('Error: ', ''));
        } finally {
            setPendingTestOwner((current) => (current === ownerId ? null : current));
            if (testAttempt.current.controller === controller) {
                testAttempt.current.controller = null;
            }
            cancelNetworkPrompts(ownerId);
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
            if (!selected) {
                return;
            }
            const path = Array.isArray(selected) ? selected[0] : selected;
            if (!path) {
                return;
            }
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
            if (!selected) {
                return;
            }
            const path = Array.isArray(selected) ? selected[0] : selected;
            if (!path || typeof path !== 'string') {
                return;
            }
            await loadKeyFileForVaultImport(path);
        } catch (error: unknown) {
            const message = error instanceof Error ? error.message : String(error);
            showToast('error', `Failed to select key: ${message}`);
        }
    };

    const inferImportFormatFromPath = (path: string): ConnectionExchangeImportFormat => {
        const normalized = path.trim().toLowerCase();
        if (normalized.endsWith('.csv')) {
            return 'csv';
        }
        if (normalized.endsWith('.zync') || normalized.endsWith('.zync.json')) {
            return 'zync';
        }
        if (normalized.endsWith('.json')) {
            return 'json';
        }
        return 'auto';
    };

    const handleImportConnectionsFile = async () => {
        try {
            const selected = await open({ multiple: false, directory: false });
            if (!selected) {
                return;
            }
            const path = Array.isArray(selected) ? selected[0] : selected;
            if (!path || typeof path !== 'string') {
                return;
            }
            const imported = await importConnectionsFromFileIpc({
                path,
                format: inferImportFormatFromPath(path),
            });
            const mappedConnections: Connection[] = (imported.connections || []).map(
                (connection) => ({
                    ...connection,
                    status: 'disconnected',
                }),
            );
            importConnections(mappedConnections, imported.folders || []);
            const importedTunnels = imported.tunnels || [];
            let tunnelsSaved = 0;
            let tunnelsFailed = 0;
            for (const tunnel of importedTunnels) {
                try {
                    await saveTunnel({
                        ...tunnel,
                        status: tunnel.status === 'active' ? 'stopped' : tunnel.status || 'stopped',
                    });
                    tunnelsSaved += 1;
                } catch (tunnelError: unknown) {
                    tunnelsFailed += 1;
                    console.warn('[Import] Failed to save tunnel:', tunnel, tunnelError);
                }
            }
            const plaintextCount = mappedConnections.filter(
                (c) => !c.authRef && (c.password || c.privateKeyPath),
            ).length;
            const tunnelNote = tunnelsSaved > 0 ? ` and ${tunnelsSaved} tunnel(s)` : '';
            if (plaintextCount > 0 && vaultStatus?.status !== 'uninitialized') {
                showToast(
                    'success',
                    `Imported ${mappedConnections.length} connection(s)${tunnelNote} — ${plaintextCount} have plaintext credentials. Open Vault tab to secure them to vault.`,
                );
            } else {
                showToast(
                    'success',
                    `Imported ${mappedConnections.length} connection(s)${tunnelNote} from file.`,
                );
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

    const isChoosingEntry = !activeEditingConnectionId && entryMode === 'chooser';
    return (
        <Modal
            isOpen={isOpen}
            onClose={onClose}
            title={
                activeEditingConnectionId
                    ? 'Edit host'
                    : isChoosingEntry
                      ? 'Add connection'
                      : 'Add host'
            }
            className="w-full max-w-2xl"
            headerClassName="px-5 py-3"
            contentClassName="p-0 overflow-hidden"
            titleClassName="text-sm"
        >
            <div
                className={cn(
                    'flex min-h-0 flex-col',
                    isChoosingEntry
                        ? 'max-h-[calc(90dvh-4rem)]'
                        : 'h-[min(720px,calc(90dvh-4rem))]',
                )}
            >
                {isChoosingEntry ? (
                    <div className="min-h-0 overflow-y-auto">
                        <ConnectionTypeChooser
                            onSsh={() => setEntryMode('manual')}
                            onVnc={() => {
                                onClose();
                                openVncProfileEditor(undefined, {
                                    /** Return to the shared connection chooser after closing the editor. */
                                    onBack: () => useAppStore.getState().openConnectionModal(),
                                });
                            }}
                            onSerial={() => {
                                onClose();
                                openSerialProfileEditor(undefined, {
                                    /** Return to the shared connection chooser after closing the editor. */
                                    onBack: () => useAppStore.getState().openConnectionModal(),
                                });
                            }}
                            onImportSsh={() => setIsImportModalOpen(true)}
                            onImportFile={handleImportConnectionsFile}
                        />
                    </div>
                ) : (
                    <>
                        <div className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden p-4 space-y-4">
                            <section className="rounded-xl border border-app-border/60 bg-app-surface/25 p-4 space-y-4">
                                <h4 className="text-sm font-semibold text-app-text">Connection</h4>
                                <div className="grid grid-cols-[1fr_7rem] gap-4">
                                    <Input
                                        label="Host"
                                        placeholder="example.com or IP address"
                                        autoFocus
                                        autoCapitalize="none"
                                        spellCheck={false}
                                        value={formData.host}
                                        onBlur={() =>
                                            setTouched((prev) => ({ ...prev, host: true }))
                                        }
                                        onChange={(e) => {
                                            setFormData({ ...formData, host: e.target.value });
                                        }}
                                        error={visibleHostError}
                                    />
                                    <Input
                                        label="Port"
                                        type="number"
                                        placeholder="22"
                                        value={formData.port ?? ''}
                                        min={1}
                                        max={65535}
                                        onBlur={() =>
                                            setTouched((prev) => ({ ...prev, port: true }))
                                        }
                                        onChange={(e) => {
                                            if (e.target.value === '') {
                                                setFormData({ ...formData, port: undefined });
                                                return;
                                            }
                                            const p = parseInt(e.target.value, 10);
                                            if (!isNaN(p)) {
                                                setFormData({ ...formData, port: p });
                                            }
                                        }}
                                        error={visiblePortError}
                                    />
                                </div>
                                <Input
                                    label="Username"
                                    placeholder="Remote account username"
                                    autoCapitalize="none"
                                    spellCheck={false}
                                    value={formData.username}
                                    onBlur={() =>
                                        setTouched((prev) => ({ ...prev, username: true }))
                                    }
                                    onChange={(e) => {
                                        setFormData({ ...formData, username: e.target.value });
                                    }}
                                    error={visibleUsernameError}
                                />
                                <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 border-t border-app-border/60 pt-4">
                                    <Input
                                        label="Display name (optional)"
                                        placeholder={formData.host?.trim() || 'e.g. Production API'}
                                        value={formData.name}
                                        onChange={(e) =>
                                            setFormData({ ...formData, name: e.target.value })
                                        }
                                    />
                                    <div>
                                        <Input
                                            label="Folder (optional)"
                                            placeholder="e.g. Production"
                                            list="folder-suggestions"
                                            value={formData.folder || ''}
                                            onChange={(e) =>
                                                setFormData({ ...formData, folder: e.target.value })
                                            }
                                        />
                                        <datalist id="folder-suggestions">
                                            {folders.map((folder) => (
                                                <option
                                                    key={folder.name}
                                                    value={folder.name}
                                                />
                                            ))}
                                        </datalist>
                                    </div>
                                </div>
                            </section>

                            <section className="rounded-xl border border-app-border/60 bg-app-surface/25 p-4 space-y-4">
                                <h4 className="text-sm font-semibold text-app-text">
                                    Authentication
                                </h4>
                                <div>
                                    <div
                                        className="flex flex-wrap gap-1 p-1 bg-app-surface/50 rounded-lg w-fit border border-app-border"
                                        role="group"
                                        aria-label="Authentication source"
                                    >
                                        <button
                                            type="button"
                                            aria-pressed={authMethod === 'password'}
                                            onClick={() => setAuthMethod('password')}
                                            className={cn(
                                                'px-4 py-1.5 rounded-md text-sm font-medium transition-all',
                                                authMethod === 'password'
                                                    ? 'bg-app-accent text-white shadow-sm'
                                                    : 'text-app-muted hover:text-app-text',
                                            )}
                                        >
                                            Password
                                        </button>
                                        <button
                                            type="button"
                                            aria-pressed={authMethod === 'key'}
                                            onClick={() => setAuthMethod('key')}
                                            className={cn(
                                                'px-4 py-1.5 rounded-md text-sm font-medium transition-all',
                                                authMethod === 'key'
                                                    ? 'bg-app-accent text-white shadow-sm'
                                                    : 'text-app-muted hover:text-app-text',
                                            )}
                                        >
                                            SSH key
                                        </button>
                                        {vaultAvailable && (
                                            <button
                                                type="button"
                                                aria-pressed={authMethod === 'vault'}
                                                onClick={() => setAuthMethod('vault')}
                                                className={cn(
                                                    'px-4 py-1.5 rounded-md text-sm font-medium transition-all flex items-center gap-1.5',
                                                    authMethod === 'vault'
                                                        ? 'bg-app-accent text-white shadow-sm'
                                                        : 'text-app-muted hover:text-app-text',
                                                )}
                                            >
                                                <Shield size={13} />
                                                Saved credential
                                            </button>
                                        )}
                                    </div>
                                </div>

                                {authMethod === 'password' ? (
                                    <div className="space-y-3">
                                        <Input
                                            label="Password"
                                            type="password"
                                            autoComplete="off"
                                            value={formData.password}
                                            onChange={(e) =>
                                                setFormData({
                                                    ...formData,
                                                    password: e.target.value,
                                                })
                                            }
                                        />
                                        {vaultAvailable ? (
                                            <div className="space-y-2">
                                                <p className="text-xs text-app-muted">
                                                    Credential storage
                                                </p>
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
                                                        Host record
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
                                                        ? 'Encrypted in Vault on save.'
                                                        : 'Stored unencrypted in the local host record.'}
                                                </p>
                                                {passwordStorage === 'vault' && (
                                                    <div className="space-y-1">
                                                        <Input
                                                            label="Name in Vault"
                                                            value={keyVaultLabel}
                                                            placeholder="e.g. Production login"
                                                            error={
                                                                keyVaultLabelConflict
                                                                    ? 'A Vault item with this name already exists.'
                                                                    : undefined
                                                            }
                                                            onChange={(event) =>
                                                                setKeyVaultLabel(event.target.value)
                                                            }
                                                        />
                                                        {!keyVaultLabel.trim() && (
                                                            <p className="text-[10px] text-app-muted/60">
                                                                Leave blank to use “
                                                                {defaultPasswordVaultLabel}”.
                                                            </p>
                                                        )}
                                                    </div>
                                                )}
                                            </div>
                                        ) : null}
                                        {!vaultAvailable && formData.password ? (
                                            <p className="text-[10px] text-app-muted/70">
                                                Stored unencrypted in the local host record. Set up
                                                Vault to encrypt saved credentials.
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
                                                    'px-3 py-1 rounded-md text-xs font-medium transition-all flex items-center gap-1.5',
                                                    keyInputMode === 'file'
                                                        ? 'bg-app-accent text-white shadow-sm'
                                                        : 'text-app-muted hover:text-app-text',
                                                )}
                                            >
                                                <FileText size={11} /> File
                                            </button>
                                            <button
                                                type="button"
                                                onClick={() => setKeyInputMode('paste')}
                                                className={cn(
                                                    'px-3 py-1 rounded-md text-xs font-medium transition-all flex items-center gap-1.5',
                                                    keyInputMode === 'paste'
                                                        ? 'bg-app-accent text-white shadow-sm'
                                                        : 'text-app-muted hover:text-app-text',
                                                )}
                                            >
                                                <KeyRound size={11} /> Paste
                                            </button>
                                        </div>
                                        {keyInputMode === 'file' ? (
                                            <div className="space-y-2">
                                                <div className="flex items-end gap-2">
                                                    <Input
                                                        className="flex-1"
                                                        label="Private key file"
                                                        readOnly
                                                        title={formData.privateKeyPath}
                                                        placeholder="No key selected"
                                                        value={
                                                            formData.privateKeyPath
                                                                ? formData.privateKeyPath
                                                                      .split(/[/\\]/)
                                                                      .pop()
                                                                : ''
                                                        }
                                                        error={visibleKeyPathError}
                                                    />
                                                    <Button
                                                        variant="secondary"
                                                        onClick={handleBrowseKey}
                                                    >
                                                        Browse
                                                    </Button>
                                                </div>
                                                {formData.privateKeyPath && (
                                                    <p className="text-[10px] text-app-muted/70">
                                                        <span className="block break-all select-text">
                                                            {formData.privateKeyPath}
                                                        </span>
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
                                                        if (pastedKeyError) {
                                                            setPastedKeyError('');
                                                        }
                                                    }}
                                                />
                                                <p className="text-[10px] text-app-muted/70">
                                                    Saved as a local key file, not in Vault.
                                                </p>
                                            </div>
                                        )}
                                        <PrivateKeyInspectionFeedback
                                            inspection={localKeyInspection}
                                            allowDeferredPassphrase
                                        />
                                        {localKeyVaultError && (
                                            <p className="text-[10px] text-red-400">
                                                {localKeyVaultError}
                                            </p>
                                        )}
                                        {localKeyInspection.encrypted &&
                                            (!keyRememberedOnDevice ||
                                                keyPassphraseRetention === 'vault') && (
                                                <KeyPassphraseInput
                                                    placeholder={
                                                        keyPassphraseRetention === 'vault'
                                                            ? 'Required to save this key in Vault'
                                                            : 'Enter the passphrase'
                                                    }
                                                    value={formData.password || ''}
                                                    onChange={(password) =>
                                                        setFormData({ ...formData, password })
                                                    }
                                                />
                                            )}
                                        {localKeyInspection.encrypted &&
                                            ((formData.password || '').length > 0 ||
                                                localKeyInspection.remembered) && (
                                                <div className="space-y-2">
                                                    <KeyPassphraseRetentionOptions
                                                        value={keyPassphraseRetention}
                                                        onChange={setKeyPassphraseRetention}
                                                        vaultAvailable={vaultAvailable}
                                                        rememberedOnDevice={keyRememberedOnDevice}
                                                        isForgetting={isForgettingKeyPassphrase}
                                                        onForgetFromDevice={() => {
                                                            void forgetCurrentDevicePassphrase();
                                                        }}
                                                    />
                                                    {keyPassphraseRetention === 'vault' && (
                                                        <Input
                                                            label="Vault credential name"
                                                            value={keyVaultLabel}
                                                            placeholder={defaultKeyVaultLabel}
                                                            error={
                                                                keyVaultLabelConflict
                                                                    ? 'A Vault item with this name already exists.'
                                                                    : undefined
                                                            }
                                                            onChange={(event) =>
                                                                setKeyVaultLabel(event.target.value)
                                                            }
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
                                                    'px-3 py-1 rounded-md text-xs font-medium transition-all',
                                                    vaultInputMode === 'existing'
                                                        ? 'bg-app-accent text-white shadow-sm'
                                                        : 'text-app-muted hover:text-app-text',
                                                )}
                                            >
                                                Existing
                                            </button>
                                            <button
                                                type="button"
                                                onClick={() => setVaultInputMode('paste')}
                                                className={cn(
                                                    'px-3 py-1 rounded-md text-xs font-medium transition-all flex items-center gap-1.5',
                                                    vaultInputMode === 'paste'
                                                        ? 'bg-app-accent text-white shadow-sm'
                                                        : 'text-app-muted hover:text-app-text',
                                                )}
                                            >
                                                <KeyRound size={11} /> Paste
                                            </button>
                                            <button
                                                type="button"
                                                onClick={() => setVaultInputMode('import')}
                                                className={cn(
                                                    'px-3 py-1 rounded-md text-xs font-medium transition-all flex items-center gap-1.5',
                                                    vaultInputMode === 'import'
                                                        ? 'bg-app-accent text-white shadow-sm'
                                                        : 'text-app-muted hover:text-app-text',
                                                )}
                                            >
                                                <FileText size={11} /> Import file
                                            </button>
                                        </div>

                                        {vaultInputMode === 'existing' ? (
                                            <div className="space-y-2">
                                                {sshVaultItems.length === 0 ? (
                                                    vaultStatus?.status === 'locked' ? (
                                                        <div className="space-y-2 rounded-lg border border-app-border bg-app-bg/50 px-3 py-2.5">
                                                            <p className="text-xs text-app-muted">
                                                                Unlock the vault to choose an
                                                                existing credential.
                                                            </p>
                                                            <Button
                                                                type="button"
                                                                size="sm"
                                                                variant="secondary"
                                                                onClick={() => {
                                                                    void requestVaultUnlock();
                                                                }}
                                                            >
                                                                Unlock vault
                                                            </Button>
                                                        </div>
                                                    ) : (
                                                        <p className="text-xs text-app-muted rounded-lg border border-app-border bg-app-bg/50 px-3 py-2.5">
                                                            No items in vault yet. Use Paste or
                                                            Import file, or add credentials in the
                                                            Vault tab.
                                                        </p>
                                                    )
                                                ) : (
                                                    <Select
                                                        label="Vault credential"
                                                        value={formData.authRef?.itemId || ''}
                                                        onChange={(val) => {
                                                            const item = sshVaultItems.find(
                                                                (i) => i.id === val,
                                                            );
                                                            if (!item) {
                                                                return;
                                                            }
                                                            if (
                                                                vaultStatus?.status !== 'unlocked'
                                                            ) {
                                                                return;
                                                            }
                                                            const vaultId = vaultStatus.vaultId;
                                                            setFormData({
                                                                ...formData,
                                                                password: undefined,
                                                                privateKeyPath: undefined,
                                                                certificatePath:
                                                                    item.kind ===
                                                                    PASSWORD_CREDENTIAL_KIND
                                                                        ? undefined
                                                                        : formData.certificatePath,
                                                                authRef: {
                                                                    vaultId,
                                                                    credentialId: item.logicalId,
                                                                    itemId: item.id,
                                                                    itemKind: item.kind,
                                                                    purpose: 'ssh-auth',
                                                                },
                                                            });
                                                        }}
                                                        options={sshVaultItems.map((item) => ({
                                                            value: item.id,
                                                            label: item.label,
                                                            description:
                                                                item.kind ===
                                                                PASSWORD_CREDENTIAL_KIND
                                                                    ? 'Password'
                                                                    : 'SSH key',
                                                            icon: (
                                                                <div className="flex h-6 w-6 items-center justify-center rounded-md bg-app-surface border border-app-border text-app-muted">
                                                                    <Shield className="w-3 h-3" />
                                                                </div>
                                                            ),
                                                        }))}
                                                        placeholder="Select a vault credential…"
                                                        portal
                                                    />
                                                )}
                                            </div>
                                        ) : (
                                            <div className="space-y-2">
                                                {vaultStatus?.status === 'unlocked' && (
                                                    <div className="space-y-1.5">
                                                        <div className="flex items-center gap-2">
                                                            <label className="text-[10px] text-app-muted shrink-0">
                                                                Vault label
                                                            </label>
                                                            <input
                                                                type="text"
                                                                value={keyVaultLabel}
                                                                onChange={(e) =>
                                                                    setKeyVaultLabel(e.target.value)
                                                                }
                                                                placeholder={defaultKeyVaultLabel}
                                                                className="flex-1 rounded-md border border-app-border/60 bg-app-bg px-2 py-1 text-[11px] text-app-text placeholder:text-app-muted/40 focus:outline-none focus:ring-1 focus:ring-app-accent/50"
                                                            />
                                                        </div>
                                                        {keyVaultLabelConflict && (
                                                            <p className="text-[10px] text-amber-400/90 flex items-center gap-1">
                                                                <Shield size={10} /> A vault item
                                                                with this label already exists —
                                                                rename to avoid a duplicate.
                                                            </p>
                                                        )}
                                                    </div>
                                                )}
                                                {vaultInputMode === 'import' && (
                                                    <div className="flex gap-2">
                                                        <Button
                                                            variant="secondary"
                                                            onClick={handleBrowseVaultImportKey}
                                                        >
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
                                                            if (pastedKeyError) {
                                                                setPastedKeyError('');
                                                            }
                                                        }}
                                                    />
                                                )}
                                                {vaultInputMode === 'import' && pastedKeyError && (
                                                    <p className="text-[10px] text-red-400">
                                                        {pastedKeyError}
                                                    </p>
                                                )}
                                                <PrivateKeyInspectionFeedback
                                                    inspection={vaultKeyInspection}
                                                />
                                                {vaultKeyInspection.encrypted && (
                                                    <Input
                                                        label="Key passphrase"
                                                        type="password"
                                                        placeholder="Enter the passphrase"
                                                        value={pastedPassphrase}
                                                        onChange={(e) =>
                                                            setPastedPassphrase(e.target.value)
                                                        }
                                                    />
                                                )}
                                                {vaultStatus?.status !== 'unlocked' && (
                                                    <p className="text-[10px] text-amber-400/80 flex items-center gap-1">
                                                        <Shield size={10} /> Vault must be unlocked
                                                        to store this key.
                                                    </p>
                                                )}
                                                {vaultStatus?.status === 'unlocked' && (
                                                    <p className="text-[10px] text-emerald-400/70 flex items-center gap-1">
                                                        <Shield size={10} /> Key will be encrypted
                                                        in vault on save.
                                                    </p>
                                                )}
                                            </div>
                                        )}
                                    </div>
                                )}

                                {authMethod === 'vault' &&
                                    vaultInputMode === 'existing' &&
                                    vaultItems.find((item) => item.id === formData.authRef?.itemId)
                                        ?.hasSshCertificateField &&
                                    !formData.certificatePath && (
                                        <p className="text-xs text-app-muted">
                                            Using the SSH certificate stored with this Vault key.
                                        </p>
                                    )}
                                {authMethod !== 'password' &&
                                    !(
                                        authMethod === 'vault' &&
                                        vaultInputMode === 'existing' &&
                                        formData.authRef?.itemKind === 'ssh-password'
                                    ) && (
                                        <div className="space-y-2">
                                            {isCertificateOpen || formData.certificatePath ? (
                                                <>
                                                    <div className="flex items-end gap-2">
                                                        <Input
                                                            label="User certificate (optional)"
                                                            placeholder="OpenSSH *-cert.pub file"
                                                            value={formData.certificatePath || ''}
                                                            error={
                                                                validation.fieldErrors
                                                                    .certificatePath
                                                            }
                                                            onChange={(event) =>
                                                                setFormData((previous) => ({
                                                                    ...previous,
                                                                    certificatePath:
                                                                        event.target.value ||
                                                                        undefined,
                                                                }))
                                                            }
                                                        />
                                                        <Button
                                                            variant="secondary"
                                                            onClick={async () => {
                                                                try {
                                                                    const path = await open({
                                                                        multiple: false,
                                                                        directory: false,
                                                                        title: 'Select SSH user certificate',
                                                                    });
                                                                    if (typeof path === 'string') {
                                                                        setFormData((previous) => ({
                                                                            ...previous,
                                                                            certificatePath: path,
                                                                        }));
                                                                    }
                                                                } catch (error: unknown) {
                                                                    const message =
                                                                        error instanceof Error
                                                                            ? error.message
                                                                            : String(error);
                                                                    showToast(
                                                                        'error',
                                                                        `Failed to select certificate: ${message}`,
                                                                    );
                                                                }
                                                            }}
                                                        >
                                                            Browse
                                                        </Button>
                                                    </div>
                                                    <div className="flex items-center justify-between gap-3">
                                                        <p className="text-xs text-app-muted">
                                                            For CA-based login; must match this
                                                            private key.
                                                        </p>
                                                        <Button
                                                            type="button"
                                                            variant="ghost"
                                                            size="sm"
                                                            onClick={() => {
                                                                setFormData((previous) => ({
                                                                    ...previous,
                                                                    certificatePath: undefined,
                                                                }));
                                                                setIsCertificateOpen(false);
                                                            }}
                                                        >
                                                            Remove
                                                        </Button>
                                                    </div>
                                                    {authMethod === 'vault' && (
                                                        <p className="text-xs text-app-muted">
                                                            A selected file overrides the
                                                            certificate stored with the Vault key.
                                                        </p>
                                                    )}
                                                </>
                                            ) : (
                                                <Button
                                                    type="button"
                                                    variant="ghost"
                                                    size="sm"
                                                    onClick={() => setIsCertificateOpen(true)}
                                                >
                                                    Add certificate file
                                                </Button>
                                            )}
                                        </div>
                                    )}

                                {credentialHealthChecks.length > 0 && (
                                    <div className="rounded-md border border-app-border bg-app-bg/50 px-3 py-2 text-[11px] space-y-1">
                                        {credentialHealthChecks.map((check, index) => (
                                            <p
                                                key={`${check.message}-${index}`}
                                                className={cn(
                                                    check.severity === 'warning'
                                                        ? 'text-amber-300'
                                                        : 'text-app-muted',
                                                )}
                                            >
                                                {check.message}
                                            </p>
                                        ))}
                                    </div>
                                )}

                                {duplicateConnection && (
                                    <div
                                        className={cn(
                                            'w-full rounded-md border px-3 py-2 text-xs',
                                            allowDuplicateEndpoint
                                                ? 'border-green-500/40 bg-green-500/10 text-green-300'
                                                : 'border-amber-500/40 bg-amber-500/10 text-amber-300',
                                        )}
                                    >
                                        <p className="font-semibold mb-1">
                                            Duplicate endpoint detected
                                        </p>
                                        <p>
                                            <span className="font-medium">
                                                {duplicateConnection.name ||
                                                    duplicateConnection.host}
                                            </span>{' '}
                                            already uses {duplicateConnection.username}@
                                            {duplicateConnection.host}:{duplicateConnection.port}.
                                        </p>
                                        <label
                                            className={cn(
                                                'mt-2 flex items-center gap-2 text-[11px]',
                                                allowDuplicateEndpoint
                                                    ? 'text-green-200'
                                                    : 'text-amber-200',
                                            )}
                                        >
                                            <input
                                                type="checkbox"
                                                checked={allowDuplicateEndpoint}
                                                onChange={(event) =>
                                                    setAllowDuplicateEndpoint(event.target.checked)
                                                }
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
                                    aria-expanded={isAppearanceOpen}
                                    onClick={() => setIsAppearanceOpen((prev) => !prev)}
                                >
                                    <div>
                                        <h4 className="text-sm font-medium text-app-text">
                                            Appearance
                                        </h4>
                                        <p className="mt-1 text-xs text-app-muted">
                                            Color and icon
                                        </p>
                                    </div>
                                    {isAppearanceOpen ? (
                                        <ChevronDown
                                            size={14}
                                            className="text-app-muted"
                                        />
                                    ) : (
                                        <ChevronRight
                                            size={14}
                                            className="text-app-muted"
                                        />
                                    )}
                                </button>
                                {isAppearanceOpen && (
                                    <div className="space-y-4 px-4 pb-4">
                                        <div>
                                            <div>
                                                <label className="text-xs font-semibold text-app-muted uppercase tracking-wider block mb-2">
                                                    Color Label
                                                </label>
                                                <div className="flex gap-2">
                                                    {THEMES.map((theme) => (
                                                        <button
                                                            key={theme.id}
                                                            onClick={() =>
                                                                setFormData({
                                                                    ...formData,
                                                                    theme: theme.id,
                                                                })
                                                            }
                                                            className={cn(
                                                                'h-9 w-9 rounded-full border-2 transition-all flex items-center justify-center',
                                                                theme.color,
                                                                formData.theme === theme.id
                                                                    ? 'ring-2 ring-white scale-110'
                                                                    : 'opacity-70 hover:opacity-100 hover:scale-105',
                                                            )}
                                                            title={theme.label}
                                                            aria-label={theme.label}
                                                            aria-pressed={
                                                                formData.theme === theme.id
                                                            }
                                                        >
                                                            {formData.theme === theme.id && (
                                                                <div className="w-2.5 h-2.5 rounded-full bg-white/80" />
                                                            )}
                                                        </button>
                                                    ))}
                                                </div>
                                            </div>
                                        </div>
                                        <div>
                                            <div className="flex items-center justify-between mb-2">
                                                <label className="text-xs font-semibold text-app-muted uppercase tracking-wider block">
                                                    Icon
                                                </label>
                                                <Button
                                                    variant="ghost"
                                                    size="sm"
                                                    type="button"
                                                    className="text-app-accent"
                                                    onClick={() => setShowAllIcons((prev) => !prev)}
                                                >
                                                    {showAllIcons ? 'Show less' : 'Show more'}
                                                </Button>
                                            </div>
                                            <div className="grid grid-cols-[repeat(auto-fill,minmax(2.25rem,1fr))] gap-2">
                                                {visibleIcons.map((iconName) => (
                                                    <IconButton
                                                        key={iconName}
                                                        label={iconName}
                                                        icon={
                                                            <OSIcon
                                                                icon={iconName}
                                                                className="w-5 h-5"
                                                            />
                                                        }
                                                        size="md"
                                                        aria-pressed={
                                                            (
                                                                formData.icon || 'Server'
                                                            ).toLowerCase() ===
                                                            iconName.toLowerCase()
                                                        }
                                                        onClick={() =>
                                                            setFormData({
                                                                ...formData,
                                                                icon: iconName,
                                                            })
                                                        }
                                                        className={cn(
                                                            'w-full border',
                                                            (
                                                                formData.icon || 'Server'
                                                            ).toLowerCase() ===
                                                                iconName.toLowerCase()
                                                                ? 'bg-app-accent/20 border-app-accent text-app-accent'
                                                                : 'bg-app-bg border-app-border text-app-muted',
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
                                    aria-expanded={isAdvancedOpen}
                                    onClick={() => setIsAdvancedOpen((prev) => !prev)}
                                >
                                    <div>
                                        <h4 className="text-sm font-medium text-app-text">
                                            Advanced
                                        </h4>
                                        <p className="mt-1 text-xs text-app-muted">
                                            {[
                                                formData.jumpServerId
                                                    ? `Via ${connections.find((c) => c.id === formData.jumpServerId)?.name || 'jump host'}`
                                                    : 'Direct connection',
                                                ...(!formData.jumpServerId
                                                    ? [
                                                          network.value.mode === 'ask'
                                                              ? 'Ask for network'
                                                              : network.value.mode === 'interface'
                                                                ? 'Selected adapter'
                                                                : 'System network',
                                                      ]
                                                    : []),
                                                ...(formData.agentForwardingKeyConnectionId
                                                    ? ['Key forwarding on']
                                                    : []),
                                            ].join(' · ')}
                                        </p>
                                    </div>
                                    {isAdvancedOpen ? (
                                        <ChevronDown
                                            size={14}
                                            className="text-app-muted"
                                        />
                                    ) : (
                                        <ChevronRight
                                            size={14}
                                            className="text-app-muted"
                                        />
                                    )}
                                </button>
                                {isAdvancedOpen && (
                                    <div className="space-y-4 px-4 pb-4">
                                        <div className="space-y-2">
                                            <NetworkInterfaceControl
                                                value={network.value}
                                                onChange={network.setValue}
                                                disabled={
                                                    !network.ready || Boolean(formData.jumpServerId)
                                                }
                                            />
                                            <p className="text-[10px] text-app-muted">
                                                {formData.jumpServerId
                                                    ? 'Choose the local network interface on the first jump host.'
                                                    : 'Saved on this device only. DNS still uses system settings. Reconnect to apply changes.'}
                                            </p>
                                        </div>
                                        <div>
                                            <Select
                                                label="Jump host"
                                                value={formData.jumpServerId || ''}
                                                onChange={(val) =>
                                                    setFormData({
                                                        ...formData,
                                                        jumpServerId: val === '' ? undefined : val,
                                                    })
                                                }
                                                portal
                                                options={[
                                                    {
                                                        value: '',
                                                        label: 'None (Direct Connection)',
                                                        icon: (
                                                            <div className="flex h-6 w-6 items-center justify-center rounded-md bg-app-surface border border-app-border opacity-60">
                                                                <Laptop className="w-3.5 h-3.5" />
                                                            </div>
                                                        ),
                                                    },
                                                    ...connections
                                                        .filter(
                                                            (c) =>
                                                                c.id !== activeEditingConnectionId,
                                                        )
                                                        .map((c) => ({
                                                            value: c.id,
                                                            label: c.name || c.host,
                                                            description: `${c.username}@${c.host}`,
                                                            icon: (
                                                                <div className="flex h-6 w-6 items-center justify-center rounded-md bg-app-surface border border-app-border">
                                                                    <OSIcon
                                                                        icon={c.icon || 'Server'}
                                                                        className="w-3.5 h-3.5"
                                                                    />
                                                                </div>
                                                            ),
                                                        })),
                                                ]}
                                                placeholder="Select a Jump Server..."
                                            />
                                            <p className="text-[10px] text-app-muted/70 mt-1 pl-1">
                                                Route this connection through another SSH server.
                                            </p>
                                            {jumpCycleWarning && (
                                                <p className="text-[10px] text-amber-400/90 flex items-center gap-1 mt-1 pl-1">
                                                    <AlertCircle size={10} /> Jump chain creates a
                                                    loop — this connection will not be reachable.
                                                </p>
                                            )}
                                        </div>

                                        <div className="border-t border-app-border/70 pt-2">
                                            <Toggle
                                                label="Forward an SSH key"
                                                description="Let this host request authentication with one selected key. Every signature asks first."
                                                checked={Boolean(
                                                    formData.agentForwardingKeyConnectionId,
                                                )}
                                                disabled={
                                                    !selfCanForwardKey &&
                                                    forwardableConnections.length === 0
                                                }
                                                onChange={(enabled) =>
                                                    setFormData((previous) => ({
                                                        ...previous,
                                                        agentForwardingKeyConnectionId: enabled
                                                            ? selfCanForwardKey
                                                                ? SELF_AGENT_FORWARDING_KEY
                                                                : PICK_AGENT_FORWARDING_KEY
                                                            : undefined,
                                                    }))
                                                }
                                            />
                                            {formData.agentForwardingKeyConnectionId && (
                                                <div className="mt-2 space-y-2 px-1">
                                                    <Select
                                                        label="Key to Forward"
                                                        value={
                                                            needsForwardingKeyPick
                                                                ? ''
                                                                : formData.agentForwardingKeyConnectionId
                                                        }
                                                        onChange={(value) =>
                                                            setFormData((previous) => ({
                                                                ...previous,
                                                                agentForwardingKeyConnectionId:
                                                                    value,
                                                            }))
                                                        }
                                                        portal
                                                        options={[
                                                            ...(selfCanForwardKey
                                                                ? [
                                                                      {
                                                                          value: SELF_AGENT_FORWARDING_KEY,
                                                                          label: "This connection's authentication key",
                                                                          description:
                                                                              'Use the private key selected above.',
                                                                          icon: (
                                                                              <div className="flex h-6 w-6 items-center justify-center rounded-md border border-app-border bg-app-surface">
                                                                                  <KeyRound className="h-3.5 w-3.5" />
                                                                              </div>
                                                                          ),
                                                                      },
                                                                  ]
                                                                : []),
                                                            ...forwardableConnections.map(
                                                                (connection) => ({
                                                                    value: connection.id,
                                                                    label:
                                                                        connection.name ||
                                                                        connection.host,
                                                                    description: `${connection.username}@${connection.host}`,
                                                                    icon: (
                                                                        <div className="flex h-6 w-6 items-center justify-center rounded-md border border-app-border bg-app-surface">
                                                                            <Forward className="h-3.5 w-3.5" />
                                                                        </div>
                                                                    ),
                                                                }),
                                                            ),
                                                        ]}
                                                        placeholder="Select one private key..."
                                                    />
                                                    <p className="flex items-start gap-1.5 text-[10px] leading-relaxed text-amber-400/90">
                                                        <Shield
                                                            size={11}
                                                            className="mt-0.5 shrink-0"
                                                        />
                                                        The remote host can see this public key.
                                                        Signing still requires your approval.
                                                    </p>
                                                </div>
                                            )}
                                            {!selfCanForwardKey &&
                                                forwardableConnections.length === 0 && (
                                                    <p className="px-4 pb-2 text-[10px] leading-relaxed text-app-muted">
                                                        Save a private-key connection first, or
                                                        choose private-key authentication above.
                                                    </p>
                                                )}
                                        </div>
                                    </div>
                                )}
                            </section>
                        </div>

                        {/* Keep the footer inside the dialog's inner radius without a separate blur layer. */}
                        <div className="shrink-0 rounded-b-[calc(var(--zync-dialog-radius)-1px)] border-t border-app-border bg-app-bg">
                            {network.error && (
                                <div
                                    role="alert"
                                    className="px-4 pt-2 text-xs text-red-400"
                                >
                                    {network.error}{' '}
                                    <Button
                                        variant="ghost"
                                        size="sm"
                                        onClick={network.retry}
                                    >
                                        Retry
                                    </Button>
                                </div>
                            )}
                            {testMessage && (
                                <div className="px-4 pt-2.5 pb-0 space-y-1">
                                    <p
                                        className={cn(
                                            'text-xs',
                                            testStatus === 'success'
                                                ? 'text-green-400'
                                                : testStatus === 'error'
                                                  ? 'text-red-400'
                                                  : 'text-app-muted',
                                        )}
                                        role="status"
                                        aria-live="polite"
                                    >
                                        {testStatus === 'error'
                                            ? connectionFailureSummary(testMessage)
                                            : testMessage}
                                    </p>
                                    {testStatus === 'error' && (
                                        <details
                                            key={testMessage}
                                            className="text-xs text-app-muted"
                                        >
                                            <summary className="cursor-pointer w-fit py-1">
                                                Details
                                            </summary>
                                            <p className="max-h-24 overflow-auto whitespace-pre-wrap break-words select-text pb-2">
                                                {testMessage}
                                            </p>
                                        </details>
                                    )}
                                </div>
                            )}
                            {!testMessage && (saveDisabledReason || testDisabledReason) && (
                                <div className="px-4 pt-2.5 pb-0">
                                    <p className="text-xs text-app-muted">
                                        {saveDisabledReason || testDisabledReason}
                                    </p>
                                </div>
                            )}
                            <div className="flex flex-wrap items-center justify-between gap-3 px-4 py-2.5">
                                <Toolbar
                                    label="Connection test actions"
                                    className="gap-2"
                                >
                                    {!activeEditingConnectionId && (
                                        <Button
                                            type="button"
                                            variant="ghost"
                                            size="sm"
                                            onClick={() => setEntryMode('chooser')}
                                        >
                                            <ArrowLeft
                                                aria-hidden
                                                className="mr-1 h-3.5 w-3.5"
                                            />{' '}
                                            Back
                                        </Button>
                                    )}
                                    <Button
                                        type="button"
                                        variant="ghost"
                                        size="sm"
                                        onClick={() => {
                                            void handleTestConnection();
                                        }}
                                        disabled={!canTest || !network.ready}
                                        className={cn(
                                            'gap-2 min-w-fit',
                                            testStatus === 'success' &&
                                                'text-green-500 hover:text-green-600 hover:bg-green-500/10',
                                            testStatus === 'error' &&
                                                'text-red-500 hover:text-red-600 hover:bg-red-500/10',
                                        )}
                                    >
                                        {isTestPending ? (
                                            <Loader2 className="w-3.5 h-3.5 animate-spin" />
                                        ) : testStatus === 'success' ? (
                                            <CheckCircle2 className="w-3.5 h-3.5" />
                                        ) : testStatus === 'error' ? (
                                            <AlertCircle className="w-3.5 h-3.5" />
                                        ) : (
                                            <ShieldCheck className="w-3.5 h-3.5" />
                                        )}
                                        <span>
                                            {isTestPending ? 'Testing…' : 'Test connection'}
                                        </span>
                                    </Button>
                                </Toolbar>
                                <Toolbar
                                    label="Save connection actions"
                                    className="ml-auto gap-2"
                                >
                                    <Button
                                        type="button"
                                        variant="secondary"
                                        size="sm"
                                        disabled={!canSave || isSaving || !network.ready}
                                        isLoading={isSaving}
                                        onClick={handleSave}
                                    >
                                        Save
                                    </Button>
                                    <Button
                                        type="button"
                                        variant="primary"
                                        size="sm"
                                        disabled={!canSave || isSaving || !network.ready}
                                        onClick={handleSaveAndConnect}
                                    >
                                        Save & Connect
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
                                (c) =>
                                    !c.connection.authRef &&
                                    (c.connection.password || c.connection.privateKeyPath),
                            ).length;
                        }}
                        onImportReport={(report) => {
                            const renamedSuffix =
                                report.renamed.length > 0
                                    ? `, renamed ${report.renamed.length}`
                                    : '';
                            const conflictSuffix =
                                report.conflicted > 0 ? `, ${report.conflicted} conflicts` : '';
                            const count = lastImportPlaintextCountRef.current;
                            const migrationSuffix =
                                count > 0 && vaultStatus?.status !== 'uninitialized'
                                    ? ` — ${count} have plaintext credentials. Open Vault tab to secure them to vault.`
                                    : '.';
                            showToast(
                                'success',
                                `Imported ${report.selected}: ${report.created} new, ${report.updated} updated, ${report.skipped} skipped${conflictSuffix}${renamedSuffix}${migrationSuffix}`,
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
