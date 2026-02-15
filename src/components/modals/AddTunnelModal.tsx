import { useState, useEffect } from 'react';
import { ArrowRight, Laptop, Server as ServerIcon, Plus, Trash2, Layers } from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';
import { useAppStore, type Connection, type TunnelConfig } from '../../store/useAppStore';
import { Button } from '../ui/Button';
import { Input } from '../ui/Input';
import { Modal } from '../ui/Modal';
import { Select } from '../ui/Select';
import { GroupSelector } from '../ui/GroupSelector';
import { OSIcon } from '../icons/OSIcon';
import { cn } from '../../lib/utils';

interface AddTunnelModalProps {
    isOpen: boolean;
    onClose: () => void;
    initialConnectionId?: string; // Pre-select if opened from context
    editingTunnel?: TunnelConfig | null; // Pass existing tunnel to edit
}

export function AddTunnelModal({ isOpen, onClose, initialConnectionId, editingTunnel }: AddTunnelModalProps) {
    const connections = useAppStore(state => state.connections);
    const tunnels = useAppStore(state => state.tunnels);
    const showToast = useAppStore((state) => state.showToast);

    // Derive existing groups for autocomplete
    const existingGroups = Array.from(new Set(
        Object.values(tunnels)
            .flat()
            .map(t => t.group)
            .filter((g): g is string => !!g)
    )).sort();

    // Form State
    const [mode, setMode] = useState<'single' | 'bulk'>('single');
    const [selectedConnectionId, setSelectedConnectionId] = useState('');
    const [name, setName] = useState('');
    const [group, setGroup] = useState('');
    const [type, setType] = useState<'local' | 'remote'>('local');
    const [localPort, setLocalPort] = useState('8080');
    const [remoteHost, setRemoteHost] = useState('127.0.0.1');
    const [remotePort, setRemotePort] = useState('80');
    const [bindAddress, setBindAddress] = useState('127.0.0.1');
    const [autoStart, setAutoStart] = useState(false);

    // Bulk State
    const [bulkRows, setBulkRows] = useState<Array<{ type: 'local' | 'remote', localPort: string, remoteHost: string, remotePort: string }>>([
        { type: 'local', localPort: '8080', remoteHost: '127.0.0.1', remotePort: '80' }
    ]);

    const saveTunnel = useAppStore(state => state.saveTunnel);

    // Reset/Pre-fill form on open
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
                setMode('single'); // Force single mode when editing
            } else {
                // If we have an initial connection ID, ALWAYS use it and ensure it's set
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
            const rPort = parseInt(remotePort);

            if (isNaN(lPort) || rPort < 1) {
                showToast('error', 'Ports must be valid numbers');
                return;
            }

            try {
                const config: TunnelConfig = {
                    id: editingTunnel?.id || crypto.randomUUID(),
                    connectionId: selectedConnectionId,
                    name: name || (type === 'local' ? `Local ${lPort} -> ${remoteHost}:${rPort}` : `Remote ${rPort} -> Local ${lPort}`),
                    type,
                    localPort: lPort,
                    remoteHost,
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
            // Bulk Save
            let successCount = 0;
            // Validate all first
            for (const row of bulkRows) {
                const lPort = parseInt(row.localPort);
                const rPort = parseInt(row.remotePort);
                if (isNaN(lPort) || isNaN(rPort)) {
                    showToast('error', 'All ports must be valid numbers');
                    return;
                }
            }

            // Save sequentially
            for (const row of bulkRows) {
                const lPort = parseInt(row.localPort);
                const rPort = parseInt(row.remotePort);
                try {
                    const config: TunnelConfig = {
                        id: crypto.randomUUID(),
                        connectionId: selectedConnectionId,
                        name: (row.type === 'local' ? `Local ${lPort} -> ${row.remoteHost}:${rPort}` : `Remote ${rPort} -> Local ${lPort}`),
                        type: row.type,
                        localPort: lPort,
                        remoteHost: row.remoteHost,
                        remotePort: rPort,
                        bindAddress: '127.0.0.1', // Default for bulk
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

    // Filter only valid SSH connections
    // Filter only valid SSH connections, but ALWAYS include the initial/selected one
    const hostOptions = connections
        .filter((c: Connection) => c.host || c.id === initialConnectionId || c.id === selectedConnectionId)
        .map((conn: Connection) => ({
            value: conn.id,
            label: conn.name || conn.host || 'Unknown Host',
            description: conn.host ? `${conn.username}@${conn.host}` : 'Local/Custom Connection',
            icon: (
                <div className="flex h-6 w-6 items-center justify-center rounded-md bg-app-surface border border-app-border">
                    <OSIcon icon={conn.icon || 'Server'} className="w-3.5 h-3.5" />
                </div>
            )
        }));

    return (
        <Modal
            isOpen={isOpen}
            onClose={onClose}
            title={editingTunnel ? "Update Port Forward" : "Create Port Forward"}
            className="max-w-2xl" // Wider modal
        >
            <div className="p-5 space-y-6">
                {/* Visual Flow Header (Termius-Style) */}
                {!editingTunnel && (
                    <div className="relative overflow-hidden rounded-xl bg-app-surface/20 border border-white/10 p-5 backdrop-blur-xl group">
                        {/* Background Grid with Scanlines & Noise */}
                        <div className="absolute inset-0 bg-[linear-gradient(rgba(255,255,255,0.02)_1px,transparent_1px),linear-gradient(90deg,rgba(255,255,255,0.02)_1px,transparent_1px)] bg-[size:16px_16px] [mask-image:radial-gradient(ellipse_at_center,black,transparent_80%)]" />
                        <div className="absolute inset-0 bg-[linear-gradient(to_bottom,transparent_50%,rgba(0,0,0,0.1)_50%)] bg-[size:100%_4px] opacity-10 pointer-events-none" />
                        <div className="absolute inset-0 opacity-[0.03] pointer-events-none mix-blend-overlay" style={{ backgroundImage: `url("data:image/svg+xml,%3Csvg viewBox='0 0 200 200' xmlns='http://www.w3.org/2000/svg'%3F%3E%3Cfilter id='noiseFilter'%3F%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.65' numOctaves='3' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23noiseFilter)'/%3E%3C/svg%3E")` }} />

                        <div className="relative z-10 flex items-center justify-between gap-8 h-20">
                            {/* Local Side */}
                            <button
                                onClick={() => { setType('local'); setMode('single'); }}
                                className={cn(
                                    "flex flex-col items-center gap-2 transition-all duration-300 transform w-28 group/btn",
                                    type === 'local' ? "scale-105 opacity-100" : "opacity-40 hover:opacity-70"
                                )}
                            >
                                <div className={cn(
                                    "w-12 h-12 rounded-xl flex items-center justify-center border transition-all shadow-lg relative overflow-hidden",
                                    type === 'local'
                                        ? "bg-indigo-500/20 border-indigo-500/50 shadow-indigo-500/20"
                                        : "bg-white/5 border-white/5"
                                )}>
                                    <Laptop size={20} className={cn(type === 'local' ? "text-indigo-400" : "text-app-muted")} />
                                    {type === 'local' && (
                                        <motion.div
                                            initial={{ opacity: 0 }}
                                            animate={{ opacity: 1 }}
                                            className="absolute inset-0 bg-indigo-500/10"
                                        />
                                    )}
                                </div>
                                <span className={cn(
                                    "text-[10px] font-bold uppercase tracking-wider transition-colors",
                                    type === 'local' ? "text-indigo-400" : "text-app-muted"
                                )}>Local Forward</span>
                            </button>

                            {/* Termius-Style Data Flow Animation */}
                            <div className="flex-1 relative h-12 flex items-center justify-center">
                                <svg width="100%" height="20" className="overflow-visible">
                                    <defs>
                                        <linearGradient id="flow-gradient" x1="0%" y1="0%" x2="100%" y2="0%">
                                            <stop offset="0%" stopColor="transparent" />
                                            <stop offset="20%" stopColor={type === 'local' ? '#818cf8' : '#fb923c'} stopOpacity="0.2" />
                                            <stop offset="50%" stopColor={type === 'local' ? '#818cf8' : '#fb923c'} />
                                            <stop offset="80%" stopColor={type === 'local' ? '#818cf8' : '#fb923c'} stopOpacity="0.2" />
                                            <stop offset="100%" stopColor="transparent" />
                                        </linearGradient>
                                    </defs>

                                    {/* Base Track */}
                                    <line
                                        x1="0" y1="10" x2="100%" y2="10"
                                        stroke="rgba(255,255,255,0.1)"
                                        strokeWidth="2"
                                        strokeDasharray="4 4"
                                    />

                                    {/* Animated Flow Line */}
                                    <motion.line
                                        x1="0" y1="10" x2="100%" y2="10"
                                        stroke={`url(#flow-gradient)`}
                                        strokeWidth="2"
                                        strokeDasharray="4 4"
                                        initial={{ strokeDashoffset: 0 }}
                                        animate={{
                                            strokeDashoffset: type === 'local' ? -200 : 200,
                                            opacity: [0.5, 1, 0.5]
                                        }}
                                        transition={{
                                            strokeDashoffset: { duration: 2, repeat: Infinity, ease: "linear" },
                                            opacity: { duration: 2, repeat: Infinity, ease: "easeInOut" }
                                        }}
                                    />

                                    {/* Moving Particles */}
                                    <motion.circle
                                        r="3.5"
                                        cy="10"
                                        fill={type === 'local' ? '#818cf8' : '#fb923c'}
                                        initial={{ cx: type === 'local' ? "0%" : "100%", opacity: 0 }}
                                        animate={{
                                            cx: type === 'local' ? "100%" : "0%",
                                            opacity: [0, 1, 1, 0],
                                            r: [3.5, 4.5, 3.5]
                                        }}
                                        transition={{
                                            duration: 1.5,
                                            repeat: Infinity,
                                            ease: "easeInOut",
                                            repeatDelay: 0.5
                                        }}
                                        className={type === 'local' ? "filter drop-shadow-[0_0_8px_rgba(129,140,248,0.8)]" : "filter drop-shadow-[0_0_8px_rgba(251,146,60,0.8)]"}
                                    />

                                    <motion.circle
                                        r="2.5"
                                        cy="10"
                                        fill={type === 'local' ? '#818cf8' : '#fb923c'}
                                        initial={{ cx: type === 'local' ? "0%" : "100%", opacity: 0 }}
                                        animate={{
                                            cx: type === 'local' ? "100%" : "0%",
                                            opacity: [0, 1, 1, 0],
                                            r: [2.5, 3.5, 2.5]
                                        }}
                                        transition={{
                                            duration: 1.5,
                                            repeat: Infinity,
                                            ease: "easeInOut",
                                            delay: 0.75,
                                            repeatDelay: 0.5
                                        }}
                                        className={type === 'local' ? "filter drop-shadow-[0_0_8px_rgba(129,140,248,0.8)]" : "filter drop-shadow-[0_0_8px_rgba(251,146,60,0.8)]"}
                                    />
                                </svg>

                                {/* Direction Label */}
                                <motion.div
                                    animate={{
                                        boxShadow: type === 'local'
                                            ? ["0 0 0px rgba(99,102,241,0)", "0 0 15px rgba(99,102,241,0.2)", "0 0 0px rgba(99,102,241,0)"]
                                            : ["0 0 0px rgba(251,146,60,0)", "0 0 15px rgba(251,146,60,0.2)", "0 0 0px rgba(251,146,60,0)"]
                                    }}
                                    transition={{ duration: 2, repeat: Infinity }}
                                    className={cn(
                                        "absolute -top-3 text-[9px] font-bold uppercase tracking-wider px-2 py-0.5 rounded-full border bg-black/60 backdrop-blur-sm z-20",
                                        type === 'local'
                                            ? "text-indigo-400 border-indigo-500/30"
                                            : "text-orange-400 border-orange-500/30"
                                    )}
                                >
                                    {type === 'local' ? 'Outbound' : 'Inbound'}
                                </motion.div>
                            </div>

                            {/* Remote Side */}
                            <button
                                onClick={() => { setType('remote'); setMode('single'); }}
                                className={cn(
                                    "flex flex-col items-center gap-2 transition-all duration-300 transform w-28 group/btn",
                                    type === 'remote' ? "scale-105 opacity-100" : "opacity-40 hover:opacity-70"
                                )}
                            >
                                <div className={cn(
                                    "w-12 h-12 rounded-xl flex items-center justify-center border transition-all shadow-lg relative overflow-hidden",
                                    type === 'remote'
                                        ? "bg-orange-500/20 border-orange-500/50 shadow-orange-500/20"
                                        : "bg-white/5 border-white/5"
                                )}>
                                    <ServerIcon size={20} className={cn(type === 'remote' ? "text-orange-400" : "text-app-muted")} />
                                    {type === 'remote' && (
                                        <motion.div
                                            initial={{ opacity: 0 }}
                                            animate={{ opacity: 1 }}
                                            className="absolute inset-0 bg-orange-500/10"
                                        />
                                    )}
                                </div>
                                <span className={cn(
                                    "text-[10px] font-bold uppercase tracking-wider transition-colors",
                                    type === 'remote' ? "text-orange-400" : "text-app-muted"
                                )}>Remote Forward</span>
                            </button>
                        </div>

                        {/* Explainer Text */}
                        <div className={cn(
                            "mt-3 text-center text-[11px] font-medium py-2 px-4 rounded-lg border",
                            type === 'local'
                                ? "bg-indigo-500/5 border-indigo-500/10 text-indigo-200/80"
                                : "bg-orange-500/5 border-orange-500/10 text-orange-200/80"
                        )}>
                            {type === 'local'
                                ? "Access a service running on the remote server (e.g. database) from your local machine."
                                : "Expose a local service (e.g. localhost dev server) to the remote server."}
                        </div>
                    </div>
                )}

                {/* Main Form Fields */}
                <div className="space-y-5">
                    {/* Server & Group */}
                    <div className="grid grid-cols-2 gap-5">
                        <Select
                            label="Target Server"
                            placeholder="Select server..."
                            value={selectedConnectionId}
                            onChange={setSelectedConnectionId}
                            options={hostOptions}
                            disabled={!!initialConnectionId}
                            className="bg-app-surface/20 border-white/10 focus:border-app-accent/40"
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
                                initial={{ opacity: 0, y: 10 }}
                                animate={{ opacity: 1, y: 0 }}
                                exit={{ opacity: 0, y: -10 }}
                                className="bg-app-surface/20 rounded-xl border border-white/10 p-5 space-y-5 backdrop-blur-sm"
                            >
                                <div className="flex items-center justify-between mb-2">
                                    <h3 className="text-[10px] font-bold text-app-accent uppercase tracking-[0.2em] flex items-center gap-2">
                                        <div className="w-1 h-1 rounded-full bg-app-accent" />
                                        Configuration
                                    </h3>
                                    <button
                                        onClick={() => setMode('bulk')}
                                        className="text-[10px] font-bold text-white/40 hover:text-app-accent transition-all flex items-center gap-2 uppercase tracking-wider group"
                                    >
                                        <Layers size={12} className="group-hover:rotate-12 transition-transform" />
                                        Switch to Bulk
                                    </button>
                                </div>

                                <div className="grid grid-cols-12 gap-4 items-end">
                                    {type === 'local' ? (
                                        <>
                                            <div className="col-span-3">
                                                <Input
                                                    label="Local Port"
                                                    placeholder="8080"
                                                    value={localPort}
                                                    onChange={(e) => setLocalPort(e.target.value)}
                                                    className="font-mono text-center bg-white/5 border-white/10 focus:border-indigo-500/40 focus:bg-indigo-500/5"
                                                />
                                            </div>
                                            <div className="col-span-1 flex justify-center pb-3 opacity-30 text-indigo-400">
                                                <ArrowRight size={16} />
                                            </div>
                                            <div className="col-span-8 grid grid-cols-8 gap-2">
                                                <div className="col-span-5">
                                                    <Input
                                                        label="Remote Host"
                                                        placeholder="127.0.0.1"
                                                        value={remoteHost}
                                                        onChange={(e) => setRemoteHost(e.target.value)}
                                                        className="bg-white/5 border-white/10 focus:border-indigo-500/40"
                                                    />
                                                </div>
                                                <div className="col-span-3">
                                                    <Input
                                                        label="Remote Port"
                                                        placeholder="80"
                                                        value={remotePort}
                                                        onChange={(e) => setRemotePort(e.target.value)}
                                                        className="font-mono text-center bg-white/5 border-white/10 focus:border-indigo-500/40 focus:bg-indigo-500/5"
                                                    />
                                                </div>
                                            </div>
                                        </>
                                    ) : (
                                        <>
                                            <div className="col-span-3">
                                                <Input
                                                    label="Remote Port"
                                                    placeholder="9090"
                                                    value={remotePort}
                                                    onChange={(e) => setRemotePort(e.target.value)}
                                                    className="font-mono text-center bg-white/5 border-white/10 focus:border-orange-500/40 focus:bg-orange-500/5"
                                                />
                                            </div>
                                            <div className="col-span-1 flex justify-center pb-3 opacity-30 text-orange-400">
                                                <ArrowRight size={16} />
                                            </div>
                                            <div className="col-span-8 grid grid-cols-8 gap-2">
                                                <div className="col-span-5">
                                                    <Input
                                                        label="Local Host"
                                                        placeholder="127.0.0.1"
                                                        value={remoteHost}
                                                        onChange={(e) => setRemoteHost(e.target.value)}
                                                        className="bg-white/5 border-white/10 focus:border-orange-500/40"
                                                    />
                                                </div>
                                                <div className="col-span-3">
                                                    <Input
                                                        label="Local Port"
                                                        placeholder="3000"
                                                        value={localPort}
                                                        onChange={(e) => setLocalPort(e.target.value)}
                                                        className="font-mono text-center bg-white/5 border-white/10 focus:border-orange-500/40 focus:bg-orange-500/5"
                                                    />
                                                </div>
                                            </div>
                                        </>
                                    )}
                                </div>

                                <div className="grid grid-cols-2 gap-4 pt-2">
                                    <Input
                                        label="Name (Optional)"
                                        placeholder={type === 'local' ? "e.g. Postgres DB" : "e.g. Webhook Handler"}
                                        value={name}
                                        onChange={(e) => setName(e.target.value)}
                                        className="bg-white/5 border-white/10 focus:border-white/20"
                                    />
                                    <Input
                                        label="Bind Address"
                                        placeholder={type === 'local' ? "127.0.0.1" : "0.0.0.0"}
                                        value={bindAddress}
                                        onChange={(e) => setBindAddress(e.target.value)}
                                        className="font-mono bg-white/5 border-white/10 focus:border-white/20"
                                    />
                                </div>
                            </motion.div>
                        ) : (
                            <motion.div
                                key="bulk"
                                initial={{ opacity: 0, y: 10 }}
                                animate={{ opacity: 1, y: 0 }}
                                exit={{ opacity: 0, y: -10 }}
                                className="bg-app-surface/20 rounded-xl border border-white/10 overflow-hidden backdrop-blur-sm"
                            >
                                <div className="flex items-center justify-between p-4 border-b border-white/5 bg-white/5">
                                    <h3 className="text-[10px] font-bold text-app-accent uppercase tracking-[0.2em] flex items-center gap-2">
                                        <div className="w-1 h-1 rounded-full bg-app-accent" />
                                        Bulk Configuration
                                    </h3>
                                    <button
                                        onClick={() => setMode('single')}
                                        className="text-[10px] font-bold text-white/40 hover:text-white transition-colors uppercase tracking-wider"
                                    >
                                        Cancel Bulk
                                    </button>
                                </div>

                                <div className="p-2">
                                    <div className="grid grid-cols-12 gap-2 px-4 py-2 text-[10px] font-bold text-app-muted uppercase tracking-[0.15em] opacity-60">
                                        <div className="col-span-3">Type</div>
                                        <div className="col-span-2">Local Port</div>
                                        <div className="col-span-3">Remote Host</div>
                                        <div className="col-span-3">Remote Port</div>
                                        <div className="col-span-1"></div>
                                    </div>

                                    <div className="max-h-[280px] overflow-y-auto custom-scrollbar px-1">
                                        <AnimatePresence initial={false}>
                                            {bulkRows.map((row, index) => (
                                                <motion.div
                                                    key={index}
                                                    initial={{ opacity: 0, x: -10 }}
                                                    animate={{ opacity: 1, x: 0 }}
                                                    exit={{ opacity: 0, height: 0, marginBottom: 0 }}
                                                    transition={{ delay: index * 0.05 }}
                                                    className="grid grid-cols-12 gap-2 items-center py-1.5 px-3 group relative hover:bg-white/[0.02] transition-colors rounded-lg focus-within:bg-white/[0.04]"
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
                                                            triggerClassName="h-8 text-[11px] bg-transparent border-transparent hover:border-white/10 focus:border-app-accent/30 focus:bg-white/5"
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
                                                            className="h-8 text-[11px] font-mono bg-transparent border-transparent hover:border-white/10 focus:bg-white/5 focus:border-app-accent/30 text-center"
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
                                                            className="h-8 text-[11px] bg-transparent border-transparent hover:border-white/10 focus:bg-white/5 focus:border-app-accent/30"
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
                                                            className="h-8 text-[11px] font-mono bg-transparent border-transparent hover:border-white/10 focus:bg-white/5 focus:border-app-accent/30 text-center"
                                                        />
                                                    </div>
                                                    <div className="col-span-1 flex justify-end">
                                                        <button
                                                            onClick={() => {
                                                                const newRows = bulkRows.filter((_, i) => i !== index);
                                                                setBulkRows(newRows);
                                                            }}
                                                            disabled={bulkRows.length <= 1}
                                                            className="p-1.5 text-white/20 opacity-0 group-hover:opacity-100 transition-all rounded-md hover:bg-red-500/20 hover:text-red-400 disabled:opacity-0"
                                                        >
                                                            <Trash2 size={14} />
                                                        </button>
                                                    </div>

                                                    {/* Row Divider */}
                                                    <div className="absolute bottom-0 left-4 right-4 h-px bg-white/[0.03]" />
                                                </motion.div>
                                            ))}
                                        </AnimatePresence>
                                    </div>

                                    <button
                                        onClick={() => setBulkRows([...bulkRows, { type: 'local', localPort: '', remoteHost: 'localhost', remotePort: '' }])}
                                        className="w-full py-3 flex items-center justify-center gap-2 text-[10px] font-bold uppercase tracking-[0.2em] text-app-muted hover:text-app-accent transition-all group"
                                    >
                                        <div className="w-5 h-5 rounded-full bg-white/5 flex items-center justify-center group-hover:bg-app-accent/10 transition-colors">
                                            <Plus size={12} className="group-hover:scale-110 transition-transform" />
                                        </div>
                                        Add Row
                                    </button>
                                </div>
                            </motion.div>
                        )}
                        <div className="flex items-center justify-between pt-2 px-1">
                            <label className="flex items-center gap-3 cursor-pointer group">
                                <div className="relative">
                                    <input
                                        type="checkbox"
                                        checked={autoStart}
                                        onChange={e => setAutoStart(e.target.checked)}
                                        className="peer sr-only"
                                    />
                                    <div className="w-8 h-4.5 bg-white/5 rounded-full peer peer-checked:bg-app-accent/40 transition-all border border-white/10 peer-checked:border-app-accent/50"></div>
                                    <div className="absolute left-0.75 top-0.75 w-3 h-3 bg-white/20 rounded-full transition-all peer-checked:translate-x-3.5 peer-checked:bg-white shadow-sm"></div>
                                </div>
                                <span className="text-[11px] font-medium text-app-muted group-hover:text-app-text transition-colors">Auto-start connection on save</span>
                            </label>
                        </div>
                    </AnimatePresence>
                </div>
            </div>

            {/* Footer Actions - Outside main padding for full width border */}
            <div className="p-6 border-t border-white/5 bg-white/[0.02] flex items-center justify-between">
                {/* Technical Note */}
                <div className="flex-1 pr-6">
                    <div className="flex items-center gap-1.5 mb-1 opacity-40">
                        <div className="w-1 h-1 rounded-full bg-app-accent" />
                        <span className="text-[8px] font-black uppercase tracking-widest leading-none">Zync Port Forwarding</span>
                    </div>
                    <p className="text-[9px] text-app-muted leading-relaxed opacity-50 max-w-[340px]">
                        Traffic is securely tunneled through an <span className="text-app-accent/80 font-black">Encrypted SSH Bridge</span>. No local traffic logs are stored during active port forwarding sessions.
                    </p>
                </div>

                <div className="flex items-center gap-3">
                    <button
                        onClick={onClose}
                        className="px-5 py-2 rounded-lg font-bold opacity-40 hover:opacity-100 hover:bg-white/5 transition-all text-[11px] uppercase tracking-wider"
                    >
                        Cancel
                    </button>
                    <Button
                        onClick={handleSave}
                        className={cn(
                            "group relative px-8 h-10 rounded-lg bg-gradient-to-br from-app-accent to-[#8a8cf2] shadow-md hover:shadow-app-accent/20 hover:-translate-y-0.5 active:translate-y-0 transition-all font-bold text-[11px] border-0"
                        )}
                    >
                        <div className="flex items-center gap-2 relative z-10">
                            {editingTunnel ? (
                                <span>Save Changes</span>
                            ) : (
                                <>
                                    {mode === 'bulk' ? <Layers size={14} /> : <ArrowRight size={14} className="group-hover:translate-x-0.5 transition-transform" />}
                                    <span className="uppercase tracking-wider">
                                        {mode === 'bulk' ? `Create ${bulkRows.length} Forwards` : 'Start Forwarding'}
                                    </span>
                                </>
                            )}
                        </div>
                    </Button>
                </div>
            </div>
        </Modal>
    );
}
