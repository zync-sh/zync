import { lazy, Suspense, useEffect, useRef, useState } from 'react';
import { Modal } from '../ui/Modal';
import { Input } from '../ui/Input';
import { Button } from '../ui/Button';
import { Select } from '../ui/Select';
import { OSIcon } from '../icons/OSIcon';
import { useAppStore, Connection } from '../../store/useAppStore';
import { open } from '@tauri-apps/plugin-dialog';
import { cn } from '../../lib/utils';
import { ShieldCheck, CheckCircle2, AlertCircle, Loader2, FileText, Laptop, Files, ChevronDown, ChevronRight, Shield, KeyRound } from 'lucide-react';
import { testConnectionIpc, type ConnectionConfigPayload } from '../../features/connections/infrastructure/connectionIpc';
import { buildConnectionTestPayload } from '../../features/connections/domain';
import {
    importConnectionsFromFileIpc,
    type ConnectionExchangeImportFormat,
} from '../../features/connections/infrastructure/connectionTransfer';
import { useConnectionForm } from './useConnectionForm';
import { useAutoVault } from './useAutoVault';

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

export function AddConnectionModal({ isOpen, onClose, editingConnectionId }: AddConnectionModalProps) {
    const importConnections = useAppStore(state => state.importConnections);
    const showToast = useAppStore(state => state.showToast);
    const openTab = useAppStore(state => state.openTab);

    const {
        connections, folders, addConnection, editConnection,
        formData, setFormData,
        authMethod, setAuthMethod,
        keyInputMode, setKeyInputMode,
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
        keyVaultLabel, setKeyVaultLabel,
        defaultKeyVaultLabel, keyVaultLabelConflict,
        buildPastedKeyConnection,
        finalizeVaultReplacement,
    } = useAutoVault({
        isOpen,
        formData,
        authMethod,
        keyInputMode,
        activeEditingConnectionId,
        validationOk: validation.ok,
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

    useEffect(() => {
        if (!isOpen) return;
        setTestStatus('idle');
        setTestMessage('');
        setIsAppearanceOpen(false);
        setIsAdvancedOpen(!!activeEditingConnectionId);
        setShowAllIcons(false);
        setEntryMode(activeEditingConnectionId ? 'manual' : 'chooser');
        setIsSaving(false);
    }, [activeEditingConnectionId, isOpen]);

    const canSave = (!duplicateConnection || allowDuplicateEndpoint) && !keyVaultLabelConflict;
    const canTest = validation.ok && testStatus !== 'testing' && !(authMethod === 'key' && keyInputMode === 'paste');
    const selectedIcon = formData.icon || 'Server';
    const compactIcons = ICONS.slice(0, 12);
    const visibleIcons = showAllIcons
        ? ICONS
        : compactIcons.includes(selectedIcon)
            ? compactIcons
            : [...compactIcons, selectedIcon];

    const performSave = async (): Promise<Connection | null> => {
        if (isSaving) return null;
        setIsSaving(true);
        setSubmitAttempted(true);
        try {
            if (authMethod === 'key' && keyInputMode === 'paste') {
                const connectionData = await buildPastedKeyConnection();
                if (!connectionData) return null;
                await (activeEditingConnectionId ? editConnection(connectionData) : addConnection(connectionData));
                await finalizeVaultReplacement();
                await refreshItems();
                return connectionData;
            }
            return await saveForm(canSave);
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
        const saved = await performSave();
        if (!saved) return;
        openTab(saved.id, 'terminal');
        onClose();
    };

    const handleTestConnection = async () => {
        setSubmitAttempted(true);
        if (!validation.ok) {
            setTestStatus('error');
            setTestMessage(validation.errors[0] || 'Please fill required fields.');
            return;
        }
        setTestStatus('testing');
        setTestMessage('');
        try {
            const config = buildConnectionTestPayload({ formData, authMethod, connections });
            await testConnectionIpc(config as ConnectionConfigPayload);
            setTestStatus('success');
            setTestMessage('Connection successful!');
        } catch (error: unknown) {
            const message = error instanceof Error ? error.message : String(error);
            setTestStatus('error');
            setTestMessage(message.replace('Error: ', ''));
        }
    };

    const handleBrowseKey = async () => {
        try {
            const selected = await open({ multiple: false, directory: false });
            if (!selected) return;
            const path = Array.isArray(selected) ? selected[0] : selected;
            if (!path) return;
            setTouched((prev) => ({ ...prev, keyPath: true }));
            setFormData((prev) => ({ ...prev, privateKeyPath: path }));
        } catch (error: unknown) {
            const message = error instanceof Error ? error.message : String(error);
            setTouched((prev) => ({ ...prev, keyPath: true }));
            setFormData((prev) => ({ ...prev, privateKeyPath: '' }));
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
            const plaintextCount = mappedConnections.filter(c => !c.authRef && (c.password || c.privateKeyPath)).length;
            if (plaintextCount > 0 && vaultStatus?.status !== 'uninitialized') {
                showToast('success', `Imported ${mappedConnections.length} connection(s) — ${plaintextCount} have plaintext credentials. Open Vault tab to secure them to vault.`);
            } else {
                showToast('success', `Imported ${mappedConnections.length} connection(s) from file.`);
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
                            <p className="text-xs text-app-muted text-center leading-relaxed">You can import existing hosts from ~/.ssh/config or add one manually.</p>
                            <div className="flex flex-col gap-2.5">
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
                                            <span className="text-sm font-semibold text-app-text">Add Manually</span>
                                            <span className="mt-0.5 text-xs text-app-muted leading-relaxed">Enter identity, auth, and optional jump settings</span>
                                            <span className="mt-2 text-[11px] font-medium text-app-accent/90">Best for one-off quick entries</span>
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
                                        {vaultStatus?.status === 'unlocked' && (
                                            <button
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
                                    <div className="space-y-2">
                                        <Input label="Password" type="password" value={formData.password} onChange={e => setFormData({ ...formData, password: e.target.value })} />
                                        {formData.password && vaultStatus?.status !== 'uninitialized' && (
                                            <p className="text-[10px] text-app-muted/70">
                                                Password is saved locally. Open Vault tab to secure it later.
                                            </p>
                                        )}
                                    </div>
                                ) : authMethod === 'key' ? (
                                    <div className="space-y-3">
                                        <div className="flex gap-1 p-0.5 bg-app-surface/50 rounded-lg w-fit border border-app-border">
                                            <button
                                                onClick={() => setKeyInputMode('file')}
                                                className={cn(
                                                    "px-3 py-1 rounded-md text-xs font-medium transition-all flex items-center gap-1.5",
                                                    keyInputMode === 'file' ? "bg-app-accent text-white shadow-sm" : "text-app-muted hover:text-app-text"
                                                )}
                                            >
                                                <FileText size={11} /> File
                                            </button>
                                            <button
                                                onClick={() => setKeyInputMode('paste')}
                                                className={cn(
                                                    "px-3 py-1 rounded-md text-xs font-medium transition-all flex items-center gap-1.5",
                                                    keyInputMode === 'paste' ? "bg-app-accent text-white shadow-sm" : "text-app-muted hover:text-app-text"
                                                )}
                                            >
                                                <KeyRound size={11} /> Paste to Vault
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
                                                <textarea
                                                    value={pastedKeyText}
                                                    className="w-full h-28 rounded-lg border border-app-border bg-app-bg px-3 py-2 text-xs font-mono text-app-text placeholder:text-app-muted/50 resize-none focus:outline-none focus:ring-1 focus:ring-app-accent/50"
                                                    placeholder="-----BEGIN OPENSSH PRIVATE KEY-----&#10;...&#10;-----END OPENSSH PRIVATE KEY-----"
                                                    onChange={(event) => {
                                                        setPastedKeyText(event.target.value);
                                                        if (pastedKeyError) setPastedKeyError('');
                                                    }}
                                                    spellCheck={false}
                                                />
                                                {pastedKeyError && (
                                                    <p className="text-[10px] text-red-400">{pastedKeyError}</p>
                                                )}
                                                <Input
                                                    label="Passphrase (if key is encrypted)"
                                                    type="password"
                                                    placeholder="Leave empty if none"
                                                    value={pastedPassphrase}
                                                    onChange={e => setPastedPassphrase(e.target.value)}
                                                />
                                                {vaultStatus?.status !== 'unlocked' && (
                                                    <p className="text-[10px] text-amber-400/80 flex items-center gap-1">
                                                        <Shield size={10} /> Vault must be unlocked to store a pasted key.
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
                                ) : (
                                    <div className="space-y-2">
                                        <label className="text-xs font-semibold text-app-muted uppercase tracking-wider block">Vault Credential</label>
                                        {vaultItems.length === 0 ? (
                                            <p className="text-xs text-app-muted rounded-lg border border-app-border bg-app-bg/50 px-3 py-2.5">
                                                No items in vault. Secure existing connections to vault to populate it.
                                            </p>
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
                                                <button
                                                    type="button"
                                                    className="text-[11px] text-app-accent hover:underline"
                                                    onClick={() => setShowAllIcons((prev) => !prev)}
                                                >
                                                    {showAllIcons ? 'Show less' : 'Show more'}
                                                </button>
                                            </div>
                                            <div className="grid grid-cols-9 gap-2">
                                                {visibleIcons.map(iconName => (
                                                    <button
                                                        key={iconName}
                                                        onClick={() => setFormData({ ...formData, icon: iconName })}
                                                        className={cn(
                                                            "p-2 rounded-lg border transition-all hover:bg-app-surface flex items-center justify-center aspect-square",
                                                            (formData.icon || 'Server').toLowerCase() === iconName.toLowerCase()
                                                                ? "bg-app-accent/20 border-app-accent text-app-accent"
                                                                : "bg-app-bg border-app-border text-app-muted"
                                                        )}
                                                        title={iconName}
                                                    >
                                                        <OSIcon icon={iconName} className="w-5 h-5" />
                                                    </button>
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
                                        <p className="mt-1 text-[11px] text-app-muted">Jump host and power-user options.</p>
                                    </div>
                                    {isAdvancedOpen ? <ChevronDown size={14} className="text-app-muted" /> : <ChevronRight size={14} className="text-app-muted" />}
                                </button>
                                {isAdvancedOpen && (
                                    <div className="px-4 pb-4">
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
                                )}
                            </section>
                        </div>

                        <div className="shrink-0 border-t border-app-border bg-app-bg/95 backdrop-blur-sm">
                            {(testMessage || (authMethod === 'key' && keyInputMode === 'paste')) && (
                                <div className="px-4 pt-2.5 pb-0 space-y-1">
                                    {testMessage && (
                                        <p className={cn(
                                            "text-xs",
                                            testStatus === 'success' ? 'text-green-400' :
                                                testStatus === 'error' ? 'text-red-400' : 'text-app-muted'
                                        )}>
                                            {testMessage}
                                        </p>
                                    )}
                                    {authMethod === 'key' && keyInputMode === 'paste' && (
                                        <p className="text-[10px] text-app-muted">Save first so the pasted key is encrypted in the vault before testing.</p>
                                    )}
                                </div>
                            )}
                            <div className="flex items-center justify-between gap-3 px-4 py-2.5">
                                <div className="flex items-center gap-2 min-w-0">
                                    {!activeEditingConnectionId && (
                                        <Button variant="ghost" size="sm" onClick={() => setEntryMode('chooser')}>
                                            Change Mode
                                        </Button>
                                    )}
                                    <Button
                                        variant="ghost"
                                        size="sm"
                                        onClick={handleTestConnection}
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
                                </div>
                                <div className="flex items-center gap-2 shrink-0">
                                    <Button
                                        variant="secondary"
                                        size="sm"
                                        disabled={!canSave || isSaving}
                                        onClick={handleSave}
                                    >
                                        {activeEditingConnectionId ? 'Save' : 'Create'}
                                    </Button>
                                    <Button
                                        variant="primary"
                                        size="sm"
                                        disabled={!canSave || isSaving}
                                        onClick={handleSaveAndConnect}
                                    >
                                        {activeEditingConnectionId ? 'Save & Open' : 'Save & Connect'}
                                    </Button>
                                </div>
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
