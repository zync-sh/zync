import { useState, useEffect } from 'react';
import { ArrowLeft, Laptop, Server as ServerIcon, Plus, Trash2 } from 'lucide-react';
import { TunnelTypeStep } from './tunnel/TunnelTypeStep';
import {
    DYNAMIC_REMOTE_HOST,
    DYNAMIC_REMOTE_PORT,
    defaultTunnelName,
    type TunnelType,
} from '../../features/tunnels/domain/tunnelTypes';
import { motion, AnimatePresence } from 'framer-motion';
import { useAppStore, type Connection, type TunnelConfig } from '../../store/useAppStore';
import { Button } from '../ui/Button';
import { Input } from '../ui/Input';
import { Modal } from '../ui/Modal';
import { Select } from '../ui/Select';
import { GroupSelector } from '../ui/GroupSelector';
import { OSIcon } from '../icons/OSIcon';
import { getConnectionDisplayLabels } from '../../features/connections/domain/connectionDisplay';
import { useShowHostAddressesInLists } from '../../features/connections/presentation/useConnectionDisplayLabels';

type WizardStep = 'type' | 'form';

const TYPE_LABELS: Record<TunnelType, string> = {
    local: 'Local',
    remote: 'Remote',
    dynamic: 'Dynamic',
};

function isValidPort(port: number): boolean {
    return Number.isFinite(port) && port >= 1 && port <= 65535;
}

interface AddTunnelModalProps {
    isOpen: boolean;
    onClose: () => void;
    initialConnectionId?: string;
    editingTunnel?: TunnelConfig | null;
}

export function AddTunnelModal({ isOpen, onClose, initialConnectionId, editingTunnel }: AddTunnelModalProps) {
    const connections = useAppStore(state => state.connections);
    const tunnels = useAppStore(state => state.tunnels);
    const showToast = useAppStore((state) => state.showToast);
    const showHostAddressesInLists = useShowHostAddressesInLists();

    const existingGroups = Array.from(new Set(
        Object.values(tunnels)
            .flat()
            .map(t => t.group)
            .filter((g): g is string => !!g)
    )).sort();

    const [step, setStep] = useState<WizardStep>('type');
    const [mode, setMode] = useState<'single' | 'bulk'>('single');
    const [selectedConnectionId, setSelectedConnectionId] = useState('');
    const [name, setName] = useState('');
    const [group, setGroup] = useState('');
    const [type, setType] = useState<TunnelType>('local');
    const [localPort, setLocalPort] = useState('8080');
    const [remoteHost, setRemoteHost] = useState('127.0.0.1');
    const [remotePort, setRemotePort] = useState('80');
    const [bindAddress, setBindAddress] = useState('127.0.0.1');
    const [autoStart, setAutoStart] = useState(false);

    const [bulkRows, setBulkRows] = useState<Array<{ type: 'local' | 'remote', localPort: string, remoteHost: string, remotePort: string }>>([
        { type: 'local', localPort: '8080', remoteHost: '127.0.0.1', remotePort: '80' }
    ]);

    const saveTunnel = useAppStore(state => state.saveTunnel);

    useEffect(() => {
        if (isOpen) {
            if (editingTunnel) {
                setSelectedConnectionId(editingTunnel.connectionId);
                setName(editingTunnel.name);
                setGroup(editingTunnel.group || '');
                setType(editingTunnel.type);
                setLocalPort(editingTunnel.localPort.toString());
                setRemoteHost(editingTunnel.remoteHost);
                setRemotePort(editingTunnel.remotePort.toString());
                setBindAddress(editingTunnel.bindAddress || '127.0.0.1');
                setAutoStart(editingTunnel.autoStart || false);
                setMode('single');
                setStep('form');
            } else {
                if (initialConnectionId) {
                    setSelectedConnectionId(initialConnectionId);
                } else {
                    setSelectedConnectionId('');
                }

                setName('');
                setGroup('');
                setType('local');
                setLocalPort('8080');
                setRemoteHost('127.0.0.1');
                setRemotePort('80');
                setBindAddress('127.0.0.1');
                setAutoStart(false);
                setMode('single');
                setStep('type');
                setBulkRows([{ type: 'local', localPort: '8080', remoteHost: '127.0.0.1', remotePort: '80' }]);
            }
        }
    }, [isOpen, initialConnectionId, editingTunnel]);

    const handleSave = async () => {
        if (!selectedConnectionId) {
            showToast('error', 'Please select a host');
            return;
        }

        if (mode === 'single') {
            const lPort = parseInt(localPort);
            const isDynamic = type === 'dynamic';

            if (!isValidPort(lPort)) {
                showToast('error', 'Local port must be between 1 and 65535');
                return;
            }

            let rPort = 0;
            let host = remoteHost;
            if (!isDynamic) {
                rPort = parseInt(remotePort);
                if (!isValidPort(rPort)) {
                    showToast('error', 'Ports must be between 1 and 65535');
                    return;
                }
            } else {
                host = DYNAMIC_REMOTE_HOST;
                rPort = DYNAMIC_REMOTE_PORT;
            }

            try {
                const config: TunnelConfig = {
                    id: editingTunnel?.id || crypto.randomUUID(),
                    connectionId: selectedConnectionId,
                    name: name || defaultTunnelName(type, lPort, host, rPort),
                    type,
                    localPort: lPort,
                    remoteHost: host,
                    remotePort: rPort,
                    bindAddress,
                    autoStart,
                    status: editingTunnel?.status || 'stopped',
                    group: group.trim() || undefined
                };

                await saveTunnel(config);
                showToast('success', editingTunnel ? 'Forward updated successfully' : 'Forward created successfully');
                onClose();
            } catch (error: any) {
                showToast('error', `Failed to save forward: ${error.message}`);
            }
        } else {
            let successCount = 0;
            for (const row of bulkRows) {
                const lPort = parseInt(row.localPort);
                const rPort = parseInt(row.remotePort);
                if (!isValidPort(lPort) || !isValidPort(rPort)) {
                    showToast('error', 'All ports must be between 1 and 65535');
                    return;
                }
            }

            for (const row of bulkRows) {
                const lPort = parseInt(row.localPort);
                const rPort = parseInt(row.remotePort);
                try {
                    const config: TunnelConfig = {
                        id: crypto.randomUUID(),
                        connectionId: selectedConnectionId,
                        name: defaultTunnelName(row.type, lPort, row.remoteHost, rPort),
                        type: row.type,
                        localPort: lPort,
                        remoteHost: row.remoteHost,
                        remotePort: rPort,
                        bindAddress: '127.0.0.1',
                        autoStart: false,
                        status: 'stopped',
                        group: group.trim() || undefined
                    };
                    await saveTunnel(config);
                    successCount++;
                } catch (error: any) {
                    console.error('Failed to save bulk tunnel', error);
                }
            }

            if (successCount > 0) {
                showToast('success', `Created ${successCount} forwards`);
                onClose();
            } else {
                showToast('error', 'Failed to create forwards');
            }
        }
    };

    const hostOptions = connections
        .filter((c: Connection) => c.host || c.id === initialConnectionId || c.id === selectedConnectionId)
        .map((conn: Connection) => {
            const labels = getConnectionDisplayLabels(conn, showHostAddressesInLists);
            return {
            value: conn.id,
            label: labels.primary || 'Unknown Host',
            description: conn.host ? labels.secondary : 'Local/Custom Connection',
            icon: (
                <div className="flex h-6 w-6 items-center justify-center rounded-md bg-app-surface border border-app-border text-app-text">
                    <OSIcon icon={conn.icon || 'Server'} className="w-3.5 h-3.5" />
                </div>
            ),
        };
        });

    const handleTypeChange = (nextType: TunnelType) => {
        setType(nextType);
        setMode('single');
    };

    const isTypeStep = step === 'type' && !editingTunnel;

    const modalTitle = editingTunnel
        ? 'Update Port Forward'
        : isTypeStep
            ? 'Select the port forwarding type'
            : 'Create Port Forward';

    const modalSubtitle = editingTunnel
        ? undefined
        : isTypeStep
            ? 'Step 1 of 2'
            : 'Step 2 of 2';

    return (
        <Modal
            isOpen={isOpen}
            onClose={onClose}
            title={
                <AnimatePresence mode="wait" initial={false}>
                    <motion.span
                        key={modalTitle}
                        initial={{ opacity: 0, y: 6 }}
                        animate={{ opacity: 1, y: 0 }}
                        exit={{ opacity: 0, y: -6 }}
                        transition={{ duration: 0.2, ease: [0.32, 0.72, 0, 1] }}
                        className="block"
                    >
                        {modalTitle}
                    </motion.span>
                </AnimatePresence>
            }
            subtitle={
                modalSubtitle ? (
                    <AnimatePresence mode="wait" initial={false}>
                        <motion.span
                            key={modalSubtitle}
                            initial={{ opacity: 0, y: 4 }}
                            animate={{ opacity: 1, y: 0 }}
                            exit={{ opacity: 0, y: -4 }}
                            transition={{ duration: 0.2, ease: [0.32, 0.72, 0, 1] }}
                            className="block"
                        >
                            {modalSubtitle}
                        </motion.span>
                    </AnimatePresence>
                ) : undefined
            }
            className={isTypeStep ? 'max-w-[400px]' : 'max-w-xl'}
            contentClassName="!p-0 flex flex-col overflow-hidden"
        >
            <motion.div layout className="overflow-hidden">
                <AnimatePresence mode="popLayout" initial={false}>
                    {isTypeStep ? (
                        <motion.div
                            key="type-step"
                            layout
                            initial={{ opacity: 0 }}
                            animate={{ opacity: 1 }}
                            exit={{ opacity: 0 }}
                            transition={{
                                opacity: { duration: 0.22, ease: 'easeInOut' },
                                layout: { duration: 0.35, ease: [0.32, 0.72, 0, 1] },
                            }}
                        >
                            <TunnelTypeStep
                                type={type}
                                onTypeChange={handleTypeChange}
                                onContinue={() => setStep('form')}
                            />
                        </motion.div>
                    ) : (
                        <motion.div
                            key="form-step"
                            layout
                            initial={{ opacity: 0 }}
                            animate={{ opacity: 1 }}
                            exit={{ opacity: 0 }}
                            transition={{
                                opacity: { duration: 0.22, ease: 'easeInOut' },
                                layout: { duration: 0.35, ease: [0.32, 0.72, 0, 1] },
                            }}
                            className="space-y-4 px-5 pb-1 pt-4"
                        >
                        {!editingTunnel && (
                            <button
                                type="button"
                                onClick={() => setStep('type')}
                                className="inline-flex items-center gap-1.5 text-xs text-app-muted transition-colors hover:text-app-text"
                            >
                                <ArrowLeft size={14} />
                                Change type
                                <span className="rounded-md bg-app-surface px-1.5 py-0.5 font-mono text-[10px] text-app-muted">
                                    {TYPE_LABELS[type]}
                                </span>
                            </button>
                        )}

                        <div className="space-y-4">
                            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                                <Select
                                    label="Target Server"
                                    placeholder="Select server..."
                                    value={selectedConnectionId}
                                    onChange={setSelectedConnectionId}
                                    options={hostOptions}
                                    disabled={!!initialConnectionId}
                                    portal={true}
                                />
                                <GroupSelector
                                    label="Group (Optional)"
                                    value={group}
                                    onChange={setGroup}
                                    existingGroups={existingGroups}
                                    placeholder="e.g. Database, Web"
                                />
                            </div>

                            <AnimatePresence mode="wait">
                                {mode === 'single' ? (
                                    <motion.div
                                        key="single"
                                        initial={{ opacity: 0 }}
                                        animate={{ opacity: 1 }}
                                        exit={{ opacity: 0 }}
                                        transition={{ duration: 0.15 }}
                                        className="space-y-4"
                                    >
                                        {type !== 'dynamic' && (
                                            <div className="flex justify-end">
                                                <button
                                                    type="button"
                                                    onClick={() => setMode('bulk')}
                                                    className="text-xs text-app-muted hover:text-app-accent transition-colors"
                                                >
                                                    Add multiple forwards
                                                </button>
                                            </div>
                                        )}

                                        <div className="space-y-4">
                                            {type === 'dynamic' ? (
                                                <div className="grid grid-cols-2 gap-4">
                                                    <Input
                                                        label="SOCKS port"
                                                        placeholder="1080"
                                                        value={localPort}
                                                        onChange={(e) => setLocalPort(e.target.value)}
                                                        className="font-mono text-center"
                                                    />
                                                    <Input
                                                        label="Bind address"
                                                        placeholder="127.0.0.1"
                                                        value={bindAddress}
                                                        onChange={(e) => setBindAddress(e.target.value)}
                                                        className="font-mono"
                                                    />
                                                </div>
                                            ) : type === 'local' ? (
                                                <div className="flex flex-wrap items-end gap-x-2 gap-y-3">
                                                    <div className="w-[88px] shrink-0">
                                                        <Input
                                                            label="Local port"
                                                            placeholder="8080"
                                                            value={localPort}
                                                            onChange={(e) => setLocalPort(e.target.value)}
                                                            className="font-mono"
                                                        />
                                                    </div>
                                                    <span className="hidden pb-2.5 text-app-muted/40 sm:inline" aria-hidden>→</span>
                                                    <div className="min-w-[120px] flex-1">
                                                        <Input
                                                            label="Remote host"
                                                            placeholder="127.0.0.1"
                                                            value={remoteHost}
                                                            onChange={(e) => setRemoteHost(e.target.value)}
                                                            className="font-mono"
                                                        />
                                                    </div>
                                                    <div className="w-[72px] shrink-0">
                                                        <Input
                                                            label="Port"
                                                            placeholder="80"
                                                            value={remotePort}
                                                            onChange={(e) => setRemotePort(e.target.value)}
                                                            className="font-mono"
                                                        />
                                                    </div>
                                                </div>
                                            ) : (
                                                <div className="flex flex-wrap items-end gap-x-2 gap-y-3">
                                                    <div className="w-[88px] shrink-0">
                                                        <Input
                                                            label="Remote port"
                                                            placeholder="9090"
                                                            value={remotePort}
                                                            onChange={(e) => setRemotePort(e.target.value)}
                                                            className="font-mono"
                                                        />
                                                    </div>
                                                    <div className="min-w-[120px] flex-1">
                                                        <Input
                                                            label="Local host"
                                                            placeholder="127.0.0.1"
                                                            value={remoteHost}
                                                            onChange={(e) => setRemoteHost(e.target.value)}
                                                            className="font-mono"
                                                        />
                                                    </div>
                                                    <span className="hidden pb-2.5 text-app-muted/40 sm:inline" aria-hidden>←</span>
                                                    <div className="w-[88px] shrink-0">
                                                        <Input
                                                            label="Local port"
                                                            placeholder="3000"
                                                            value={localPort}
                                                            onChange={(e) => setLocalPort(e.target.value)}
                                                            className="font-mono"
                                                        />
                                                    </div>
                                                </div>
                                            )}
                                        </div>

                                        {type !== 'dynamic' ? (
                                            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                                                <Input
                                                    label="Name (optional)"
                                                    placeholder={type === 'local' ? 'e.g. Postgres DB' : 'e.g. Webhook handler'}
                                                    value={name}
                                                    onChange={(e) => setName(e.target.value)}
                                                />
                                                <Input
                                                    label="Bind address"
                                                    placeholder={type === 'local' ? '127.0.0.1' : '0.0.0.0'}
                                                    value={bindAddress}
                                                    onChange={(e) => setBindAddress(e.target.value)}
                                                    className="font-mono"
                                                />
                                            </div>
                                        ) : (
                                            <Input
                                                label="Name (optional)"
                                                placeholder="e.g. Dev SOCKS proxy"
                                                value={name}
                                                onChange={(e) => setName(e.target.value)}
                                            />
                                        )}
                                    </motion.div>
                                ) : (
                                    <motion.div
                                        key="bulk"
                                        initial={{ opacity: 0 }}
                                        animate={{ opacity: 1 }}
                                        exit={{ opacity: 0 }}
                                        transition={{ duration: 0.15 }}
                                        className="space-y-3"
                                    >
                                        <div className="flex items-center justify-between">
                                            <p className="text-xs text-app-muted">Add several local or remote forwards at once.</p>
                                            <button
                                                type="button"
                                                onClick={() => setMode('single')}
                                                className="text-xs text-app-muted hover:text-app-text transition-colors"
                                            >
                                                Back to single
                                            </button>
                                        </div>

                                        <div>
                                            <div className="grid grid-cols-12 gap-2 px-1 py-1 text-[10px] font-medium text-app-muted uppercase tracking-wide">
                                                <div className="col-span-3">Type</div>
                                                <div className="col-span-2">Local Port</div>
                                                <div className="col-span-3">Remote Host</div>
                                                <div className="col-span-3">Remote Port</div>
                                                <div className="col-span-1"></div>
                                            </div>

                                            <div className="max-h-[240px] overflow-y-auto custom-scrollbar">
                                                <AnimatePresence initial={false}>
                                                    {bulkRows.map((row, index) => (
                                                        <motion.div
                                                            key={index}
                                                            initial={{ opacity: 0, x: -10 }}
                                                            animate={{ opacity: 1, x: 0 }}
                                                            exit={{ opacity: 0, height: 0, marginBottom: 0 }}
                                                            transition={{ delay: index * 0.05 }}
                                                            className="grid grid-cols-12 gap-2 items-center py-1 px-1 group"
                                                        >
                                                            <div className="col-span-3">
                                                                <Select
                                                                    value={row.type}
                                                                    onChange={(value) => {
                                                                        const newRows = [...bulkRows];
                                                                        newRows[index].type = value as 'local' | 'remote';
                                                                        setBulkRows(newRows);
                                                                    }}
                                                                    options={[
                                                                        { value: 'local', label: 'Local', icon: <Laptop size={14} /> },
                                                                        { value: 'remote', label: 'Remote', icon: <ServerIcon size={14} /> }
                                                                    ]}
                                                                    showSearch={false}
                                                                    triggerClassName="h-8 text-[11px] bg-transparent border-transparent hover:border-app-border focus:border-app-accent/30 focus:bg-app-surface/50"
                                                                    showCheck={false}
                                                                    itemClassName="text-[10px] py-1"
                                                                    portal={true}
                                                                />
                                                            </div>
                                                            <div className="col-span-2">
                                                                <Input
                                                                    value={row.localPort}
                                                                    onChange={(e) => {
                                                                        const newRows = [...bulkRows];
                                                                        newRows[index].localPort = e.target.value;
                                                                        setBulkRows(newRows);
                                                                    }}
                                                                    placeholder="8080"
                                                                    className="h-8 text-[11px] font-mono bg-transparent border-transparent hover:border-app-border focus:bg-app-surface/50 focus:border-app-accent/30 text-center"
                                                                />
                                                            </div>
                                                            <div className="col-span-3">
                                                                <Input
                                                                    value={row.remoteHost}
                                                                    onChange={(e) => {
                                                                        const newRows = [...bulkRows];
                                                                        newRows[index].remoteHost = e.target.value;
                                                                        setBulkRows(newRows);
                                                                    }}
                                                                    placeholder="localhost"
                                                                    className="h-8 text-[11px] bg-transparent border-transparent hover:border-app-border focus:bg-app-surface/50 focus:border-app-accent/30"
                                                                />
                                                            </div>
                                                            <div className="col-span-3">
                                                                <Input
                                                                    value={row.remotePort}
                                                                    onChange={(e) => {
                                                                        const newRows = [...bulkRows];
                                                                        newRows[index].remotePort = e.target.value;
                                                                        setBulkRows(newRows);
                                                                    }}
                                                                    placeholder="80"
                                                                    className="h-8 text-[11px] font-mono bg-transparent border-transparent hover:border-app-border focus:bg-app-surface/50 focus:border-app-accent/30 text-center"
                                                                />
                                                            </div>
                                                            <div className="col-span-1 flex justify-end">
                                                                <button
                                                                    type="button"
                                                                    aria-label="Remove bulk forward row"
                                                                    onClick={() => {
                                                                        const newRows = bulkRows.filter((_, i) => i !== index);
                                                                        setBulkRows(newRows);
                                                                    }}
                                                                    disabled={bulkRows.length <= 1}
                                                                    className="p-1.5 text-app-muted opacity-0 group-hover:opacity-100 transition-all rounded-md hover:bg-red-500/10 hover:text-red-400 disabled:opacity-0"
                                                                >
                                                                    <Trash2 size={14} />
                                                                </button>
                                                            </div>
                                                        </motion.div>
                                                    ))}
                                                </AnimatePresence>
                                            </div>

                                            <button
                                                type="button"
                                                onClick={() => setBulkRows([...bulkRows, { type: 'local', localPort: '', remoteHost: 'localhost', remotePort: '' }])}
                                                className="mt-2 flex w-full items-center justify-center gap-1.5 py-2 text-xs text-app-muted hover:text-app-accent transition-colors"
                                            >
                                                <Plus size={14} />
                                                Add row
                                            </button>
                                        </div>
                                    </motion.div>
                                )}
                                {mode === 'single' && (
                                    <label className="flex items-center gap-2.5 cursor-pointer text-xs text-app-muted hover:text-app-text transition-colors">
                                        <input
                                            type="checkbox"
                                            checked={autoStart}
                                            onChange={(e) => setAutoStart(e.target.checked)}
                                            className="h-3.5 w-3.5 rounded border-app-border bg-app-surface accent-[var(--color-app-accent)]"
                                        />
                                        Auto-start when connection opens
                                    </label>
                                )}
                            </AnimatePresence>
                        </div>
                        </motion.div>
                    )}
                </AnimatePresence>
            </motion.div>

            <AnimatePresence initial={false}>
                {!isTypeStep && (
                    <motion.div
                        key="form-footer"
                        layout
                        initial={{ opacity: 0 }}
                        animate={{ opacity: 1 }}
                        exit={{ opacity: 0 }}
                        transition={{ duration: 0.2, ease: 'easeInOut' }}
                        className="mt-4 flex items-center justify-end gap-2 border-t border-app-border/40 px-5 py-4"
                    >
                        <Button type="button" variant="ghost" onClick={onClose}>
                            Cancel
                        </Button>
                        <Button type="button" onClick={handleSave} className="min-w-[140px] gap-2">
                            {editingTunnel ? (
                                'Save changes'
                            ) : mode === 'bulk' ? (
                                <>Create {bulkRows.length} forwards</>
                            ) : (
                                'Save forward'
                            )}
                        </Button>
                    </motion.div>
                )}
            </AnimatePresence>
        </Modal>
    );
}

import { registerModal } from '../../lib/modalRegistry';
registerModal('addTunnel', AddTunnelModal);