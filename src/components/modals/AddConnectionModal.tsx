import { useEffect, useMemo, useState, lazy, Suspense } from 'react';
import { Modal } from '../ui/Modal';
import { Input } from '../ui/Input';
import { Button } from '../ui/Button';
import { Select } from '../ui/Select';
import { OSIcon } from '../icons/OSIcon';
import { useAppStore, Connection } from '../../store/useAppStore';
import { open } from '@tauri-apps/plugin-dialog';
import { cn } from '../../lib/utils';
import { ShieldCheck, CheckCircle2, AlertCircle, Loader2, FileText, Laptop, ChevronDown, ChevronRight } from 'lucide-react';
import { testConnectionIpc, type ConnectionConfigPayload } from '../../features/connections/infrastructure/connectionIpc';
import { buildConnectionSavePayload, buildConnectionTestPayload, getCredentialHealthChecks, validateConnectionDraft } from '../../features/connections/domain';
import { findDuplicateConnectionByEndpoint } from '../../features/connections/application/connectionService';

const ImportSshModal = lazy(() => import('./ImportSshModal').then(mod => ({ default: mod.ImportSshModal })));

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
    const connections = useAppStore(state => state.connections);
    const folders = useAppStore(state => state.folders);
    const addConnection = useAppStore(state => state.addConnection);
    const editConnection = useAppStore(state => state.editConnection);
    const importConnections = useAppStore(state => state.importConnections);
    const showToast = useAppStore(state => state.showToast);
    const openTab = useAppStore(state => state.openTab);

    const [testStatus, setTestStatus] = useState<'idle' | 'testing' | 'success' | 'error'>('idle');
    const [testMessage, setTestMessage] = useState('');
    const [isAdvancedOpen, setIsAdvancedOpen] = useState(false);
    const [showAllIcons, setShowAllIcons] = useState(false);
    const [entryMode, setEntryMode] = useState<'chooser' | 'manual'>('manual');
    const [isImportModalOpen, setIsImportModalOpen] = useState(false);
    const [submitAttempted, setSubmitAttempted] = useState(false);
    const [touched, setTouched] = useState({ host: false, username: false, port: false, keyPath: false });

    const [formData, setFormData] = useState<Partial<Connection>>({
        name: '', host: '', username: '', port: 22, password: '', privateKeyPath: '', jumpServerId: undefined, icon: 'Server', folder: '', theme: '', tags: []
    });
    const [authMethod, setAuthMethod] = useState<'password' | 'key'>('password');
    const [allowDuplicateEndpoint, setAllowDuplicateEndpoint] = useState(false);

    useEffect(() => {
        if (!isOpen) return;

        setTestStatus('idle');
        setTestMessage('');
        setAllowDuplicateEndpoint(false);
        setIsAdvancedOpen(!!editingConnectionId);
        setShowAllIcons(false);
        setEntryMode(editingConnectionId ? 'manual' : 'chooser');
        setSubmitAttempted(false);
        setTouched({ host: false, username: false, port: false, keyPath: false });

        if (editingConnectionId) {
            const conn = useAppStore.getState().connections.find(c => c.id === editingConnectionId);
            if (conn) {
                setFormData({
                    ...conn,
                    password: conn.password || '',
                    privateKeyPath: conn.privateKeyPath || '',
                    jumpServerId: conn.jumpServerId,
                    icon: conn.icon || 'Server',
                    tags: conn.tags || []
                });
                setAuthMethod(conn.privateKeyPath ? 'key' : 'password');
            }
            return;
        }

        setFormData({ name: '', host: '', username: '', port: 22, password: '', privateKeyPath: '', jumpServerId: undefined, icon: 'Server', folder: '', theme: '', tags: [] });
        setAuthMethod('password');
    }, [isOpen, editingConnectionId]);

    const validation = useMemo(
        () => validateConnectionDraft(formData, authMethod),
        [formData, authMethod]
    );
    const hostError = validation.fieldErrors.host || '';
    const usernameError = validation.fieldErrors.username || '';
    const keyPathError = validation.fieldErrors.privateKeyPath || '';
    const portError = validation.fieldErrors.port || '';
    const visibleHostError = (submitAttempted || touched.host) ? hostError : '';
    const visibleUsernameError = (submitAttempted || touched.username) ? usernameError : '';
    const visiblePortError = (submitAttempted || touched.port) ? portError : '';
    const visibleKeyPathError = (submitAttempted || touched.keyPath) ? keyPathError : '';
    const duplicateConnection = useMemo(
        () => findDuplicateConnectionByEndpoint(connections, formData, editingConnectionId),
        [connections, editingConnectionId, formData]
    );
    const credentialHealthChecks = useMemo(
        () => getCredentialHealthChecks(formData, authMethod),
        [formData, authMethod]
    );
    const canSave = validation.ok && (!duplicateConnection || allowDuplicateEndpoint);
    const selectedIcon = formData.icon || 'Server';
    const compactIcons = ICONS.slice(0, 12);
    const visibleIcons = showAllIcons
        ? ICONS
        : compactIcons.includes(selectedIcon)
            ? compactIcons
            : [...compactIcons, selectedIcon];

    const saveForm = (): Connection | null => {
        if (!canSave) return null;

        const connectionData = buildConnectionSavePayload({
            formData,
            authMethod,
            editingConnectionId,
            connections,
        }) as Connection;

        if (editingConnectionId) {
            editConnection(connectionData);
        } else {
            addConnection(connectionData);
        }

        return connectionData;
    };

    const handleSave = () => {
        setSubmitAttempted(true);
        const saved = saveForm();
        if (!saved) return;
        onClose();
    };

    const handleSaveAndConnect = () => {
        setSubmitAttempted(true);
        const saved = saveForm();
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
            const config = buildConnectionTestPayload({
                formData,
                authMethod,
                connections,
            });

            await testConnectionIpc(config as ConnectionConfigPayload);

            setTestStatus('success');
            setTestMessage('Connection successful!');
        } catch (error: any) {
            setTestStatus('error');
            setTestMessage(error.toString().replace('Error: ', ''));
        }
    };

    const handleBrowseKey = async () => {
        try {
            const selected = await open({
                multiple: false,
                directory: false,
                filters: [{ name: 'Key Files', extensions: ['pem', 'key', 'ppk'] }]
            });

            if (!selected) return;
            const path = Array.isArray(selected) ? selected[0] : selected;
            if (!path) return;

            if (!window?.ipcRenderer?.invoke) {
                setTouched((prev) => ({ ...prev, keyPath: true }));
                setFormData((prev) => ({ ...prev, privateKeyPath: path }));
                showToast('success', 'Private key path saved.');
                return;
            }

            try {
                const extractedPath = await window.ipcRenderer.invoke('ssh:extract-pem', path);
                setTouched((prev) => ({ ...prev, keyPath: true }));
                setFormData((prev) => ({ ...prev, privateKeyPath: extractedPath }));
            } catch {
                setTouched((prev) => ({ ...prev, keyPath: true }));
                setFormData((prev) => ({ ...prev, privateKeyPath: path }));
            }
        } catch (e) {
            console.error('Failed to select key', e);
        }
    };

    return (
        <Modal
            isOpen={isOpen}
            onClose={onClose}
            title={editingConnectionId ? "Edit Connection" : "New Connection"}
            subtitle={entryMode === 'manual' ? 'Basic details, authentication, then optional advanced settings.' : undefined}
            className="w-full max-w-2xl"
            headerClassName="p-2.5"
            contentClassName="p-0 overflow-hidden"
            titleClassName="text-sm"
        >
            <div className="flex flex-col h-[520px]">
                {entryMode === 'chooser' && !editingConnectionId ? (
                    <div className="flex-1 flex items-center justify-center p-8">
                        <div className="w-full max-w-lg space-y-4">
                            <h4 className="text-base font-semibold text-app-text text-center tracking-tight">Choose how to create this connection</h4>
                            <p className="text-xs text-app-muted text-center leading-relaxed">You can import existing hosts from ~/.ssh/config or add one manually.</p>
                            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                                <button
                                    type="button"
                                    onClick={() => setIsImportModalOpen(true)}
                                    className="group min-h-[136px] rounded-xl border border-[var(--color-app-border)]/60 bg-[var(--color-app-surface)]/35 p-4 text-left transition-all hover:border-[var(--color-app-accent)]/35 hover:bg-[var(--color-app-surface)]"
                                >
                                    <div className="flex h-full flex-col items-start">
                                        <div className="mb-2 inline-flex h-8 w-8 items-center justify-center rounded-lg border border-[var(--color-app-border)] bg-[var(--color-app-bg)] text-[var(--color-app-accent)]">
                                            <FileText className="w-4 h-4" />
                                        </div>
                                        <span className="text-sm font-semibold text-app-text">Import Config</span>
                                        <span className="mt-1 text-xs text-app-muted leading-relaxed">Load hosts from your SSH config file</span>
                                        <span className="mt-auto pt-3 text-[11px] font-medium text-app-accent/90">Recommended if config already exists</span>
                                    </div>
                                </button>
                                <button
                                    type="button"
                                    onClick={() => setEntryMode('manual')}
                                    className="group min-h-[136px] rounded-xl border border-[var(--color-app-border)]/60 bg-[var(--color-app-surface)]/35 p-4 text-left transition-all hover:border-[var(--color-app-accent)]/35 hover:bg-[var(--color-app-surface)]"
                                >
                                    <div className="flex h-full flex-col items-start">
                                        <div className="mb-2 inline-flex h-8 w-8 items-center justify-center rounded-lg border border-[var(--color-app-border)] bg-[var(--color-app-bg)] text-[var(--color-app-accent)]">
                                            <Laptop className="w-4 h-4" />
                                        </div>
                                        <span className="text-sm font-semibold text-app-text">Add Manually</span>
                                        <span className="mt-1 text-xs text-app-muted leading-relaxed">Enter host, auth, and optional jump settings</span>
                                        <span className="mt-auto pt-3 text-[11px] font-medium text-app-accent/90">Best for one-off quick entries</span>
                                    </div>
                                </button>
                            </div>
                        </div>
                    </div>
                ) : (
                    <>
                        <div className="flex-1 overflow-y-auto overflow-x-hidden p-4 space-y-4">
                            <section className="rounded-xl border border-app-border/60 bg-app-surface/25 p-4 space-y-4">
                                <h4 className="text-xs font-semibold uppercase tracking-wider text-app-muted">Basics</h4>
                                <div className="grid grid-cols-2 gap-4">
                                    <Input label="Name" placeholder="Production DB" value={formData.name} onChange={e => setFormData({ ...formData, name: e.target.value })} autoFocus />
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
                                </div>
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
                            </section>

                            <section className="rounded-xl border border-app-border/60 bg-app-surface/25 p-4 space-y-4">
                                <h4 className="text-xs font-semibold uppercase tracking-wider text-app-muted">Authentication</h4>
                                <div className="grid grid-cols-2 gap-4">
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
                                    <Input
                                        label="Port"
                                        type="number"
                                        placeholder="22"
                                        value={formData.port}
                                        onChange={e => {
                                            setTouched((prev) => ({ ...prev, port: true }));
                                            setFormData({ ...formData, port: Number(e.target.value) });
                                        }}
                                        error={visiblePortError}
                                    />
                                </div>
                                <div>
                                    <label className="text-xs font-semibold text-app-muted uppercase tracking-wider block mb-3">Authentication Method</label>
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
                                    </div>
                                </div>

                                {authMethod === 'password' ? (
                                    <Input label="Password" type="password" value={formData.password} onChange={e => setFormData({ ...formData, password: e.target.value })} />
                                ) : (
                                    <div className="space-y-2">
                                        <label className="text-xs font-semibold text-app-muted uppercase tracking-wider block">Private Key</label>
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
                                        <p className="text-[10px] text-app-muted/70">Selected key will be securely used for this connection.</p>
                                    </div>
                                )}

                                <div className="flex items-center justify-between gap-2">
                                <Button
                                    variant="ghost"
                                    size="sm"
                                    onClick={handleTestConnection}
                                    disabled={!validation.ok || testStatus === 'testing'}
                                    className={cn(
                                        "text-xs gap-2 min-w-fit",
                                        testStatus === 'success' && "text-green-500 hover:text-green-600 hover:bg-green-500/10",
                                            testStatus === 'error' && "text-red-500 hover:text-red-600 hover:bg-red-500/10"
                                        )}
                                    >
                                        {testStatus === 'testing' ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> :
                                            testStatus === 'success' ? <CheckCircle2 className="w-3.5 h-3.5" /> :
                                                testStatus === 'error' ? <AlertCircle className="w-3.5 h-3.5" /> :
                                                    <ShieldCheck className="w-3.5 h-3.5" />}
                                        <span>{testStatus === 'testing' ? 'Testing...' : 'Test Connection'}</span>
                                    </Button>
                                    <span className={cn(
                                        "text-xs",
                                        testStatus === 'success' ? 'text-green-400' :
                                            testStatus === 'error' ? 'text-red-400' : 'text-app-muted'
                                    )}>
                                        {testMessage}
                                    </span>
                                </div>

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
                                                ...connections.filter(c => c.id !== editingConnectionId).map(c => ({
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
                                    </div>
                                )}
                            </section>
                        </div>

                        <div className="px-4 py-2.5 border-t border-app-border bg-app-bg/90 backdrop-blur-sm flex items-center justify-between gap-3">
                            {!editingConnectionId ? (
                                <Button variant="ghost" size="sm" onClick={() => setEntryMode('chooser')}>
                                    Change Mode
                                </Button>
                            ) : <div />}
                            <div className="flex items-center gap-2">
                                <Button disabled={!canSave} onClick={handleSave}>
                                    {editingConnectionId ? 'Save Changes' : 'Create Connection'}
                                </Button>
                                <Button disabled={!canSave} onClick={handleSaveAndConnect}>
                                    {editingConnectionId ? 'Save & Open' : 'Save & Connect'}
                                </Button>
                            </div>
                        </div>
                    </>
                )}
            </div>

            <Suspense fallback={null}>
                {isImportModalOpen && (
                    <ImportSshModal
                        isOpen={isImportModalOpen}
                        onClose={() => setIsImportModalOpen(false)}
                        onImport={(configs) => {
                            importConnections(configs);
                        }}
                        onImportReport={(report) => {
                            const renamedSuffix = report.renamed.length > 0
                                ? `, renamed ${report.renamed.length}`
                                : '';
                            const conflictSuffix = report.conflicted > 0
                                ? `, ${report.conflicted} conflicts`
                                : '';
                            showToast(
                                'success',
                                `Imported ${report.selected}: ${report.created} new, ${report.updated} updated, ${report.skipped} skipped${conflictSuffix}${renamedSuffix}.`
                            );
                            onClose();
                        }}
                    />
                )}
            </Suspense>
        </Modal >
    );
}

import { registerModal } from '../../lib/modalRegistry';
registerModal('addConnection', AddConnectionModal);
