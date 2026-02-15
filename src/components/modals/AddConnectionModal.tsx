import { useState, useEffect, lazy, Suspense } from 'react';
import { Modal } from '../ui/Modal';
import { Input } from '../ui/Input';
import { Button } from '../ui/Button';
import { Select } from '../ui/Select';
import { OSIcon } from '../icons/OSIcon';
import { useAppStore, Connection } from '../../store/useAppStore';
import { open } from '@tauri-apps/plugin-dialog';
import { cn } from '../../lib/utils';
import { Laptop, Key, Settings as SettingsIcon, ShieldCheck, CheckCircle2, AlertCircle, Loader2, FileText } from 'lucide-react';
import { showToast } from '../ui/Toast';

const ImportSshModal = lazy(() => import('./ImportSshModal').then(mod => ({ default: mod.ImportSshModal })));

interface AddConnectionModalProps {
    isOpen: boolean;
    onClose: () => void;
    editingConnectionId: string | null;
}

type Tab = 'general' | 'auth' | 'advanced';

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

    const [activeTab, setActiveTab] = useState<Tab>('general');
    const [testStatus, setTestStatus] = useState<'idle' | 'testing' | 'success' | 'error'>('idle');
    const [testMessage, setTestMessage] = useState('');

    const [formData, setFormData] = useState<Partial<Connection>>({
        name: '', host: '', username: '', port: 22, password: '', privateKeyPath: '', jumpServerId: undefined, icon: 'Server', folder: '', theme: '', tags: []
    });
    const [authMethod, setAuthMethod] = useState<'password' | 'key'>('password');

    // Reset form when modal opens or editing ID changes
    useEffect(() => {
        if (isOpen) {
            setTestStatus('idle');
            setTestMessage('');
            setActiveTab('general');

            if (editingConnectionId) {
                const conn = connections.find(c => c.id === editingConnectionId);
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
            } else {
                setFormData({ name: '', host: '', username: '', port: 22, password: '', privateKeyPath: '', jumpServerId: undefined, icon: 'Server', folder: '', theme: '', tags: [] });
                setAuthMethod('password');
            }
        }
    }, [isOpen, editingConnectionId, connections]);

    const [isImportModalOpen, setIsImportModalOpen] = useState(false);


    const handleSave = () => {
        if (!formData.host || !formData.username) return;

        const connectionData = {
            id: editingConnectionId || Math.random().toString(36).substr(2, 9),
            name: formData.name || formData.host,
            host: formData.host!,
            username: formData.username!,
            port: formData.port || 22,
            password: authMethod === 'password' ? formData.password : undefined,
            privateKeyPath: authMethod === 'key' ? formData.privateKeyPath : undefined,
            status: editingConnectionId ? (connections.find((c: Connection) => c.id === editingConnectionId)?.status || 'disconnected') : 'disconnected',
            jumpServerId: formData.jumpServerId,
            icon: formData.icon,
            theme: formData.theme,
            folder: formData.folder,
            tags: formData.tags || []
        } as Connection;

        if (editingConnectionId) {
            editConnection(connectionData);
        } else {
            addConnection(connectionData);
        }

        onClose();
    };

    const handleTestConnection = async () => {
        if (!formData.host || !formData.username) {
            setTestStatus('error');
            setTestMessage('Host and Username are required.');
            return;
        }

        setTestStatus('testing');
        setTestMessage('');

        try {
            // Construct the config object expected by the backend
            // NOTE: We rely on a hypothetical 'ssh_test_connection' command or similar.
            // Since we haven't implemented that yet, we'll placeholder it.
            // Ideally, we'd invoke('ssh_test_connection', { config: ... })

            // Helper to convert frontend connection to backend ConnectionConfig
            const toBackendConfig = (c: any, password?: string, keyPath?: string): any => {
                // const method = c.password ? 'password' : 'key'; // simplified detection
                // For the current form (formData), we use the explicit authMethod state
                const isForm = c === formData;

                let auth_method;
                if (isForm) {
                    if (authMethod === 'password') {
                        auth_method = { type: 'Password', password: password || '' };
                    } else {
                        auth_method = { type: 'PrivateKey', key_path: keyPath || '', passphrase: null };
                    }
                } else {
                    // For regular connections from store
                    if (c.password) {
                        auth_method = { type: 'Password', password: c.password };
                    } else {
                        auth_method = { type: 'PrivateKey', key_path: c.privateKeyPath || '', passphrase: null };
                    }
                }

                return {
                    id: c.id || 'test-temp',
                    name: c.name || 'Test Connection',
                    host: c.host,
                    port: Number(c.port) || 22,
                    username: c.username,
                    auth_method,
                    jump_host: null // Recursion handled below for the main config
                };
            };

            const jumpServerConn = formData.jumpServerId ? connections.find(c => c.id === formData.jumpServerId) : undefined;

            const config = {
                ...toBackendConfig(formData, formData.password, formData.privateKeyPath),
                jump_host: jumpServerConn ? toBackendConfig(jumpServerConn) : null
            };

            await window.ipcRenderer.invoke('ssh:test', config);

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
                filters: [{ name: 'Key Files', extensions: ['pem', 'key', 'ppk', 'pub'] }]
            });

            if (selected) {
                // Plugin dialog 'open' returns string | string[] | null.
                const path = Array.isArray(selected) ? selected[0] : selected;

                if (path) {
                    try {
                        const extractedPath = await window.ipcRenderer.invoke('ssh:extract-pem', path);
                        setFormData({ ...formData, privateKeyPath: extractedPath });
                    } catch (err) {
                        console.error('Failed to extract key', err);
                        // Fallback to original path if extraction fails
                        setFormData({ ...formData, privateKeyPath: path });
                    }
                }
            }
        } catch (e) {
            console.error('Failed to select key', e);
        }
    };

    const isValid = !!formData.host && !!formData.username;

    return (
        <Modal
            isOpen={isOpen}
            onClose={onClose}
            title={editingConnectionId ? "Edit Connection" : "New Connection"}
            className="w-full max-w-2xl" // Wider modal for tabs
        >
            <div className="flex flex-col h-[500px]">
                {/* Tabs Header */}
                <div className="flex items-center gap-1 border-b border-app-border px-1">
                    <button
                        onClick={() => setActiveTab('general')}
                        className={cn(
                            "flex items-center gap-2 px-4 py-3 text-sm font-medium border-b-2 transition-colors",
                            activeTab === 'general' ? "border-app-accent text-app-accent" : "border-transparent text-app-muted hover:text-app-text"
                        )}
                    >
                        <Laptop size={16} />
                        General
                    </button>
                    <button
                        onClick={() => setActiveTab('auth')}
                        className={cn(
                            "flex items-center gap-2 px-4 py-3 text-sm font-medium border-b-2 transition-colors",
                            activeTab === 'auth' ? "border-app-accent text-app-accent" : "border-transparent text-app-muted hover:text-app-text"
                        )}
                    >
                        <Key size={16} />
                        Authentication
                        {(!formData.username) && <span className="w-1.5 h-1.5 rounded-full bg-red-500 ml-1" title="Required" />}
                    </button>
                    <button
                        onClick={() => setActiveTab('advanced')}
                        className={cn(
                            "flex items-center gap-2 px-4 py-3 text-sm font-medium border-b-2 transition-colors",
                            activeTab === 'advanced' ? "border-app-accent text-app-accent" : "border-transparent text-app-muted hover:text-app-text"
                        )}
                    >
                        <SettingsIcon size={16} />
                        Advanced
                    </button>
                </div>

                {/* Tab Content - Scrollable */}
                <div className="flex-1 overflow-y-auto p-6">
                    {activeTab === 'general' && (
                        <div className="space-y-6 animate-in fade-in slide-in-from-left-2 duration-200">
                            <div className="grid grid-cols-2 gap-4">
                                <Input label="Name" placeholder="Production DB" value={formData.name} onChange={e => setFormData({ ...formData, name: e.target.value })} autoFocus />
                                <Input
                                    label="Host"
                                    placeholder="192.168.1.1"
                                    value={formData.host}
                                    onChange={e => setFormData({ ...formData, host: e.target.value })}
                                    className={!formData.host ? "border-red-500/50" : ""}
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
                                <label className="text-xs font-semibold text-app-muted uppercase tracking-wider block mb-2">Icon</label>
                                <div className="grid grid-cols-9 gap-2">
                                    {ICONS.map(iconName => (
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

                    {activeTab === 'auth' && (
                        <div className="space-y-6 animate-in fade-in slide-in-from-right-2 duration-200">
                            <div className="grid grid-cols-2 gap-4">
                                <Input
                                    label="Username"
                                    placeholder="root"
                                    value={formData.username}
                                    onChange={e => setFormData({ ...formData, username: e.target.value })}
                                    className={!formData.username ? "border-red-500/50" : ""}
                                />
                                <Input label="Port" type="number" placeholder="22" value={formData.port} onChange={e => setFormData({ ...formData, port: Number(e.target.value) })} />
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
                                        />
                                        <Button variant="secondary" onClick={handleBrowseKey}>Browse</Button>
                                    </div>
                                    <p className="text-[10px] text-app-muted/70">Selected key will be securely used for this connection.</p>
                                </div>
                            )}
                        </div>
                    )}

                    {activeTab === 'advanced' && (
                        <div className="space-y-6 animate-in fade-in slide-in-from-right-2 duration-200">
                            <div>
                                <Select
                                    label="Jump Server (Bastion)"
                                    value={formData.jumpServerId || ''}
                                    onChange={(val) => setFormData({ ...formData, jumpServerId: val === '' ? undefined : val })}
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
                        </div>
                    )}
                </div>

                {/* Footer Actions */}
                <div className="px-4 py-4 border-t border-app-border bg-app-bg/50 backdrop-blur-sm flex flex-col gap-3">
                    {testMessage && (
                        <div className={cn(
                            "w-full px-3 py-2 rounded-md text-xs border animate-in slide-in-from-bottom-2 fade-in",
                            testStatus === 'success' ? "bg-green-500/10 border-green-500/20 text-green-500" :
                                testStatus === 'error' ? "bg-red-500/10 border-red-500/20 text-red-500" :
                                    "bg-app-surface border-app-border text-app-muted"
                        )}>
                            <p className="font-semibold mb-0.5">
                                {testStatus === 'success' ? 'Connection Successful' :
                                    testStatus === 'error' ? 'Connection Failed' : 'Testing...'}
                            </p>
                            <p className="opacity-90 break-all">{testMessage}</p>
                        </div>
                    )}

                    <div className="flex items-center justify-between gap-4">
                        {!editingConnectionId && (
                            <Button variant="ghost" size="sm" onClick={() => setIsImportModalOpen(true)}>
                                <FileText className="w-4 h-4 mr-2" />
                                Import Config
                            </Button>
                        )}

                        <div className="flex items-center gap-2 flex-1 justify-end">
                            <Button
                                variant="ghost"
                                size="sm"
                                onClick={handleTestConnection}
                                disabled={!isValid || testStatus === 'testing'}
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
                        </div>

                        <div className="flex items-center gap-2 shrink-0">
                            <Button variant="ghost" onClick={onClose}>Cancel</Button>
                            <Button disabled={!isValid} onClick={handleSave}>
                                {editingConnectionId ? 'Save Changes' : 'Create Connection'}
                            </Button>
                        </div>
                    </div>
                </div>
            </div>


            {/* Import Modal */}
            <Suspense fallback={null}>
                {isImportModalOpen && (
                    <ImportSshModal
                        isOpen={isImportModalOpen}
                        onClose={() => setIsImportModalOpen(false)}
                        onImport={(configs) => {
                            importConnections(configs);
                            showToast(`Imported ${configs.length} connections.`, 'success');
                            onClose(); // Close parent modal too
                        }}
                    />
                )}
            </Suspense>
        </Modal >
    );
}
